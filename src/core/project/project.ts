import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { RecodeError } from '../errors/index.js';
import {
  pathExists,
  readJson,
  sha256File,
  writeJsonAtomic,
} from '../../infrastructure/filesystem/files.js';
import { sanitizeFileName } from '../../infrastructure/filesystem/paths.js';
import { BinaryMetadataSchema } from '../../input/interfaces/types.js';

export const MANIFEST_FILE = 'recode.json';

export const BinaryRecordSchema = z.object({
  id: z.string().min(1),
  fileName: z.string(),
  /** Path relative to the project root. */
  relativePath: z.string(),
  sha256: z.string().length(64),
  size: z.number().int().nonnegative(),
  origin: z.string(),
  importedAt: z.string(),
  metadata: BinaryMetadataSchema,
});
export type BinaryRecord = z.infer<typeof BinaryRecordSchema>;

export const ReferenceRecordSchema = z.object({
  relativePath: z.string(),
  origin: z.string(),
  importedAt: z.string(),
});
export type ReferenceRecord = z.infer<typeof ReferenceRecordSchema>;

export const ProjectManifestSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  binaries: z.array(BinaryRecordSchema),
  references: z.array(ReferenceRecordSchema),
  /** Project-level configuration overrides (validated when merged). */
  config: z.record(z.string(), z.unknown()).default({}),
});
export type ProjectManifest = z.infer<typeof ProjectManifestSchema>;

/** A project directory with its manifest and well-known sub directories. */
export class Project {
  private constructor(
    readonly root: string,
    private manifest: ProjectManifest,
  ) {}

  /** Creates a new project directory. Refuses to touch a non-empty directory. */
  static async create(root: string, name: string): Promise<Project> {
    const absolute = path.resolve(root);
    if (await pathExists(absolute)) {
      const entries = await fs.readdir(absolute);
      if (entries.length > 0) {
        throw new RecodeError('PROJECT', `Directory ${absolute} already exists and is not empty.`);
      }
    }
    const now = new Date().toISOString();
    const project = new Project(absolute, {
      schemaVersion: 1,
      name,
      createdAt: now,
      updatedAt: now,
      binaries: [],
      references: [],
      config: {},
    });
    for (const dir of [
      project.paths.input,
      project.paths.reference,
      project.paths.analysis,
      project.paths.source,
      project.paths.build,
      project.paths.reconstruction,
      project.paths.logs,
    ]) {
      await fs.mkdir(dir, { recursive: true });
    }
    await project.save();
    return project;
  }

  static async open(root: string): Promise<Project> {
    const absolute = path.resolve(root);
    const file = path.join(absolute, MANIFEST_FILE);
    if (!(await pathExists(file))) {
      throw new RecodeError(
        'PROJECT',
        `${absolute} is not a ReCode project (no ${MANIFEST_FILE}).`,
        {
          hint: 'Create one with "recode init <name>" or pass --project <dir>.',
        },
      );
    }
    return new Project(absolute, await readJson(file, ProjectManifestSchema));
  }

