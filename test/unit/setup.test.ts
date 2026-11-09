import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/infrastructure/config/config.js';
import type { CheckResult, ToolId } from '../../src/infrastructure/tools/doctor.js';
import { downloadVerified, installGhidra, parseRelease } from '../../src/setup/ghidra-release.js';
import { planSetup, type PlanInput } from '../../src/setup/plan.js';
import { missingTools, runSetup, type SetupDeps } from '../../src/setup/setup.js';
import { buildZip } from '../helpers/binaries.js';
import { makeTempDir, registerTempCleanup } from '../helpers/tmp.js';

registerTempCleanup();

const input = (patch: Partial<PlanInput> = {}): PlanInput => ({
  platform: 'linux',
  packageManager: 'apt',
  isRoot: false,
  hasSudo: true,
  missing: new Set<ToolId>(['compiler', 'cmake', 'ninja', 'java']),
  ...patch,
});

describe('setup plan', () => {
  it('uses apt with sudo for non-root users and installs build tools and the JDK in one step', () => {
    const plan = planSetup(input());
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      kind: 'command',
      admin: true,
      spec: {
        command: 'sudo',
        args: [
          'apt-get',
          'install',
          '-y',
          'build-essential',
          'cmake',
          'ninja-build',
          'openjdk-21-jdk',
        ],
      },
    });
  });

  it('skips sudo for root and only requests what is missing', () => {
    const plan = planSetup(input({ isRoot: true, missing: new Set<ToolId>(['ninja']) }));
    expect(plan.steps[0]).toMatchObject({
      spec: {
        command: 'apt-get',
        args: ['install', '-y', 'build-essential', 'cmake', 'ninja-build'],
      },
    });
    const javaOnly = planSetup(input({ isRoot: true, missing: new Set<ToolId>(['java']) }));
    expect(javaOnly.steps[0]).toMatchObject({
      spec: { args: ['install', '-y', 'openjdk-21-jdk'] },
    });
  });

  it('supports dnf, pacman and brew (no admin rights for brew)', () => {
    expect(planSetup(input({ packageManager: 'dnf', isRoot: true })).steps[0]).toMatchObject({
      spec: { command: 'dnf' },
    });
    expect(planSetup(input({ packageManager: 'pacman', isRoot: true })).steps[0]).toMatchObject({
      spec: { command: 'pacman' },
    });
    const mac = planSetup(input({ platform: 'darwin', packageManager: 'brew', hasSudo: false }));
    expect(mac.steps[0]).toMatchObject({
      admin: false,
      spec: { command: 'brew', args: ['install', 'cmake', 'ninja', 'openjdk@21'] },
    });
    expect(mac.manual.join()).toContain('xcode-select --install');
  });

  it('plans Ghidra and Claude Code as user-level steps and never needs admin rights for them', () => {
    const plan = planSetup(
      input({ missing: new Set<ToolId>(['ghidra', 'claude']), hasSudo: false }),
    );
    expect(plan.steps.map((s) => s.kind)).toEqual(['ghidra', 'claude']);
    expect(plan.manual).toEqual([]);
  });

  it('explains what to do when packages cannot be installed automatically', () => {
    expect(planSetup(input({ packageManager: undefined })).manual[0]).toContain(
      'No supported package manager',
    );
    const noSudo = planSetup(input({ hasSudo: false }));
    expect(noSudo.steps).toEqual([]);
    expect(noSudo.manual[0]).toContain('build-essential cmake ninja-build openjdk-21-jdk');
  });

  it('plans nothing when nothing is missing', () => {
    expect(planSetup(input({ missing: new Set() }))).toEqual({ steps: [], manual: [] });
  });
});

const check = (id: ToolId, status: CheckResult['status']): CheckResult => ({
  id,
  label: id,
  status,
  detail: '',
});

describe('missingTools', () => {
  it('treats failed tools and an outdated Java as missing, but not the login', () => {
    const missing = missingTools([
      check('node', 'ok'),
      check('claude', 'fail'),
      check('claude-auth', 'fail'),
      check('java', 'warn'),
      check('cmake', 'warn'),
      check('ninja', 'ok'),
    ]);
    expect([...missing].sort()).toEqual(['claude', 'java']);
  });
});

