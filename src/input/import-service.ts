import fs from 'node:fs/promises';
import path from 'node:path';
import { RecodeError } from '../core/errors/index.js';
import type { BinaryRecord, Project } from '../core/project/project.js';
import type { AdapterRegistry } from './adapters/registry.js';
import { RAW_OPTION_HELP } from './adapters/raw-adapter.js';
import type { DetectionResult, MetadataHints, PreparedBinary } from './interfaces/types.js';

export interface ImportOptions {
  hints?: MetadataHints;
  /** Treat the file as headerless raw binary regardless of detection. */
  forceRaw?: boolean;
}

export interface ImportReport {
  detection: DetectionResult;
  binaries: Array<{ record: BinaryRecord; created: boolean }>;
  references: string[];
}

/** Imports files, archives and reference material into a project. */
export class ImportService {
  constructor(
    private readonly project: Project,
    private readonly registry: AdapterRegistry,
  ) {}

  detect(filePath: string): Promise<DetectionResult> {
    return this.registry.detect(filePath);
  }

  async import(filePath: string, options: ImportOptions = {}): Promise<ImportReport> {
    const absolute = path.resolve(filePath);
    const stat = await fs.stat(absolute).catch(() => undefined);
    if (!stat) throw new RecodeError('INVALID_INPUT', `File not found: ${absolute}`);
    if (!stat.isFile()) {
      throw new RecodeError('INVALID_INPUT', `${absolute} is not a regular file.`, {
        hint: 'Import files one by one, or pack a directory into a ZIP archive.',
      });
    }

    const detection: DetectionResult = options.forceRaw
      ? {
          adapterId: 'raw',
          kind: 'binary',
          format: 'raw',
          confidence: 1,
          description: 'Headerless binary (requested with --raw)',
        }
      : await this.registry.detect(absolute);

    if (detection.kind === 'reference') {
      const stored = await this.registry.reference.store(absolute, this.project.paths.reference);
      await this.project.registerReference(stored, absolute);
      return { detection, binaries: [], references: [stored] };
    }

    if (detection.kind === 'unknown') {
      throw new RecodeError(
        'INVALID_INPUT',
        `Unrecognized file format: ${path.basename(absolute)}.`,
        {
          hint: `If this is a headerless binary, re-run with --raw. ${RAW_OPTION_HELP}`,
        },
      );
    }

    const adapter = this.registry.get(detection.adapterId);
    if (!adapter)
      throw new RecodeError('INTERNAL', `Adapter ${detection.adapterId} is not registered.`);
    const prepared = await adapter.prepare(absolute, this.project.paths.input, options.hints);
    if (prepared.length === 0) {
      throw new RecodeError('INVALID_INPUT', 'The file did not contain any analyzable binaries.');
    }
    const binaries = await this.register(prepared, absolute);
    return { detection, binaries, references: [] };
  }

  private async register(
    prepared: PreparedBinary[],
    original: string,
  ): Promise<ImportReport['binaries']> {
    const results: ImportReport['binaries'] = [];
    for (const item of prepared) {
      const { record, created } = await this.project.registerBinary(
        item.path,
        `${original} :: ${item.origin}`,
        item.metadata,
      );
      if (!created && this.project.binaryPath(record) !== item.path) {
        await fs.rm(item.path, { force: true });
      }
      results.push({ record, created });
    }
    return results;
  }
}
