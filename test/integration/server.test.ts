import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startServer, type RunningServer } from '../../src/server/server.js';
import { extractZip } from '../../src/input/extractors/zip.js';
import { defaultConfig } from '../../src/infrastructure/config/config.js';
import { buildPe, buildZip } from '../helpers/binaries.js';
import { SAMPLE_ELF } from '../helpers/tools.js';
import { createWorld, type World } from '../helpers/world.js';
import { makeTempDir, registerTempCleanup } from '../helpers/tmp.js';

registerTempCleanup();

const servers: RunningServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  vi.unstubAllEnvs();
});

interface Api {
  server: RunningServer;
  world: World;
  base: string;
  call(
    method: string,
    p: string,
    body?: unknown,
    init?: RequestInit,
  ): Promise<{ status: number; json: any }>;
  upload(
    name: string,
    data: Buffer | Uint8Array,
    query?: Record<string, string>,
  ): Promise<{ status: number; json: any }>;
  waitForJob(): Promise<any>;
}

async function setup(options: { maxUploadBytes?: number; staticDir?: string } = {}): Promise<Api> {
  const world = await createWorld();
  const server = await startServer({
    workspace: world.workDir,
    overrides: { skipPrerequisites: true },
    ...options,
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const call: Api['call'] = async (method, p, body, init) => {
    const response = await fetch(`${base}${p}`, {
      method,
      headers: {
        authorization: `Bearer ${server.token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...init,
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : undefined };
  };
  return {
    server,
    world,
    base,
    call,
    upload: async (name, data, query = {}) => {
      const qs = new URLSearchParams({ name, ...query });
      const response = await fetch(`${base}/api/projects/proj/files?${qs}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${server.token}` },
        body: data,
      });
      return { status: response.status, json: await response.json() };
    },
    async waitForJob() {
      for (let i = 0; i < 600; i++) {
        const { json } = await call('GET', '/api/projects/proj');
        if (json.job && json.job.status !== 'running') return json.job;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('job did not finish');
    },
  };
}

describe('access control', () => {
  it('requires the token for the API but not for static files', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, 'index.html'), '<html>app</html>');
    const api = await setup({ staticDir: dir });
    expect((await fetch(`${api.base}/api/info`)).status).toBe(401);
    expect(
      (await fetch(`${api.base}/api/info`, { headers: { authorization: 'Bearer wrong' } })).status,
    ).toBe(401);
    expect((await fetch(`${api.base}/api/info?token=${api.server.token}`)).status).toBe(200);
    expect((await api.call('GET', '/api/info')).status).toBe(200);
    expect(await (await fetch(`${api.base}/`)).text()).toContain('app');
  });

  it('listens on loopback only and rejects foreign Host headers (DNS rebinding)', async () => {
    const api = await setup();
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: api.server.port,
          path: '/api/info',
          headers: { host: 'evil.example.com', authorization: `Bearer ${api.server.token}` },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
    expect(api.server.url.startsWith('http://127.0.0.1:')).toBe(true);
  });

  it('rejects cross-origin state changes even with a valid token', async () => {
    const api = await setup();
    const response = await fetch(`${api.base}/api/projects`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${api.server.token}`,
        origin: 'http://evil.example.com',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(response.status).toBe(403);
  });

  it('serves the app shell for client routes, 404 for missing assets and blocks traversal', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, 'index.html'), '<html>shell</html>');
    await fs.mkdir(path.join(dir, 'assets'));
    await fs.writeFile(path.join(dir, 'assets', 'a.js'), 'console.log(1)');
    await fs.writeFile(path.join(path.dirname(dir), 'secret.txt'), 'secret');
    const api = await setup({ staticDir: dir });
    expect(await (await fetch(`${api.base}/projects/x`)).text()).toContain('shell');
    expect((await fetch(`${api.base}/assets/a.js`)).headers.get('content-type')).toContain(
      'javascript',
    );
    expect((await fetch(`${api.base}/assets/missing.js`)).status).toBe(404);
    const traversal = await new Promise<number>((resolve, reject) => {
      http
        .get(
          {
            host: '127.0.0.1',
            port: api.server.port,
            path: '/..%2fsecret.txt',
            headers: { host: `127.0.0.1:${api.server.port}` },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        )
        .on('error', reject);
    });
    expect([400, 404]).toContain(traversal);
    expect((await fetch(`${api.base}/`)).headers.get('content-security-policy')).toContain(
      "default-src 'self'",
    );
  });
});

describe('projects and uploads', () => {
  it('lists, creates and validates projects', async () => {
    const api = await setup();
    const list = await api.call('GET', '/api/projects');
    expect(list.json.projects.map((p: { name: string }) => p.name)).toEqual(['proj']);
    expect((await api.call('POST', '/api/projects', { name: 'second' })).status).toBe(201);
    await expect(
      fs.stat(path.join(api.world.workDir, 'second', '.claude', 'agents', 'recode-lead.md')),
    ).resolves.toBeTruthy();
    expect((await api.call('POST', '/api/projects', { name: '../evil' })).status).toBe(400);
    expect((await api.call('POST', '/api/projects', { name: 'second' })).status).toBe(409);
    expect((await api.call('GET', '/api/projects/nope')).status).toBe(404);
    expect((await api.call('GET', '/api/projects/..%2F..%2Fetc')).status).toBe(404);
  });

  it('imports an uploaded ELF and reports its facts', async () => {
    const api = await setup();
    const result = await api.upload('sample', await fs.readFile(SAMPLE_ELF));
    expect(result.status).toBe(200);
    expect(result.json.binaries[0]).toMatchObject({
      created: true,
      format: 'elf',
      architecture: 'x86_64',
    });
    const project = (await api.call('GET', '/api/projects/proj')).json;
    expect(project.binaries[0]).toMatchObject({ format: 'elf', bits: 64, endianness: 'little' });
    expect(project.binaries[0].steps.prepare.status).toBe('completed');
    expect(project.binaries[0].symbolCount).toBeGreaterThan(5);
  });

  it('sanitizes upload names and keeps files inside the project', async () => {
    const api = await setup();
    const result = await api.upload('../../../evil.exe', buildPe({}));
    expect(result.status).toBe(200);
    const project = (await api.call('GET', '/api/projects/proj')).json;
    expect(project.binaries[0].fileName).toBe('evil.exe');
    await expect(fs.stat(path.join(api.world.root, 'evil.exe'))).rejects.toThrow();
  });

  it('stores reference files and extracts ZIP archives safely', async () => {
    const api = await setup();
    expect((await api.upload('notes.txt', Buffer.from('hello'))).json.references).toHaveLength(1);
    const ok = await api.upload('b.zip', buildZip([{ name: 'x.exe', data: buildPe({}) }]));
    expect(ok.json.binaries).toHaveLength(1);
    const evil = await api.upload(
      'evil.zip',
      buildZip([{ name: '../../escape', data: Buffer.from('x') }]),
    );
    expect(evil.status).toBe(400);
    expect(evil.json.error.code).toBe('UNSAFE_PATH');
  });

  it('asks for raw binary information and accepts it', async () => {
    const api = await setup();
    const data = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const missing = await api.upload('fw.bin', data);
    expect(missing.status).toBe(409);
    expect(missing.json.error.code).toBe('RAW_INFO_REQUIRED');
    const bad = await api.upload('fw.bin', data, {
      raw: '1',
      arch: 'arm',
      endian: 'little',
      bits: '32',
      base: 'zz',
    });
    expect(bad.status).toBe(400);
    const ok = await api.upload('fw.bin', data, {
      raw: '1',
      arch: 'arm',
      endian: 'little',
      bits: '32',
      base: '8000',
    });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect((await api.call('GET', '/api/projects/proj')).json.binaries[0]).toMatchObject({
      format: 'raw',
      architecture: 'arm',
    });
  });

  it('rejects empty, oversized and unknown uploads', async () => {
    const api = await setup({ maxUploadBytes: 1000 });
    expect((await api.upload('e.bin', Buffer.alloc(0))).status).toBe(400);
    expect((await api.upload('big.exe', Buffer.alloc(5000, 1))).status).toBe(413);
    expect((await api.upload('mystery', Buffer.from([0xde, 0xad]))).status).toBe(400);
    expect((await fs.readdir(path.join(api.world.projectDir, '.recode', 'uploads'))).length).toBe(
      0,
    );
  });
});

describe('jobs', () => {
  async function importSample(api: Api): Promise<void> {
    expect((await api.upload('sample', await fs.readFile(SAMPLE_ELF))).status).toBe(200);
  }
  const start = (api: Api, body: object) => api.call('POST', '/api/projects/proj/jobs', body);

  it('runs the whole workflow in the background, streams progress and serves results', async () => {
    const api = await setup();
    await importSample(api);

    // Subscribe to the event stream before starting, as the browser does.
    const controller = new AbortController();
    const stream = await fetch(`${api.base}/api/projects/proj/events?token=${api.server.token}`, {
      signal: controller.signal,
    });
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    let received = '';
    const reader = stream.body!.getReader();
    const pump = (async () => {
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (done) break;
        received += decoder.decode(value);
      }
    })();

    const started = await start(api, { step: 'run' });
    expect(started.status).toBe(202);
    expect(started.json.status).toBe('running');
    expect((await start(api, { step: 'build' })).status).toBe(409); // one job at a time
    expect((await api.upload('late.txt', Buffer.from('x'))).status).toBe(409);

    const job = await api.waitForJob();
    expect(job).toMatchObject({ status: 'completed', step: 'run' });
    expect(job.summary).toContain('analyze');
    await new Promise((r) => setTimeout(r, 300));
    controller.abort();
    await pump;

    expect(received).toContain('event: job');
    expect(received).toContain('"type":"step-started"');
    expect(received).toContain('"type":"task-completed"');
    expect(received).toContain('event: log');
    expect(received).toContain('analyzeHeadless');

    const project = (await api.call('GET', '/api/projects/proj')).json;
    const binary = project.binaries[0];
    expect(Object.values(binary.steps).map((s: any) => s.status)).toEqual(
      Array(5).fill('completed'),
    );
    expect(binary.tasks).toMatchObject({ completed: 8, failed: 0 });

    const tasks = (await api.call('GET', `/api/projects/proj/binaries/${binary.id}/tasks`)).json
      .tasks;
    expect(tasks).toHaveLength(8);
    expect(tasks.find((t: any) => t.kind === 'types').status).toBe('completed');
    expect(tasks.find((t: any) => t.kind === 'types')).toMatchObject({ tier: 'advanced' });
    expect(tasks.find((t: any) => t.title.startsWith('add_ints'))).toMatchObject({
      tier: 'fast',
      escalations: 0,
      fromCache: false,
      openIssues: [],
    });

    const perf = (await api.call('GET', `/api/projects/proj/binaries/${binary.id}/perf`)).json;
    expect(perf).toMatchObject({ mode: 'adaptive', summary: { accepted: 8, failed: 0 } });
    expect(perf.summary.perModel.map((m: any) => m.tier)).toEqual(
      expect.arrayContaining(['fast', 'advanced']),
    );
    expect(perf.analysis).toMatchObject({ functions: 6 });

    const validation = (
      await api.call('GET', `/api/projects/proj/binaries/${binary.id}/validation`)
    ).json;
    expect(validation.checks.find((c: any) => c.id === 'functional').outcome).toBe('not-assessed');
    expect(validation.checks.find((c: any) => c.id === 'compile').outcome).toBe('passed');

    const zip = await fetch(
      `${api.base}/api/projects/proj/binaries/${binary.id}/download?token=${api.server.token}`,
    );
    expect(zip.headers.get('content-type')).toBe('application/zip');
    const target = await makeTempDir();
    const zipFile = path.join(target, 'd.zip');
    await fs.writeFile(zipFile, Buffer.from(await zip.arrayBuffer()));
    const extracted = await extractZip(zipFile, path.join(target, 'out'), defaultConfig().archive);
    const names = extracted.extracted.map((f) => path.basename(f));
    expect(names).toEqual(
      expect.arrayContaining(['CMakeLists.txt', 'add_ints.c', 'recode_types.h']),
    );
  });

  it('replays missed events when a client reconnects with Last-Event-ID', async () => {
    const api = await setup();
    await importSample(api);
    await start(api, { step: 'analyze' });
    await api.waitForJob();
    const read = async (headers: Record<string, string>) => {
      const controller = new AbortController();
      const response = await fetch(
        `${api.base}/api/projects/proj/events?token=${api.server.token}`,
        { headers, signal: controller.signal },
      );
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      const timer = setTimeout(() => controller.abort(), 700);
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (done) break;
        text += decoder.decode(value);
      }
      clearTimeout(timer);
      return text;
    };
    const all = await read({});
    expect(all).toContain('event: job');
    const ids = [...all.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    const later = await read({ 'last-event-id': String(ids[ids.length - 1]) });
    expect(later).not.toContain('event: job');
  });

  it('reports failed jobs with message and hint, and keeps the project usable', async () => {
    const api = await setup();
    await importSample(api);
    api.world.setEnv('FAKE_GHIDRA_MODE', 'fail');
    await start(api, { step: 'analyze' });
    const job = await api.waitForJob();
    expect(job.status).toBe('failed');
    expect(job.error).toContain('exited with code 2');
    api.world.setEnv('FAKE_GHIDRA_MODE', 'ok');
    expect((await start(api, { step: 'analyze' })).status).toBe(202);
    expect((await api.waitForJob()).status).toBe('completed');
  });

  it('cancels a running job; progress stays resumable', async () => {
    const api = await setup();
    await importSample(api);
    await start(api, { step: 'analyze' });
    await api.waitForJob();
    api.world.setEnv('MOCK_CLAUDE_MODE', 'hang');
    await start(api, { step: 'reconstruct' });
    await new Promise((r) => setTimeout(r, 1500));
    expect((await api.call('POST', '/api/projects/proj/jobs/cancel')).json.cancelled).toBe(true);
    const job = await api.waitForJob();
    expect(job.status).toBe('cancelled');
    const binary = (await api.call('GET', '/api/projects/proj')).json.binaries[0];
    expect(binary.steps.reconstruct.status).toBe('cancelled');
    expect(binary.tasks.running).toBe(0);

    api.world.setEnv('MOCK_CLAUDE_MODE', 'ok');
    await start(api, { step: 'reconstruct' });
    expect((await api.waitForJob()).status).toBe('completed');
  });

  it('validates job requests', async () => {
    const api = await setup();
    expect((await start(api, { step: 'explode' })).status).toBe(400);
    expect((await start(api, { step: 'analyze' })).status).toBe(409); // no binary yet
    await importSample(api);
    expect((await start(api, { step: 'analyze', binaryId: 'nope' })).status).toBe(400);
    expect((await api.call('GET', '/api/projects/proj/binaries/nope/tasks')).status).toBe(404);
    expect((await api.call('GET', '/api/projects/proj/binaries/x/validation')).status).toBe(404);
    expect((await api.call('GET', '/api/projects/proj/binaries/x/perf')).status).toBe(404);
    const binaryId = (await api.call('GET', '/api/projects/proj')).json.binaries[0].id;
    expect((await api.call('GET', `/api/projects/proj/binaries/${binaryId}/perf`)).status).toBe(
      404,
    );
    expect(
      (await start(api, { step: 'reconstruct', options: { dependencies: 'sideways' } })).status,
    ).toBe(400);
    expect((await start(api, { step: 'reconstruct', options: { sessions: 99 } })).status).toBe(400);
    expect((await start(api, { step: 'reconstruct', options: { surprise: true } })).status).toBe(
      400,
    );
  });

  it('applies per-run scheduler options and the cache switch to a reconstruct job', async () => {
    const api = await setup();
    await importSample(api);
    expect((await start(api, { step: 'analyze' })).status).toBe(202);
    await api.waitForJob();
    const options = { sessions: 1, dependencies: 'complete' };
    expect((await start(api, { step: 'reconstruct', options })).status).toBe(202);
    expect((await api.waitForJob()).status).toBe('completed');
    const id = (await api.call('GET', '/api/projects/proj')).json.binaries[0].id;
    const first = (await api.call('GET', `/api/projects/proj/binaries/${id}/perf`)).json;
    expect(first).toMatchObject({ mode: 'complete' });
    expect(first.summary.workersMax).toBe(1);

    // a forced run with the cache switched off asks the model again
    const sessionsBefore = first.summary.modelCalls;
    expect(
      (
        await start(api, {
          step: 'reconstruct',
          force: true,
          options: { ...options, noCache: true },
        })
      ).status,
    ).toBe(202);
    await api.waitForJob();
    const again = (await api.call('GET', `/api/projects/proj/binaries/${id}/perf`)).json;
    expect(again.summary.modelCalls).toBe(0); // tasks were complete, nothing was queued
    expect(sessionsBefore).toBeGreaterThan(0);
  });
});