describe('Ghidra release parsing', () => {
  const asset = (extra: object = {}) => ({
    name: 'ghidra_11.3.1_PUBLIC_20250219.zip',
    browser_download_url:
      'https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_11.3.1_build/ghidra_11.3.1_PUBLIC_20250219.zip',
    size: 100,
    ...extra,
  });
  const sha = 'a'.repeat(64);

  it('reads the checksum from the asset digest', () => {
    const release = parseRelease({
      tag_name: 'Ghidra_11.3.1_build',
      assets: [
        { name: 'other.txt', browser_download_url: 'https://x.y/z' },
        asset({ digest: `sha256:${sha}` }),
      ],
    });
    expect(release).toMatchObject({
      version: '11.3.1',
      sha256: sha,
      name: 'ghidra_11.3.1_PUBLIC_20250219.zip',
    });
  });

  it('falls back to the checksum in the release notes', () => {
    const body = `Notes\nghidra_11.3.1_PUBLIC_20250219.zip SHA-256: ${sha.toUpperCase()}`;
    expect(parseRelease({ tag_name: 't', body, assets: [asset()] }).sha256).toBe(sha);
  });

  it('refuses downloads without a published checksum', () => {
    expect(() =>
      parseRelease({ tag_name: 't', body: 'no hashes here', assets: [asset()] }),
    ).toThrow(/unverified/);
  });

  it('rejects unexpected responses and releases without a distribution', () => {
    expect(() => parseRelease({ nope: 1 })).toThrow(/Unexpected response/);
    expect(() => parseRelease({ tag_name: 't', assets: [] })).toThrow(/no PUBLIC zip/);
  });
});

/** Serves in-memory files over HTTP, as a stand-in for GitHub. */
async function serve(
  files: Record<string, Buffer | object>,
): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const entry = files[req.url ?? ''];
    if (entry === undefined) {
      res.writeHead(404).end();
      return;
    }
    const body = Buffer.isBuffer(entry) ? entry : Buffer.from(JSON.stringify(entry));
    res.writeHead(200, { 'content-length': body.length }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function fakeGhidraZip(): Buffer {
  return buildZip([
    {
      name: 'ghidra_99.0_PUBLIC/support/analyzeHeadless',
      data: Buffer.from('#!/bin/sh\necho ok\n'),
      unixMode: 0o100755,
    },
    {
      name: 'ghidra_99.0_PUBLIC/Ghidra/application.properties',
      data: Buffer.from('application.version=99.0\n'),
    },
    { name: 'ghidra_99.0_PUBLIC/docs/readme.txt', data: Buffer.from('docs') },
  ]);
}

const servers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((close) => close()));
});

describe('verified download and Ghidra installation', () => {
  it('installs a verified archive, keeps the executable bit and validates the layout', async () => {
    const zip = fakeGhidraZip();
    const server = await serve({ '/g.zip': zip });
    servers.push(server.close);
    const root = await makeTempDir();
    const installation = await installGhidra(
      {
        version: '99.0',
        name: 'ghidra_99.0_PUBLIC_1.zip',
        url: `${server.base}/g.zip`,
        sha256: createHash('sha256').update(zip).digest('hex'),
        size: zip.length,
      },
      root,
    );
    expect(installation).toMatchObject({
      version: '99.0',
      installDir: path.join(root, 'ghidra_99.0_PUBLIC'),
    });
    const mode = (await fs.stat(installation.headlessPath)).mode;
    expect(mode & 0o111).not.toBe(0);
    expect(
      (await fs.stat(path.join(root, 'ghidra_99.0_PUBLIC', 'docs', 'readme.txt'))).mode & 0o111,
    ).toBe(0);
    await expect(
      fs.stat(path.join(root, 'downloads', 'ghidra_99.0_PUBLIC_1.zip')),
    ).rejects.toThrow();
    expect((await fs.readdir(root)).filter((n) => n.startsWith('staging'))).toEqual([]);
  });

  it('deletes the download and aborts on a checksum mismatch', async () => {
    const server = await serve({ '/g.zip': fakeGhidraZip() });
    servers.push(server.close);
    const root = await makeTempDir();
    const target = path.join(root, 'g.zip');
    await expect(downloadVerified(`${server.base}/g.zip`, target, 'b'.repeat(64))).rejects.toThrow(
      /Checksum mismatch/,
    );
    await expect(fs.stat(target)).rejects.toThrow();
  });

  it('reports HTTP errors and non-Ghidra archives clearly', async () => {
    const zip = buildZip([{ name: 'something/else.txt', data: Buffer.from('x') }]);
    const server = await serve({ '/bad.zip': zip });
    servers.push(server.close);
    const root = await makeTempDir();
    await expect(
      downloadVerified(`${server.base}/missing`, path.join(root, 'x'), 'c'.repeat(64)),
    ).rejects.toThrow(/status 404/);
    await expect(
      installGhidra(
        {
          version: '1',
          name: 'bad.zip',
          url: `${server.base}/bad.zip`,
          sha256: createHash('sha256').update(zip).digest('hex'),
          size: zip.length,
        },
        root,
      ),
    ).rejects.toThrow(/not a Ghidra installation/);
  });
});

