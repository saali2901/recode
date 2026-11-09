import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluate } from '../../scripts/skill-guard.mjs';
import { runCli } from '../../src/cli/cli.js';
import { createDefaultRegistry } from '../../src/input/adapters/registry.js';
import { defaultConfig } from '../../src/infrastructure/config/config.js';
import { Writable } from 'node:stream';

const root = path.resolve('.');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');
const skill = read('.claude/skills/recode-maintainer/SKILL.md');
const readme = read('README.md');

function section(text: string, heading: RegExp): string {
  const start = text.search(heading);
  if (start < 0) return '';
  const rest = text.slice(start).replace(/^.*\n/, '');
  const end = rest.search(/^## /m);
  return end < 0 ? rest : rest.slice(0, end);
}

async function cliCommands(): Promise<string[]> {
  let out = '';
  const sink = new Writable({
    write(chunk, _enc, cb) {
      out += String(chunk);
      cb();
    },
  });
  await runCli(['--help'], { streams: { stdout: sink, stderr: sink }, interactive: false });
  const block = out.split('Commands:')[1] ?? '';
  return block
    .split('\n')
    .map((l) => /^ {2}(\w[\w-]*)/.exec(l)?.[1])
    .filter((name): name is string => Boolean(name) && name !== 'help');
}

describe('skill and README stay in sync with the code', () => {
  it('has a valid skill definition', () => {
    expect(skill).toMatch(/^---\nname: recode-maintainer\ndescription: .{40,}\n---\n/);
  });

  it('tracks the package version', () => {
    const version = (JSON.parse(read('package.json')) as { version: string }).version;
    expect(skill).toContain(`Skill tracks ReCode version: ${version}`);
  });

  it('lists exactly the commands the CLI registers', async () => {
    const listed = [...section(skill, /^## Commands/m).matchAll(/^- `recode (\w+)`/gm)]
      .map((m) => m[1])
      .sort();
    expect(listed).toEqual((await cliCommands()).sort());
  });

  it('lists exactly the input adapters that are registered', () => {
    const line = /\*\*Input adapters:\*\* ([\w, ]+?) \(/.exec(skill)?.[1] ?? '';
    const documented = line
      .split(',')
      .map((s) => s.trim())
      .sort();
    const registered = createDefaultRegistry(defaultConfig().archive)
      .list()
      .map((a) => a.id)
      .sort();
    expect(documented).toEqual(registered);
  });

  it('maps every source directory and no directory that does not exist', () => {
    const dirs = fs
      .readdirSync(path.join(root, 'src'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => `src/${e.name}`);
    const mapped = [
      ...section(skill, /^## Project map/m).matchAll(/^- `((?:src\/\w+)|web\/|templates\/)/gm),
    ].map((m) => m[1] ?? '');
    for (const dir of dirs)
      expect(mapped, `${dir} is missing from the project map in SKILL.md`).toContain(dir);
    for (const entry of mapped)
      expect(fs.existsSync(path.join(root, entry)), `${entry} does not exist`).toBe(true);
  });

  it('has a dated change log with the newest entry first', () => {
    const dates = [
      ...section(skill, /^## Change log/m).matchAll(/^- (\d{4}-\d{2}-\d{2}) - /gm),
    ].map((m) => m[1] ?? '');
    expect(dates.length).toBeGreaterThan(0);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it('keeps the README short: only the agreed sections, no CLI workflow documentation', () => {
    const headings = [...readme.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual(['Installation', 'Start', 'Commands', 'Supported files', 'License']);
    for (const forbidden of [
      'init',
      'import',
      'inspect',
      'analyze',
      'reconstruct',
      'build',
      'validate',
      'run',
      'status',
      'logs',
      'config',
    ]) {
      expect(readme, `README must not document "recode ${forbidden}"`).not.toMatch(
        new RegExp(`recode ${forbidden}\\b`),
      );
    }
  });

  it('README commands exist and the installers it names exist', async () => {
    const real = await cliCommands();
    const documented = [...section(readme, /^## Commands/m).matchAll(/`recode (\w+)/g)].map(
      (m) => m[1] ?? '',
    );
    expect(documented.length).toBeGreaterThan(0);
    for (const name of documented) expect(real).toContain(name);
    for (const file of ['install.sh', 'install.ps1']) {
      expect(readme).toContain(file);
      expect(fs.existsSync(path.join(root, file))).toBe(true);
    }
  });

  it('README names every supported input format', () => {
    const supported = section(readme, /^## Supported files/m);
    for (const format of ['ELF', 'PE', 'Mach-O', 'COFF', 'GameCube', 'Raw', 'ZIP'])
      expect(supported).toContain(format);
  });
});

describe('skill-guard', () => {
  const SKILL = '.claude/skills/recode-maintainer/SKILL.md';
  it('passes when nothing relevant changed', () => {
    expect(evaluate([])).toEqual([]);
    expect(evaluate(['docs/architecture.md', 'src/core/x.test.ts', 'test/unit/y.test.ts'])).toEqual(
      [],
    );
  });

  it('demands a skill update for code changes', () => {
    expect(evaluate(['src/core/project/project.ts'])[0]).toContain('skill');
    expect(evaluate(['web/src/App.tsx', 'package.json'])).toHaveLength(1);
    expect(evaluate(['src/core/project/project.ts', SKILL])).toEqual([]);
  });

  it('demands a README update only for user-facing changes', () => {
    expect(evaluate(['install.sh', SKILL])[0]).toContain('README.md');
    expect(evaluate(['src/input/adapters/elf-adapter.ts', SKILL])[0]).toContain('README.md');
    expect(evaluate(['src/cli/commands/ui.ts', SKILL])[0]).toContain('README.md');
    expect(evaluate(['src/cli/commands/inspect.ts', SKILL])).toEqual([]);
    expect(evaluate(['install.sh', SKILL, 'README.md'])).toEqual([]);
  });
});

describe('skill-guard as a hook (real git repository)', () => {
  const script = path.resolve('scripts/skill-guard.mjs');

  function repo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, '.claude/skills/recode-maintainer'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(dir, '.claude/skills/recode-maintainer/SKILL.md'), 'skill\n');
    fs.writeFileSync(path.join(dir, 'README.md'), 'readme\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    git('checkout', '-q', '-b', 'feature');
    return dir;
  }

  const run = (
    dir: string,
    args: string[] = [],
    stdin = '{}',
    env: Record<string, string> = {},
  ) => {
    const result = spawnSync('node', [script, ...args], {
      cwd: dir,
      input: stdin,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  };

  it('lets a clean repository end its turn', () => {
    const dir = repo();
    expect(run(dir)).toMatchObject({ code: 0, stdout: '' });
  });

  it('blocks the end of a turn while code changed without a skill update, then allows it', () => {
    const dir = repo();
    fs.appendFileSync(path.join(dir, 'src/a.ts'), 'export const b = 2;\n');
    const blocked = run(dir);
    expect(blocked.code).toBe(0);
    const decision = JSON.parse(blocked.stdout) as { decision: string; reason: string };
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('SKILL.md');

    expect(run(dir, [], JSON.stringify({ stop_hook_active: true })).stdout).toBe(''); // never loops
    expect(run(dir, [], '{}', { SKIP_SKILL_GUARD: '1' }).stdout).toBe('');

    fs.appendFileSync(path.join(dir, '.claude/skills/recode-maintainer/SKILL.md'), 'updated\n');
    expect(run(dir).stdout).toBe('');
  });

  it('still notices the change after it was committed on the branch', () => {
    const dir = repo();
    fs.appendFileSync(path.join(dir, 'src/a.ts'), 'export const b = 2;\n');
    execFileSync('git', ['commit', '-qam', 'change'], { cwd: dir });
    expect(JSON.parse(run(dir).stdout).decision).toBe('block');
  });

  it('works as a pre-commit check on staged files', () => {
    const dir = repo();
    fs.appendFileSync(path.join(dir, 'src/a.ts'), 'export const b = 2;\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    const refused = run(dir, ['--staged']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('SKILL.md');
    fs.appendFileSync(path.join(dir, '.claude/skills/recode-maintainer/SKILL.md'), 'updated\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    expect(run(dir, ['--staged']).code).toBe(0);
  });
});