  /** Finds a project from an explicit path or by walking up from `cwd`. */
  static async resolve(explicit: string | undefined, cwd: string): Promise<Project> {
    const fromEnv = process.env['RECODE_PROJECT'];
    const start = explicit ?? fromEnv;
    if (start) return Project.open(path.resolve(cwd, start));
    let dir = path.resolve(cwd);
    for (;;) {
      if (await pathExists(path.join(dir, MANIFEST_FILE))) return Project.open(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    throw new RecodeError(
      'PROJECT',
      'No ReCode project found in the current directory or its parents.',
      {
        hint: 'Run "recode init <name>" first or use --project <dir>.',
      },
    );
  }

  get name(): string {
    return this.manifest.name;
  }
  get binaries(): readonly BinaryRecord[] {
    return this.manifest.binaries;
  }
  get references(): readonly ReferenceRecord[] {
    return this.manifest.references;
  }
  get configLayer(): Record<string, unknown> {
    return this.manifest.config;
  }

  get paths() {
    const root = this.root;
    return {
      manifest: path.join(root, MANIFEST_FILE),
      state: path.join(root, '.recode'),
      logs: path.join(root, '.recode', 'logs'),
      lock: path.join(root, '.recode', 'lock'),
      input: path.join(root, 'input'),
      reference: path.join(root, 'reference'),
      analysis: path.join(root, 'analysis'),
      source: path.join(root, 'source'),
      build: path.join(root, 'build'),
      reconstruction: path.join(root, 'reconstruction'),
    };
  }

  analysisDir(binaryId: string): string {
    return path.join(this.paths.analysis, binaryId);
  }
  sourceDir(binaryId: string): string {
    return path.join(this.paths.source, binaryId);
  }
  buildDir(binaryId: string): string {
    return path.join(this.paths.build, binaryId);
  }
  reconstructionDir(binaryId: string): string {
    return path.join(this.paths.reconstruction, binaryId);
  }
  workflowFile(binaryId: string): string {
    return path.join(this.paths.state, 'workflow', `${binaryId}.json`);
  }
  tasksFile(binaryId: string): string {
    return path.join(this.paths.state, 'tasks', `${binaryId}.json`);
  }
  absolute(relativePath: string): string {
    return path.join(this.root, relativePath);
  }

  binaryPath(record: BinaryRecord): string {
    return this.absolute(record.relativePath);
  }

  /** Picks a binary by id (or unique id prefix); defaults to the only one if there is exactly one. */
  resolveBinary(id?: string): BinaryRecord {
    const binaries = this.manifest.binaries;
    if (binaries.length === 0) {
      throw new RecodeError('PROJECT', 'The project has no imported binaries.', {
        hint: 'Run "recode import <file>" first.',
      });
    }
    if (id === undefined) {
      const only = binaries[0];
      if (binaries.length === 1 && only) return only;
      throw new RecodeError(
        'USAGE',
        'The project contains several binaries; select one with --binary <id>.',
        {
          hint: `Available: ${binaries.map((b) => b.id).join(', ')}`,
        },
      );
    }
    const matches = binaries.filter((b) => b.id === id || b.id.startsWith(id));
    const exact = binaries.find((b) => b.id === id);
    const match = exact ?? (matches.length === 1 ? matches[0] : undefined);
    if (!match) {
      throw new RecodeError('USAGE', `No unique binary matches "${id}".`, {
        hint: `Available: ${binaries.map((b) => b.id).join(', ')}`,
      });
    }
    return match;
  }

  /** Registers a prepared binary file (already located inside the project). Idempotent by hash. */
  async registerBinary(
    absolutePath: string,
    origin: string,
    metadata: BinaryRecord['metadata'],
  ): Promise<{ record: BinaryRecord; created: boolean }> {
    const sha256 = await sha256File(absolutePath);
    const existing = this.manifest.binaries.find((b) => b.sha256 === sha256);
    if (existing) return { record: existing, created: false };
    const stat = await fs.stat(absolutePath);
    const stem = sanitizeFileName(
      path.basename(absolutePath, path.extname(absolutePath)),
      'binary',
    );
    const record: BinaryRecord = {
      id: `${stem}-${sha256.slice(0, 8)}`,
      fileName: path.basename(absolutePath),
      relativePath: path.relative(this.root, absolutePath).split(path.sep).join('/'),
      sha256,
      size: stat.size,
      origin,
      importedAt: new Date().toISOString(),
      metadata,
    };
    this.manifest = { ...this.manifest, binaries: [...this.manifest.binaries, record] };
    await this.save();
    return { record, created: true };
  }

  async registerReference(absolutePath: string, origin: string): Promise<void> {
    const relativePath = path.relative(this.root, absolutePath).split(path.sep).join('/');
    const record: ReferenceRecord = { relativePath, origin, importedAt: new Date().toISOString() };
    this.manifest = { ...this.manifest, references: [...this.manifest.references, record] };
    await this.save();
  }

  async updateConfigLayer(layer: Record<string, unknown>): Promise<void> {
    this.manifest = { ...this.manifest, config: layer };
    await this.save();
  }

  private async save(): Promise<void> {
    this.manifest = { ...this.manifest, updatedAt: new Date().toISOString() };
    await writeJsonAtomic(this.paths.manifest, this.manifest);
  }

  /**
   * Runs `fn` while holding the project lock. A lock whose process no longer exists is taken over,
   * which makes crashed runs resumable.
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await fs.mkdir(this.paths.state, { recursive: true });
    await this.acquireLock();
    try {
      return await fn();
    } finally {
      await fs.rm(this.paths.lock, { force: true });
    }
  }

  private async acquireLock(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await fs.writeFile(this.paths.lock, String(process.pid), { flag: 'wx' });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const holder = Number.parseInt(
        await fs.readFile(this.paths.lock, 'utf8').catch(() => ''),
        10,
      );
      if (Number.isInteger(holder) && holder !== process.pid && isProcessAlive(holder)) {
        throw new RecodeError(
          'PROJECT',
          `Project is in use by another ReCode process (pid ${holder}).`,
        );
      }
      await fs.rm(this.paths.lock, { force: true });
    }
    throw new RecodeError('PROJECT', 'Cannot acquire the project lock.');
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