describe('runSetup', () => {
  interface Harness {
    deps: SetupDeps;
    commands: string[];
    messages: string[];
    configSet: Record<string, unknown>;
  }

  async function harness(
    patch: Partial<SetupDeps> = {},
    states: CheckResult[][] = [],
  ): Promise<Harness> {
    const commands: string[] = [];
    const messages: string[] = [];
    const configSet: Record<string, unknown> = {};
    const queue = [...states];
    const log = (text = ''): void => void messages.push(text);
    const deps: SetupDeps = {
      platform: 'linux',
      config: defaultConfig(),
      out: { line: log, info: log, success: log, warn: log },
      dataDir: await makeTempDir(),
      checks: async () => queue.shift() ?? queue[0] ?? [],
      run: async (spec) => {
        commands.push([spec.command, ...spec.args].join(' '));
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          aborted: false,
          durationMs: 1,
          stdout: '',
          stderr: '',
          truncated: false,
        };
      },
      detectPackageManager: async () => 'apt',
      isRoot: true,
      hasSudo: false,
      confirm: async () => true,
      setConfig: async (key, value) => void (configSet[key] = value),
      dryRun: false,
      yes: false,
      ...patch,
    };
    return { deps, commands, messages, configSet };
  }

  const allOk = [
    check('node', 'ok'),
    check('java', 'ok'),
    check('compiler', 'ok'),
    check('cmake', 'ok'),
    check('ninja', 'ok'),
    check('ghidra', 'ok'),
    check('claude', 'ok'),
    check('claude-auth', 'ok'),
  ];
  const withMissing = (...ids: ToolId[]) =>
    allOk.map((c) => (ids.includes(c.id) ? { ...c, status: 'fail' as const } : c));

  it('does nothing when everything is installed, but reminds about the login', async () => {
    const h = await harness({}, [
      allOk.map((c) => (c.id === 'claude-auth' ? { ...c, status: 'fail' as const } : c)),
    ]);
    const result = await runSetup(h.deps);
    expect(result.executed).toEqual([]);
    expect(h.messages.join('\n')).toContain('already installed');
    expect(h.messages.join('\n')).toContain('not logged in');
  });

  it('shows the plan on a dry run and changes nothing', async () => {
    const h = await harness({ dryRun: true }, [withMissing('cmake', 'ninja')]);
    await runSetup(h.deps);
    expect(h.commands).toEqual([]);
    expect(h.messages.join('\n')).toContain('apt-get install -y build-essential cmake ninja-build');
    expect(h.messages.join('\n')).toContain('Dry run');
  });

  it('asks for confirmation and respects a "no"', async () => {
    const h = await harness({ confirm: async () => false }, [withMissing('cmake')]);
    await runSetup(h.deps);
    expect(h.commands).toEqual([]);
    expect(h.messages.join('\n')).toContain('Nothing was changed');
  });

  it('requires --yes in non-interactive terminals', async () => {
    const h = await harness({ confirm: async () => undefined }, [withMissing('cmake')]);
    await expect(runSetup(h.deps)).rejects.toMatchObject({
      code: 'USAGE',
      hint: expect.stringContaining('--yes'),
    });
  });

  it('runs the plan, then re-checks and reports the result', async () => {
    const h = await harness({ yes: true }, [withMissing('cmake', 'java'), allOk]);
    const result = await runSetup(h.deps);
    expect(h.commands).toEqual([
      'apt-get install -y build-essential cmake ninja-build openjdk-21-jdk',
    ]);
    expect(result).toMatchObject({ executed: ['packages'], remaining: [] });
    expect(h.messages.join('\n')).toContain('Everything required is installed');
  });

  it('stops at the first failing step with the tool output as hint', async () => {
    const h = await harness(
      {
        yes: true,
        run: async () => ({
          exitCode: 100,
          signal: null,
          timedOut: false,
          aborted: false,
          durationMs: 1,
          stdout: '',
          stderr: 'E: Unable to locate package',
          truncated: false,
        }),
      },
      [withMissing('cmake', 'ghidra')],
    );
    await expect(runSetup(h.deps)).rejects.toMatchObject({
      code: 'TOOL_FAILED',
      hint: expect.stringContaining('Unable to locate package'),
    });
    expect(h.configSet).toEqual({});
  });

  it('installs Ghidra from the release API and stores its location in the config', async () => {
    const zip = fakeGhidraZip();
    const server = await serve({
      '/g.zip': zip,
      '/api': {
        tag_name: 'Ghidra_99.0_build',
        assets: [
          {
            name: 'ghidra_99.0_PUBLIC_20260101.zip',
            browser_download_url: 'http://placeholder',
            digest: `sha256:${createHash('sha256').update(zip).digest('hex')}`,
          },
        ],
      },
    });
    servers.push(server.close);
    const rewrite: typeof fetch = (url, init) =>
      fetch(String(url) === 'http://placeholder' ? `${server.base}/g.zip` : url, init);
    const h = await harness(
      { yes: true, only: ['ghidra'], fetchImpl: rewrite, releaseApi: `${server.base}/api` },
      [withMissing('ghidra'), allOk],
    );
    const result = await runSetup(h.deps);
    expect(result.executed).toEqual(['ghidra']);
    expect(h.configSet['tools.ghidraInstallDir']).toBe(
      path.join(h.deps.dataDir, 'ghidra', 'ghidra_99.0_PUBLIC'),
    );
    await expect(
      fs.stat(
        path.join(h.deps.dataDir, 'ghidra', 'ghidra_99.0_PUBLIC', 'support', 'analyzeHeadless'),
      ),
    ).resolves.toBeTruthy();
  });
});
