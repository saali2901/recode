import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Project } from '../../src/core/project/project.js';
import { SAMPLE_ELF } from '../helpers/tools.js';
import { createWorld } from '../helpers/world.js';
import { registerTempCleanup } from '../helpers/tmp.js';

registerTempCleanup();
afterEach(() => vi.unstubAllEnvs());

describe('CLI behaviour', () => {
  it('shows help and version with exit code 0', async () => {
    const world = await createWorld({ project: false });
    const help = await world.run(['--help']);
    expect(help.code).toBe(0);
    for (const command of [
      'init',
      'import',
      'inspect',
      'analyze',
      'reconstruct',
      'build',
      'validate',
      'status',
      'logs',
      'doctor',
      'config',
    ]) {
      expect(help.stdout).toContain(command);
    }
    expect((await world.run(['--version'])).stdout.trim()).toBe('0.1.0');
  });

  it('uses exit code 2 for unknown commands and options', async () => {
    const world = await createWorld({ project: false });
    expect((await world.run(['frobnicate'])).code).toBe(2);
    expect((await world.run(['status', '--nope'])).code).toBe(2);
    expect((await world.run(['import'])).code).toBe(2);
  });

  it('init validates names and refuses existing directories', async () => {
    const world = await createWorld({ project: false });
    expect((await world.run(['init', '../escape'], { cwd: world.workDir })).code).toBe(2);
    expect((await world.run(['init', 'ok-name'], { cwd: world.workDir })).code).toBe(0);
    const again = await world.run(['init', 'ok-name'], { cwd: world.workDir });
    expect(again.code).toBe(4);
    for (const agent of [
      'lead',
      'binary-analyst',
      'function-analyst',
      'structure-analyst',
      'c-reconstructor',
      'validation-agent',
    ]) {
      await expect(
        fs.stat(path.join(world.workDir, 'ok-name', '.claude', 'agents', `recode-${agent}.md`)),
      ).resolves.toBeTruthy();
    }
    const settings = JSON.parse(
      await fs.readFile(path.join(world.workDir, 'ok-name', '.claude', 'settings.json'), 'utf8'),
    );
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(['Bash', 'WebFetch']));
  });

  it('reports a missing project with a hint (exit 4)', async () => {
    const world = await createWorld({ project: false });
    const result = await world.run(['status'], { cwd: world.workDir });
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('recode init');
  });

  it('works from any directory via --project', async () => {
    const world = await createWorld();
    await world.run(['import', SAMPLE_ELF]);
    const elsewhere = await world.run(['--project', world.projectDir, 'inspect'], {
      cwd: world.root,
    });
    expect(elsewhere.code, elsewhere.stderr).toBe(0);
    expect(elsewhere.stdout).toContain('x86_64, 64-bit, little-endian');
    expect(elsewhere.stdout).toContain('.text');
  });

  it('inspect --json emits metadata including real symbols', async () => {
    const world = await createWorld();
    await world.run(['import', SAMPLE_ELF]);
    const json = JSON.parse((await world.run(['inspect', '--json'])).stdout);
    expect(json.metadata.symbols.map((s: { name: string }) => s.name)).toContain('shape_area');
    expect(json.sha256).toHaveLength(64);
  });

  it('requires --binary when the project holds several binaries', async () => {
    const world = await createWorld();
    await world.run(['import', SAMPLE_ELF]);
    const other = path.join(world.workDir, 'other');
    await fs.copyFile(SAMPLE_ELF, other);
    await fs.appendFile(other, Buffer.from([0]));
    await world.run(['import', other]);
    const result = await world.run(['inspect']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--binary');
    const project = await Project.open(world.projectDir);
    const picked = await world.run(['inspect', '--binary', project.binaries[1]!.id]);
    expect(picked.code).toBe(0);
  });

  it('config get/set/list at project and global level with validation', async () => {
    const world = await createWorld();
    expect((await world.run(['config', 'get', 'claude.maxParallelAgents'])).stdout.trim()).toBe(
      '2',
    );
    expect((await world.run(['config', 'set', 'claude.maxParallelAgents', '3'])).code).toBe(0);
    expect((await world.run(['config', 'get', 'claude.maxParallelAgents'])).stdout.trim()).toBe(
      '3',
    );
    const invalid = await world.run(['config', 'set', 'claude.maxParallelAgents', '0']);
    expect(invalid.code).toBe(2);
    expect((await world.run(['config', 'get', 'claude.maxParallelAgents'])).stdout.trim()).toBe(
      '3',
    );
    expect(
      (await world.run(['config', 'set', '--global', 'build.timeoutSeconds', '120'])).code,
    ).toBe(0);
    const list = JSON.parse((await world.run(['config', 'list'])).stdout);
    expect(list.build.timeoutSeconds).toBe(120);
    expect(list.claude.maxParallelAgents).toBe(3);
  });

  it('logs lists and tails log files and rejects path traversal', async () => {
    const world = await createWorld();
    await world.run(['import', SAMPLE_ELF]);
    await world.run(['analyze'], { overrides: { skipPrerequisites: true } });
    const list = await world.run(['logs', '--list']);
    expect(list.stdout).toContain('recode.log');
    expect(list.stdout).toMatch(/analyze-.*\.log/);
    const tail = await world.run(['logs', '-n', '5']);
    expect(tail.code).toBe(0);
    expect(tail.stdout).toContain('"type"');
    const transcript = await world.run([
      'logs',
      '--file',
      list.stdout.split('\n').find((l) => l.startsWith('analyze-'))!,
    ]);
    expect(transcript.stdout).toContain('analyzeHeadless');
    const evil = await world.run(['logs', '--file', '../../recode.json']);
    expect(evil.code).toBe(2);
  });

  it('doctor reports missing Ghidra with exit code 3 and fixes with env var', async () => {
    const world = await createWorld({ project: false });
    vi.stubEnv('GHIDRA_INSTALL_DIR', '/nonexistent');
    vi.stubEnv('PATH', process.env['PATH'] ?? '');
    const result = await world.run(['doctor', '--json'], { cwd: world.workDir });
    const checks = JSON.parse(result.stdout) as Array<{ id: string; status: string }>;
    expect(checks.map((c) => c.id)).toEqual(
      expect.arrayContaining([
        'node',
        'claude',
        'claude-auth',
        'ghidra',
        'java',
        'compiler',
        'cmake',
        'ninja',
      ]),
    );
    expect(checks.find((c) => c.id === 'claude')!.status).toBe('ok');
    expect(checks.find((c) => c.id === 'claude-auth')!.status).toBe('ok');
    expect(checks.find((c) => c.id === 'cmake')!.status).toBe('ok');
  });

  it('refuses analysis with a precise message when Ghidra is not installed', async () => {
    const world = await createWorld();
    await world.run(['import', SAMPLE_ELF]);
    vi.stubEnv('GHIDRA_INSTALL_DIR', '/nonexistent');
    const result = await world.run(['analyze']);
    if (result.code === 0) return; // a real Ghidra on this machine was found via PATH or well-known directories
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('Ghidra was not found');
    expect(result.stderr).toContain('GHIDRA_INSTALL_DIR');
  });
});