describe('settings and doctor', () => {
  it('reads and writes configuration at user and project level with validation', async () => {
    const api = await setup();
    const initial = (await api.call('GET', '/api/config?project=proj')).json;
    expect(initial.effective.claude.maxParallelAgents).toBe(2);
    // the performance settings are part of the effective configuration, so the settings page lists them
    expect(initial.effective.routing.tiers.advanced.model).toBe('opus');
    expect(initial.effective.scheduler).toMatchObject({ mode: 'adaptive', maxSessions: 4 });
    expect(
      (
        await api.call('PUT', '/api/config?project=proj', {
          scope: 'project',
          key: 'routing.tiers.expert.model',
          value: 'my-model',
        })
      ).json.effective.routing.tiers.expert,
    ).toMatchObject({ model: 'my-model', batchSize: 1 });
    expect(
      (
        await api.call('PUT', '/api/config?project=proj', {
          scope: 'project',
          key: 'claude.maxParallelAgents',
          value: '3',
        })
      ).json.effective.claude.maxParallelAgents,
    ).toBe(3);
    expect(
      (
        await api.call('PUT', '/api/config', {
          scope: 'user',
          key: 'build.timeoutSeconds',
          value: '99',
        })
      ).json.effective.build.timeoutSeconds,
    ).toBe(99);
    expect(
      (
        await api.call('PUT', '/api/config?project=proj', {
          scope: 'project',
          key: 'claude.maxParallelAgents',
          value: '0',
        })
      ).status,
    ).toBe(400);
    expect(
      (await api.call('PUT', '/api/config', { scope: 'project', key: 'a.b', value: '1' })).status,
    ).toBe(400);
  });

  it('reports tool status', async () => {
    const api = await setup();
    const { checks } = (await api.call('GET', '/api/doctor')).json;
    expect(checks.map((c: any) => c.id)).toEqual(
      expect.arrayContaining(['node', 'claude', 'ghidra', 'cmake']),
    );
    expect(checks.find((c: any) => c.id === 'ghidra').status).toBe('ok');
  });

  it('changes the workspace unless it was fixed at startup', async () => {
    const world = await createWorld({ project: false });
    const dir = await makeTempDir();
    const free = await startServer({});
    servers.push(free);
    const call = (method: string, p: string, body?: unknown) =>
      fetch(`http://127.0.0.1:${free.port}${p}`, {
        method,
        headers: { authorization: `Bearer ${free.token}`, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    expect((await call('PUT', '/api/workspace', { path: 'relative' })).status).toBe(400);
    expect((await call('PUT', '/api/workspace', { path: dir })).status).toBe(200);
    expect(
      ((await (await call('GET', '/api/info')).json()) as { workspace: string }).workspace,
    ).toBe(dir);

    const fixed = await startServer({ workspace: world.workDir });
    servers.push(fixed);
    const response = await fetch(`http://127.0.0.1:${fixed.port}/api/workspace`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${fixed.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ path: dir }),
    });
    expect(response.status).toBe(409);
  });
});

describe('trust endpoint', () => {
  it('marks the project folder as trusted for Claude Code', async () => {
    const api = await setup();
    const dir = await makeTempDir();
    api.world.setEnv('CLAUDE_CONFIG_DIR', dir);
    const first = await api.call('POST', '/api/projects/proj/trust', {});
    expect(first.status).toBe(200);
    expect(first.json.alreadyTrusted).toBe(false);
    const config = JSON.parse(await fs.readFile(path.join(dir, '.claude.json'), 'utf8'));
    expect(config.projects[path.resolve(api.world.projectDir)].hasTrustDialogAccepted).toBe(true);
    expect((await api.call('POST', '/api/projects/proj/trust', {})).json.alreadyTrusted).toBe(true);
  });
});
