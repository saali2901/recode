import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskStore } from '../../src/core/tasks/task-store.js';
import { Project } from '../../src/core/project/project.js';
import { SAMPLE_ELF } from '../helpers/tools.js';
import { createWorld, type World } from '../helpers/world.js';
import { registerTempCleanup } from '../helpers/tmp.js';

registerTempCleanup();
afterEach(() => vi.unstubAllEnvs());

const HERMETIC = { skipPrerequisites: true } as const;

async function importSample(world: World): Promise<string> {
  const result = await world.run(['import', SAMPLE_ELF]);
  expect(result.code, result.stderr).toBe(0);
  const project = await Project.open(world.projectDir);
  return project.binaries[0]!.id;
}

describe('complete workflow with fake Ghidra and mock Claude (real cmake/ninja/gcc)', () => {
  it('runs init → import → analyze → reconstruct → build → validate', async () => {
    const world = await createWorld();
    const id = await importSample(world);

    const analyze = await world.run(['analyze'], { overrides: HERMETIC });
    expect(analyze.code, analyze.stderr).toBe(0);
    const analysisDir = path.join(world.projectDir, 'analysis', id);
    for (const file of [
      'metadata.json',
      'functions.json',
      'references.json',
      'symbols.json',
      'types.json',
      'call-graph.json',
      'program.json',
    ]) {
      await expect(fs.stat(path.join(analysisDir, file))).resolves.toBeTruthy();
    }
    expect((await fs.readdir(path.join(analysisDir, 'decompiled'))).length).toBe(6);

    const reconstruct = await world.run(['reconstruct'], { overrides: HERMETIC });
    expect(reconstruct.code, reconstruct.stderr).toBe(0);
    expect(reconstruct.stdout).toContain('6 reconstructed');
    const sourceDir = path.join(world.projectDir, 'source', id);
    expect(await fs.readdir(path.join(sourceDir, 'src'))).toEqual(
      expect.arrayContaining([
        'add_ints.c',
        'multiply.c',
        'square.c',
        'shape_area.c',
        'sum_areas.c',
        'main.c',
      ]),
    );
    const typesHeader = await fs.readFile(
      path.join(sourceDir, 'include', 'recode_types.h'),
      'utf8',
    );
    expect(typesHeader).toContain('struct shape');
    const squareSource = await fs.readFile(path.join(sourceDir, 'src', 'square.c'), 'utf8');
    expect(squareSource).toContain('Overall confidence: probable');
    expect(squareSource).toContain('[certain] Mock reconstruction');
    expect(squareSource).toMatch(/ReCode reconstruction of square @ 0x[0-9a-f]+/);

    const build = await world.run(['build'], { overrides: HERMETIC });
    expect(build.code, build.stderr + build.stdout).toBe(0);
    const buildDir = path.join(world.projectDir, 'build', id);
    await expect(fs.stat(buildDir)).resolves.toBeTruthy();
    expect((await fs.readdir(buildDir)).some((f) => f.endsWith('.a'))).toBe(true);

    const validate = await world.run(['validate'], { overrides: HERMETIC });
    expect(validate.code, validate.stderr).toBe(0);
    expect(validate.stdout).toMatch(/compile.*passed/s);
    expect(validate.stdout).toMatch(/functional.*not-assessed/s);
    expect(validate.stdout).toContain('cannot prove');
    const report = JSON.parse(
      await fs.readFile(
        path.join(world.projectDir, 'reconstruction', id, 'validation.json'),
        'utf8',
      ),
    );
    expect(report.checks.find((c: { id: string }) => c.id === 'coverage').outcome).toBe('passed');
    expect(report.checks.find((c: { id: string }) => c.id === 'functional').outcome).toBe(
      'not-assessed',
    );

    const status = await world.run(['status', '--json']);
    const parsed = JSON.parse(status.stdout);
    expect(
      Object.values(parsed.binaries[0].steps).map((s) => (s as { status: string }).status),
    ).toEqual(Array(5).fill('completed'));
    expect(parsed.binaries[0].tasks).toMatchObject({ completed: 8, failed: 0 });
  });

  it('invokes Claude Code safely: stdin prompt, restricted tools, lead agent, callees first', async () => {
    const world = await createWorld();
    await importSample(world);
    await world.run(['analyze'], { overrides: HERMETIC });
    await world.run(
      [
        'reconstruct',
        '--batch-size',
        '2',
        '--parallel',
        '1',
        '--sessions',
        '1',
        '--dependencies',
        'complete',
      ],
      {
        overrides: HERMETIC,
      },
    );

    const calls = await world.claudeInvocations();
    // overview, types, then dependency waves: [add_ints, multiply] [square] [shape_area] [sum_areas] [main]
    expect(calls).toHaveLength(7);
    const agents = calls.map((c) => c.args[c.args.indexOf('--agent') + 1]);
    expect(agents).toEqual([
      'recode-binary-analyst',
      'recode-structure-analyst',
      ...Array(5).fill('recode-lead'),
    ]);

    for (const call of calls) {
      const tools = call.args[call.args.indexOf('--tools') + 1]!.split(',');
      expect(tools).not.toContain('Bash');
      expect(tools).not.toContain('WebFetch');
      expect(call.args[call.args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
      expect(call.args).toEqual(
        expect.arrayContaining([
          '--output-format',
          'stream-json',
          '--no-session-persistence',
          '--strict-mcp-config',
        ]),
      );
      const allowed = call.args[call.args.indexOf('--allowedTools') + 1]!;
      expect(allowed).toMatch(/Edit\(\/reconstruction\/[^/]+\/\*\*\)/);
      expect(allowed).not.toContain('Bash');
      expect(call.cwd).toContain('proj');
      expect(call.prompt).toContain('untrusted');
    }
    expect(calls[2]!.prompt).toContain('at most 1 subagent');

    // Dependencies: add_ints and multiply (leaves) come before square, shape_area, sum_areas, main.
    const batchOf = (call: { prompt: string }) =>
      /Tasks in this batch: ([^.]+)\./.exec(call.prompt)![1]!.split(', ');
    const order = calls.slice(2).flatMap(batchOf);
    const project = await Project.open(world.projectDir);
    const functions = JSON.parse(
      await fs.readFile(
        path.join(project.analysisDir(project.binaries[0]!.id), 'functions.json'),
        'utf8',
      ),
    ).functions as Array<{ name: string; address: string }>;
    const nameOf = (taskId: string) =>
      functions.find((f) => `fn_${f.address.slice(2).padStart(8, '0')}` === taskId)!.name;
    const names = order.map(nameOf);
    expect(names.indexOf('multiply')).toBeLessThan(names.indexOf('square'));
    expect(names.indexOf('square')).toBeLessThan(names.indexOf('shape_area'));
    expect(names.indexOf('shape_area')).toBeLessThan(names.indexOf('sum_areas'));
    expect(names.indexOf('sum_areas')).toBeLessThan(names.indexOf('main'));

    // The prompt never embeds binary-derived content; only file references.
    expect(calls.every((c) => !c.prompt.includes('MOCK decompiler output'))).toBe(true);
  });

  it('is idempotent: completed steps are skipped without calling the tools again', async () => {
    const world = await createWorld();
    await importSample(world);
    await world.run(['run'], { overrides: HERMETIC });
    const ghidraCalls = (await fs.readFile(world.ghidraLog, 'utf8')).trim().split('\n').length;
    const claudeCalls = (await world.claudeInvocations()).length;

    const again = await world.run(['run'], { overrides: HERMETIC });
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout.match(/up to date, skipped/g)?.length).toBeGreaterThanOrEqual(4);
    expect((await fs.readFile(world.ghidraLog, 'utf8')).trim().split('\n').length).toBe(
      ghidraCalls,
    );
    expect((await world.claudeInvocations()).length).toBe(claudeCalls);

    const forced = await world.run(['analyze', '--force'], { overrides: HERMETIC });
    expect(forced.code).toBe(0);
    expect((await fs.readFile(world.ghidraLog, 'utf8')).trim().split('\n').length).toBe(
      ghidraCalls + 1,
    );
  });

  it('retries a function whose result file is missing or invalid, then succeeds', async () => {
    const world = await createWorld();
    await importSample(world);
    await world.run(['analyze'], { overrides: HERMETIC });
    world.setEnv('MOCK_CLAUDE_MODE', 'badjson:square');
    const result = await world.run(['reconstruct'], { overrides: HERMETIC });
    expect(result.code, result.stderr).toBe(0);
    const project = await Project.open(world.projectDir);
    const store = new TaskStore(project.tasksFile(project.binaries[0]!.id));
    await store.load();
    const square = store.tasks.find((t) => t.title.startsWith('square'))!;
    expect(square).toMatchObject({ status: 'completed', attempts: 2 });
    expect(result.stdout).toContain('✗');
  });

  it('records failed tasks, finishes with the rest and supports --retry-failed', async () => {
    const world = await createWorld();
    await importSample(world);
    await world.run(['analyze'], { overrides: HERMETIC });
    world.setEnv('MOCK_CLAUDE_MODE', 'wrong-address');
    const first = await world.run(['reconstruct'], { overrides: HERMETIC });
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toContain('5 reconstructed');
    expect(first.stdout + first.stderr).toContain('address mismatch');

    world.setEnv('MOCK_CLAUDE_MODE', 'ok');
    const retry = await world.run(['reconstruct', '--retry-failed'], { overrides: HERMETIC });
    expect(retry.code, retry.stderr).toBe(0);
    expect(retry.stdout).toContain('6 reconstructed');
  });

  it('fails clearly when Claude Code crashes, keeps state, and resumes later', async () => {
    const world = await createWorld();
    await importSample(world);
    await world.run(['analyze'], { overrides: HERMETIC });
    world.setEnv('MOCK_CLAUDE_MODE', 'crash');
    const crashed = await world.run(['reconstruct'], { overrides: HERMETIC });
    expect(crashed.code).toBe(5);
    expect(crashed.stderr).toContain('No function could be reconstructed');
    const status = JSON.parse((await world.run(['status', '--json'])).stdout);
    expect(status.binaries[0].steps.reconstruct.status).toBe('failed');

    world.setEnv('MOCK_CLAUDE_MODE', 'ok');
    const resumed = await world.run(['reconstruct', '--retry-failed'], { overrides: HERMETIC });
    expect(resumed.code, resumed.stderr).toBe(0);
  });

  it('resumes after a hard crash that left steps and tasks in "running"', async () => {
    const world = await createWorld();
    const id = await importSample(world);
    await world.run(['analyze'], { overrides: HERMETIC });
    await world.run(['reconstruct'], { overrides: HERMETIC });

    const project = await Project.open(world.projectDir);
    const wfFile = project.workflowFile(id);
    const wf = JSON.parse(await fs.readFile(wfFile, 'utf8'));
    wf.steps.reconstruct = { status: 'running', attempts: 1 };
    wf.steps.build = { status: 'pending', attempts: 0 };
    await fs.writeFile(wfFile, JSON.stringify(wf));
    const taskFile = project.tasksFile(id);
    const tasks = JSON.parse(await fs.readFile(taskFile, 'utf8'));
    const square = tasks.tasks.find((t: { title: string }) => t.title.startsWith('square'));
    Object.assign(square, { status: 'running' });
    await fs.writeFile(taskFile, JSON.stringify(tasks));
    await fs.writeFile(project.paths.lock, '999999'); // stale lock of the dead process

    const before = (await world.claudeInvocations()).length;
    const resumed = await world.run(['reconstruct'], { overrides: HERMETIC });
    expect(resumed.code, resumed.stderr).toBe(0);
    // the interrupted function's accepted result is found in the persistent cache: no model call at all
    expect((await world.claudeInvocations()).length).toBe(before);
    const resumedTasks = JSON.parse(await fs.readFile(taskFile, 'utf8')).tasks;
    expect(resumedTasks.find((t: { title: string }) => t.title.startsWith('square'))).toMatchObject(
      {
        status: 'completed',
        fromCache: true,
      },
    );
    expect((await world.run(['build'], { overrides: HERMETIC })).code).toBe(0);
  });

  it('attributes compiler errors to the responsible function and repairs it on request', async () => {
    const world = await createWorld();
    await importSample(world);
    await world.run(['analyze'], { overrides: HERMETIC });
    // Without the per-function compile check the broken function only shows up in the project build.
    await world.run(['config', 'set', 'validation.compileCheck', 'off']);
    world.setEnv('MOCK_CLAUDE_MODE', 'break-multiply');
    expect((await world.run(['reconstruct'], { overrides: HERMETIC })).code).toBe(0);

    const failedBuild = await world.run(['build'], { overrides: HERMETIC });
    expect(failedBuild.code).toBe(5);
    expect(failedBuild.stderr).toContain('multiply.c');
    const project = await Project.open(world.projectDir);
    const id = project.binaries[0]!.id;
    const diagnostics = JSON.parse(
      await fs.readFile(path.join(project.buildDir(id), 'diagnostics.json'), 'utf8'),
    ).diagnostics;
    expect(diagnostics.find((d: { severity: string }) => d.severity === 'error')).toMatchObject({
      file: expect.stringContaining('multiply.c'),
      taskId: expect.stringMatching(/^fn_/),
    });

    const validateBroken = await world.run(['validate'], { overrides: HERMETIC });
    expect(validateBroken.code).toBe(1);
    expect(validateBroken.stderr).toContain('requires "build"');

    const repaired = await world.run(['reconstruct', '--repair'], { overrides: HERMETIC });
    expect(repaired.code, repaired.stderr).toBe(0);
    const repairCall = (await world.claudeInvocations()).at(-1)!;
    expect(repairCall.prompt).toContain('Tasks in this batch');
    const batchFiles = await fs.readdir(path.join(project.reconstructionDir(id), 'batches'));
    const lastBatch = JSON.parse(
      await fs.readFile(
        path.join(project.reconstructionDir(id), 'batches', batchFiles.sort().at(-1)!),
        'utf8',
      ),
    );
    expect(lastBatch.tasks).toHaveLength(1);
    expect(lastBatch.tasks[0].repairContext).toContain('error');
    expect(lastBatch.tasks[0].previousResultFile).toContain('results/fn_');

    expect((await world.run(['build'], { overrides: HERMETIC })).code).toBe(0);
  });

  it('runs the optional AI review through the validation agent', async () => {
    const world = await createWorld();
    await importSample(world);
    await world.run(['run'], { overrides: HERMETIC });
    const review = await world.run(['validate', '--ai-review'], { overrides: HERMETIC });
    // The mock does not write review files, so the review must be reported as incomplete, not invented.
    expect(review.stdout).toContain('AI review: 0/6 reviews written');
    const calls = await world.claudeInvocations();
    expect(calls.at(-1)!.args[calls.at(-1)!.args.indexOf('--agent') + 1]).toBe(
      'recode-validation-agent',
    );
  });

  it('cancels cleanly on Ctrl+C: exit 130, children stopped, state saved, resumable', async () => {
    const world = await createWorld();
    await importSample(world);
    await world.run(['analyze'], { overrides: HERMETIC });
    world.setEnv('MOCK_CLAUDE_MODE', 'hang');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 2500);
    const cancelled = await world.run(['reconstruct'], {
      overrides: HERMETIC,
      signal: controller.signal,
    });
    expect(cancelled.code).toBe(130);
    expect(cancelled.stderr).toContain('cancelled');

    const status = JSON.parse((await world.run(['status', '--json'])).stdout);
    expect(status.binaries[0].steps.reconstruct.status).toBe('cancelled');
    expect(status.binaries[0].tasks.running).toBe(0);
    await expect(fs.stat(path.join(world.projectDir, '.recode', 'lock'))).rejects.toThrow();

    world.setEnv('MOCK_CLAUDE_MODE', 'ok');
    const resumed = await world.run(['reconstruct'], { overrides: HERMETIC });
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(resumed.stdout).toContain('6 reconstructed');
  });

  it('stops at once when the Claude usage limit is reached, without using up attempts, and resumes later', async () => {
    const world = await createWorld();
    const id = await importSample(world);
    await world.run(['analyze'], { overrides: HERMETIC });
    world.setEnv('MOCK_CLAUDE_MODE', 'ratelimit');
    const limited = await world.run(['reconstruct'], { overrides: HERMETIC });
    expect(limited.code).toBe(5);
    expect(limited.stderr).toContain('usage limit reached');
    expect(limited.stderr).toContain('5-hour limit');
    expect(limited.stderr).toContain('no attempts were used up');
    expect(await world.claudeInvocations()).toHaveLength(1); // no pointless retries

    const project = await Project.open(world.projectDir);
    const store = new TaskStore(project.tasksFile(id));
    await store.load();
    expect(store.get('overview')).toMatchObject({ status: 'pending', attempts: 0 });

    world.setEnv('MOCK_CLAUDE_MODE', 'ok');
    const resumed = await world.run(['reconstruct'], { overrides: HERMETIC });
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(resumed.stdout).toContain('6 reconstructed');
  });

  it('explains an untrusted project folder, and "recode trust" fixes it without clobbering Claude settings', async () => {
    const world = await createWorld();
    const claudeDir = path.join(world.root, 'claude-config');
    await fs.mkdir(claudeDir);
    await fs.writeFile(
      path.join(claudeDir, '.claude.json'),
      JSON.stringify({
        theme: 'dark',
        projects: { '/other': { hasTrustDialogAccepted: true, extra: 1 } },
      }),
    );
    world.setEnv('CLAUDE_CONFIG_DIR', claudeDir);
    await importSample(world);
    await world.run(['analyze'], { overrides: HERMETIC });

    world.setEnv('MOCK_CLAUDE_MODE', 'untrusted');
    const blocked = await world.run(['reconstruct'], { overrides: HERMETIC });
    expect(blocked.code).toBe(3);
    expect(blocked.stderr).toContain('does not trust this project folder');
    expect(blocked.stderr).toContain('recode trust');
    expect(await world.claudeInvocations()).toHaveLength(1);

    const trusted = await world.run(['trust']);
    expect(trusted.code, trusted.stderr).toBe(0);
    const config = JSON.parse(await fs.readFile(path.join(claudeDir, '.claude.json'), 'utf8'));
    expect(config.theme).toBe('dark');
    expect(config.projects['/other']).toEqual({ hasTrustDialogAccepted: true, extra: 1 });
    expect(config.projects[path.resolve(world.projectDir)]).toEqual({
      hasTrustDialogAccepted: true,
    });
    expect((await world.run(['trust'])).stdout).toContain('already trusted');

    // A corrupt Claude config is never overwritten.
    await fs.writeFile(path.join(claudeDir, '.claude.json'), '{broken');
    const refused = await world.run(['trust']);
    expect(refused.code).not.toBe(0);
    expect(await fs.readFile(path.join(claudeDir, '.claude.json'), 'utf8')).toBe('{broken');
  });

  it('keeps the tool restrictions on the command line even if project settings are ignored', async () => {
    const world = await createWorld();
    await importSample(world);
    await world.run(['analyze'], { overrides: HERMETIC });
    await world.run(['reconstruct'], { overrides: HERMETIC });
    const [first] = await world.claudeInvocations();
    const denied = first!.args[first!.args.indexOf('--disallowedTools') + 1]!;
    expect(denied.split(',')).toEqual(
      expect.arrayContaining(['Bash', 'WebFetch', 'Edit(/analysis/**)', 'Edit(/source/**)']),
    );
  });
});
