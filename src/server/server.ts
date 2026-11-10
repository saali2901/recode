import { randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { trustProject } from '../ai/claude/trust.js';
import { detectFile, importIntoProject } from '../app/import-file.js';
import { initProject, PROJECT_NAME_PATTERN } from '../app/init-project.js';
import { toRecodeError, type RecodeError } from '../core/errors/index.js';
import { EventBus } from '../core/events/event-bus.js';
import { Project, MANIFEST_FILE } from '../core/project/project.js';
import { metricsDir } from '../ai/orchestration/reconstruct.js';
import {
  AnalysisTimingSchema,
  loadRun,
  summarize,
} from '../infrastructure/monitoring/run-metrics.js';
import { TaskFileSchema } from '../core/tasks/task-store.js';
import { WorkflowStateSchema } from '../core/workflow/workflow.js';
import {
  loadConfig,
  readLayer,
  setUserConfigValue,
  userConfigPath,
  withConfigValue,
} from '../infrastructure/config/config.js';
import { pathExists, readJson, readJsonIfExists } from '../infrastructure/filesystem/files.js';
import { safeJoin } from '../infrastructure/filesystem/paths.js';
import { runChecks } from '../infrastructure/tools/doctor.js';
import { RawBinaryOptionsSchema, type MetadataHints } from '../input/interfaces/types.js';
import { ValidationReportSchema } from '../cli/report-schema.js';
import { validationReportPath } from '../validation/comparison/validate.js';
import { JobRegistry, JobRequestSchema, type PipelineOverrides } from './jobs.js';
import { writeDirectoryZip } from './zip-writer.js';

export interface ServerOptions {
  /** Directory scanned for projects. A fixed value (from --workspace) overrides the user setting. */
  workspace?: string | undefined;
  /** Directory with the built web UI; the API works without it. */
  staticDir?: string | undefined;
  /** 0 picks a free port. */
  port?: number | undefined;
  token?: string | undefined;
  maxUploadBytes?: number | undefined;
  overrides?: PipelineOverrides | undefined;
}

export interface RunningServer {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

const DEFAULT_WORKSPACE = path.join(os.homedir(), 'recode-projects');
const DEFAULT_MAX_UPLOAD = 2 * 1024 ** 3;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'ERROR',
    readonly hint?: string,
  ) {
    super(message);
  }
}

function statusFor(error: RecodeError): number {
  switch (error.code) {
    case 'USAGE':
    case 'INVALID_INPUT':
    case 'UNSAFE_PATH':
    case 'ARCHIVE':
      return 400;
    case 'PROJECT':
    case 'WORKFLOW':
      return 409;
    case 'PREREQUISITE':
      return 424;
    default:
      return 500;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function sendError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (error instanceof HttpError) {
    sendJson(res, error.status, {
      error: { code: error.code, message: error.message, hint: error.hint },
    });
    return;
  }
  const failure = toRecodeError(error);
  sendJson(res, statusFor(failure), {
    error: { code: failure.code, message: failure.message, hint: failure.hint },
  });
}

async function readBody<T>(
  req: IncomingMessage,
  schema: z.ZodType<T>,
  limit = 1_000_000,
): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Request body too large.', 'TOO_LARGE');
    chunks.push(chunk as Buffer);
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON.', 'INVALID_INPUT');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new HttpError(
      400,
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      'INVALID_INPUT',
    );
  }
  return parsed.data;
}

function tokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Starts the local web server. It listens on 127.0.0.1 only and requires the token for /api. */
export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const token = options.token ?? randomBytes(24).toString('base64url');
  const jobs = new JobRegistry(options.overrides);
  const maxUpload = options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD;
  const importQueues = new Map<string, Promise<unknown>>();
  let port = 0;

  const workspace = async (): Promise<string> => {
    if (options.workspace) return path.resolve(options.workspace);
    const config = await loadConfig({});
    return path.resolve(config.ui.workspace ?? DEFAULT_WORKSPACE);
  };

  const openProject = async (name: string): Promise<Project> => {
    if (!PROJECT_NAME_PATTERN.test(name))
      throw new HttpError(404, 'Project not found.', 'NOT_FOUND');
    const dir = safeJoin(await workspace(), name);
    if (!(await pathExists(path.join(dir, MANIFEST_FILE)))) {
      throw new HttpError(404, 'Project not found.', 'NOT_FOUND');
    }
    return Project.open(dir);
  };

  const binaryOf = (project: Project, id: string) => {
    try {
      return project.resolveBinary(id);
    } catch {
      throw new HttpError(404, 'Binary not found.', 'NOT_FOUND');
    }
  };

  const describeProject = async (project: Project) => {
    const binaries = [];
    for (const record of project.binaries) {
      const workflow = await readJsonIfExists(project.workflowFile(record.id), WorkflowStateSchema);
      const tasks = await readJsonIfExists(project.tasksFile(record.id), TaskFileSchema);
      const counts = { pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
      for (const task of tasks?.tasks ?? []) counts[task.status]++;
      const m = record.metadata;
      binaries.push({
        id: record.id,
        fileName: record.fileName,
        size: record.size,
        sha256: record.sha256,
        format: m.format,
        kind: m.kind,
        architecture: m.architecture,
        bits: m.bits,
        endianness: m.endianness,
        entryPoint: m.entryPoint ?? null,
        sectionCount: m.sections.length,
        symbolCount: m.symbols.length,
        warnings: m.warnings,
        steps: workflow?.steps ?? null,
        tasks: tasks ? counts : null,
      });
    }
    return {
      name: project.name,
      binaries,
      references: project.references.map((r) => r.relativePath),
      job: jobs.forProject(project.root).latest ?? null,
    };
  };

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? 'GET';
    const segments = url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent);
    const [area, name, sub, binaryId, leaf] = segments;

    if (area === 'info' && method === 'GET') {
      return sendJson(res, 200, {
        name: 'recode',
        workspace: await workspace(),
        workspaceFixed: Boolean(options.workspace),
      });
    }

    if (area === 'doctor' && method === 'GET') {
      const config = await loadConfig({});
      return sendJson(res, 200, { checks: await runChecks(config) });
    }

    if (area === 'config') return handleConfig(req, res, url, method);

    if (area === 'workspace' && method === 'PUT') {
      if (options.workspace) {
        throw new HttpError(
          409,
          'The workspace was fixed with --workspace when the server started.',
          'FIXED',
        );
      }
      const { path: dir } = await readBody(req, z.object({ path: z.string().min(1) }));
      if (!path.isAbsolute(dir))
        throw new HttpError(400, 'The workspace must be an absolute path.', 'INVALID_INPUT');
      await setUserConfigValue(userConfigPath(), 'ui.workspace', JSON.stringify(dir));
      return sendJson(res, 200, { workspace: await workspace() });
    }

    if (area !== 'projects') throw new HttpError(404, 'Unknown API endpoint.', 'NOT_FOUND');

    if (!name) {
      if (method === 'GET')
        return sendJson(res, 200, { workspace: await workspace(), projects: await listProjects() });
      if (method === 'POST') {
        const body = await readBody(req, z.object({ name: z.string() }));
        const root = await workspace();
        await fs.mkdir(root, { recursive: true });
        const project = await initProject(root, body.name);
        return sendJson(res, 201, await describeProject(project));
      }
      throw new HttpError(405, 'Method not allowed.', 'METHOD');
    }

    const project = await openProject(name);
    const manager = jobs.forProject(project.root);

    if (!sub && method === 'GET') return sendJson(res, 200, await describeProject(project));

    if (sub === 'files' && method === 'PUT') return handleUpload(req, res, url, project);

    if (sub === 'jobs' && method === 'POST' && binaryId === undefined) {
      const request = await readBody(req, JobRequestSchema);
      const job = await manager.start(project, request);
      return sendJson(res, 202, job);
    }
    if (sub === 'jobs' && method === 'POST' && binaryId === 'cancel') {
      return sendJson(res, 200, { cancelled: manager.cancel() });
    }

    if (sub === 'trust' && method === 'POST') {
      const result = await trustProject(project.root);
      return sendJson(res, 200, result);
    }

    if (sub === 'events' && method === 'GET') return handleEvents(req, res, url, manager);

    if (sub === 'binaries' && binaryId) {
      const binary = binaryOf(project, binaryId);
      if (leaf === 'tasks' && method === 'GET') {
        const tasks = await readJsonIfExists(project.tasksFile(binary.id), TaskFileSchema);
        return sendJson(res, 200, {
          tasks: (tasks?.tasks ?? []).map((t) => ({
            id: t.id,
            kind: t.kind,
            title: t.title,
            status: t.status,
            attempts: t.attempts,
            lastError: t.lastError ?? null,
            tier: t.tier ?? null,
            escalations: t.history.filter((h) => h.outcome === 'escalated').length,
            fromCache: t.fromCache === true,
            openIssues: t.openIssues,
          })),
        });
      }
      if (leaf === 'perf' && method === 'GET') {
        const dir = metricsDir(project, binary.id);
        const run = await loadRun(dir, 'latest');
        if (!run) throw new HttpError(404, 'No reconstruction run recorded yet.', 'NOT_FOUND');
        const analysis = await readJsonIfExists(
          path.join(dir, 'analysis.json'),
          AnalysisTimingSchema,
        ).catch(() => undefined);
        return sendJson(res, 200, {
          runId: run.runId,
          mode: run.mode,
          summary: summarize(run),
          counters: run.counters,
          phases: run.phases,
          planStats: run.planStats,
          analysis: analysis ?? null,
        });
      }
      if (leaf === 'validation' && method === 'GET') {
        const file = validationReportPath(project, binary.id);
        if (!(await pathExists(file)))
          throw new HttpError(404, 'No validation report yet.', 'NOT_FOUND');
        return sendJson(res, 200, await readJson(file, ValidationReportSchema));
      }
      if (leaf === 'download' && method === 'GET') {
        const dir = project.sourceDir(binary.id);
        if (!(await pathExists(path.join(dir, 'CMakeLists.txt')))) {
          throw new HttpError(
            404,
            'No generated source yet. Run the reconstruction first.',
            'NOT_FOUND',
          );
        }
        res.writeHead(200, {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="${binary.id}-source.zip"`,
          'cache-control': 'no-store',
        });
        await writeDirectoryZip(dir, res, `${binary.id}/`);
        res.end();
        return;
      }
    }
    throw new HttpError(404, 'Unknown API endpoint.', 'NOT_FOUND');
  }

  async function listProjects() {
    const root = await workspace();
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const projects = [];
    for (const entry of entries
      .filter((e) => e.isDirectory() && PROJECT_NAME_PATTERN.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const dir = path.join(root, entry.name);
      if (!(await pathExists(path.join(dir, MANIFEST_FILE)))) continue;
      try {
        const project = await Project.open(dir);
        const job = jobs.forProject(dir).active;
        projects.push({
          name: entry.name,
          binaries: project.binaries.length,
          references: project.references.length,
          running: job?.step ?? null,
        });
      } catch (error) {
        projects.push({
          name: entry.name,
          binaries: 0,
          references: 0,
          running: null,
          error: toRecodeError(error).message,
        });
      }
    }
    return projects;
  }

  async function handleConfig(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    method: string,
  ): Promise<void> {
    const projectName = url.searchParams.get('project');
    const project = projectName ? await openProject(projectName) : undefined;
    if (method === 'GET') {
      const effective = await loadConfig({ projectLayer: project?.configLayer ?? {} });
      return sendJson(res, 200, {
        effective,
        user: await readLayer(userConfigPath()),
        project: project?.configLayer ?? null,
      });
    }
    if (method === 'PUT') {
      const body = await readBody(
        req,
        z.object({ scope: z.enum(['user', 'project']), key: z.string().min(1), value: z.string() }),
      );
      if (body.scope === 'project') {
        if (!project)
          throw new HttpError(400, 'Select a project for project-level settings.', 'INVALID_INPUT');
        await project.updateConfigLayer(withConfigValue(project.configLayer, body.key, body.value));
      } else {
        await setUserConfigValue(userConfigPath(), body.key, body.value);
      }
      return sendJson(res, 200, {
        effective: await loadConfig({ projectLayer: project?.configLayer ?? {} }),
      });
    }
    throw new HttpError(405, 'Method not allowed.', 'METHOD');
  }

  async function handleUpload(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    project: Project,
  ): Promise<void> {
    const manager = jobs.forProject(project.root);
    if (manager.active)
      throw new HttpError(
        409,
        `A ${manager.active.step} job is running; wait until it finishes.`,
        'BUSY',
      );
    const rawName = url.searchParams.get('name') ?? '';
    const fileName = path
      .basename(rawName)
      .replace(/[^A-Za-z0-9._ -]+/g, '_')
      .replace(/^\.+/, '');
    if (fileName === '')
      throw new HttpError(400, 'Query parameter "name" is required.', 'INVALID_INPUT');
    const declared = Number(req.headers['content-length'] ?? '0');
    if (declared > maxUpload) throw new HttpError(413, 'File too large.', 'TOO_LARGE');

    const uploadDir = path.join(project.paths.state, 'uploads', randomUUID());
    await fs.mkdir(uploadDir, { recursive: true });
    const uploaded = path.join(uploadDir, fileName);
    try {
      let received = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          if (received > maxUpload) callback(new HttpError(413, 'File too large.', 'TOO_LARGE'));
          else callback(null, chunk);
        },
      });
      await pipeline(req, limiter, createWriteStream(uploaded, { flags: 'wx' }));
      if (received === 0) throw new HttpError(400, 'The uploaded file is empty.', 'INVALID_INPUT');

      const params = url.searchParams;
      const rawRequested = params.get('raw') === '1';
      const hasRawFields = ['arch', 'endian', 'bits', 'base'].every((k) => params.get(k));
      const hex = (v: string | null): string | undefined =>
        v
          ? v.toLowerCase().startsWith('0x')
            ? v.toLowerCase()
            : `0x${v.toLowerCase()}`
          : undefined;

      const previous = importQueues.get(project.root) ?? Promise.resolve();
      const task = previous
        .catch(() => undefined)
        .then(async () => {
          const config = await loadConfig({ projectLayer: project.configLayer });
          const detection = await detectFile(config, project, uploaded).catch(() => undefined);
          const needsRaw = rawRequested || detection?.format === 'raw';
          let hints: MetadataHints | undefined;
          if (needsRaw) {
            if (!hasRawFields) {
              throw new HttpError(
                409,
                'This file has no recognizable header. Provide architecture, endianness, bits and base address.',
                'RAW_INFO_REQUIRED',
              );
            }
            const parsed = RawBinaryOptionsSchema.safeParse({
              architecture: params.get('arch'),
              endianness: params.get('endian'),
              bits: Number.parseInt(params.get('bits') ?? '', 10),
              baseAddress: hex(params.get('base')),
              ...(params.get('entry') ? { entryPoint: hex(params.get('entry')) } : {}),
            });
            if (!parsed.success)
              throw new HttpError(
                400,
                'Invalid raw binary information (check architecture, endianness, bits and hex addresses).',
                'INVALID_INPUT',
              );
            hints = { raw: parsed.data };
          }
          const events = new EventBus();
          return project.withLock(() =>
            importIntoProject(project, config, events, uploaded, { hints, forceRaw: rawRequested }),
          );
        });
      importQueues.set(project.root, task);
      const report = await task;
      sendJson(res, 200, {
        detection: report.detection.description,
        binaries: report.binaries.map((b) => ({
          id: b.record.id,
          fileName: b.record.fileName,
          created: b.created,
          format: b.record.metadata.format,
          architecture: b.record.metadata.architecture,
        })),
        references: report.references.map((r) => path.relative(project.root, r)),
      });
    } finally {
      await fs.rm(uploadDir, { recursive: true, force: true });
    }
  }

  function handleEvents(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    manager: ReturnType<JobRegistry['forProject']>,
  ): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const lastId =
      Number.parseInt(
        (req.headers['last-event-id'] as string | undefined) ??
          url.searchParams.get('lastEventId') ??
          '0',
        10,
      ) || 0;
    const send = (entry: { id: number; type: string; data: unknown }): void => {
      res.write(`id: ${entry.id}\nevent: ${entry.type}\ndata: ${JSON.stringify(entry.data)}\n\n`);
    };
    res.write('retry: 2000\n\n');
    for (const entry of manager.log.since(lastId)) send(entry);
    const unsubscribe = manager.log.subscribe(send);
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }

  async function serveStatic(res: ServerResponse, url: URL): Promise<void> {
    const root = options.staticDir;
    if (!root)
      throw new HttpError(404, 'The web UI is not built. Run "npm run build".', 'NOT_FOUND');
    let relative = decodeURIComponent(url.pathname);
    if (relative.endsWith('/')) relative += 'index.html';
    let file: string;
    try {
      file = safeJoin(root, relative.replace(/^\/+/, ''));
    } catch {
      throw new HttpError(400, 'Bad path.', 'INVALID_INPUT');
    }
    let stat = await fs.stat(file).catch(() => undefined);
    if (!stat?.isFile()) {
      // Client-side routes fall back to the app shell; missing assets stay 404.
      if (path.extname(relative) !== '') throw new HttpError(404, 'Not found.', 'NOT_FOUND');
      file = path.join(root, 'index.html');
      stat = await fs.stat(file).catch(() => undefined);
      if (!stat)
        throw new HttpError(404, 'The web UI is not built. Run "npm run build".', 'NOT_FOUND');
    }
    const data = await fs.readFile(file);
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
      'content-length': data.length,
      'cache-control': file.includes(`${path.sep}assets${path.sep}`)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    });
    res.end(data);
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        res.setHeader('x-content-type-options', 'nosniff');
        res.setHeader('referrer-policy', 'no-referrer');
        res.setHeader('x-frame-options', 'DENY');
        res.setHeader(
          'content-security-policy',
          "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        );

        // DNS-rebinding protection: only accept requests addressed to the loopback name we bound to.
        const host = req.headers.host ?? '';
        if (!new RegExp(`^(127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}$`).test(host)) {
          throw new HttpError(403, 'Unexpected Host header.', 'FORBIDDEN');
        }
        const url = new URL(req.url ?? '/', `http://${host}`);

        if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
          const header = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
          const supplied = header || url.searchParams.get('token') || '';
          if (!tokensEqual(supplied, token))
            throw new HttpError(401, 'Missing or invalid access token.', 'UNAUTHORIZED');
          const origin = req.headers.origin;
          if (req.method !== 'GET' && origin && origin !== `http://${host}`) {
            throw new HttpError(403, 'Cross-origin request rejected.', 'FORBIDDEN');
          }
          await handleApi(req, res, url);
          return;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD')
          throw new HttpError(405, 'Method not allowed.', 'METHOD');
        await serveStatic(res, url);
      } catch (error) {
        sendError(res, error);
      }
    })();
  });
  server.requestTimeout = 0; // uploads and event streams are long-lived

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/?token=${token}`,
    port,
    token,
    async close() {
      await jobs.shutdown();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
