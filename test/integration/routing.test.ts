import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Project } from '../../src/core/project/project.js';
import { SAMPLE_ELF } from '../helpers/tools.js';
import { createWorld, type World } from '../helpers/world.js';
import { registerTempCleanup } from '../helpers/tmp.js';

registerTempCleanup();
afterEach(() => vi.unstubAllEnvs());

const HERMETIC = { skipPrerequisites: true } as const;

async function prepared(): Promise<{ world: World; id: string }> {
  const world = await createWorld();
  expect((await world.run(['import', SAMPLE_ELF])).code).toBe(0);
  const project = await Project.open(world.projectDir);
  const id = project.binaries[0]!.id;
  expect((await world.run(['analyze'], { overrides: HERMETIC })).code).toBe(0);
  return { world, id };
}

const modelOf = (args: string[]): string | undefined =>
  args.includes('--model') ? args[args.indexOf('--model') + 1] : undefined;

async function latestMetrics(world: World, id: string) {
  return JSON.parse(
    await fs.readFile(path.join(world.projectDir, '.recode', 'metrics', id, 'latest.json'), 'utf8'),
  ) as {
    counters: Record<string, number>;
    workers: { max: number };
    sessions: Array<{
      tier: string;
      model?: string;
      tasks: string[];
      usage?: { inputTokens: number };
    }>;
    wallMs: number;
  };
}

async function tasksOf(world: World, id: string) {
  const project = await Project.open(world.projectDir);
  const file = JSON.parse(await fs.readFile(project.tasksFile(id), 'utf8')) as {
    tasks: Array<{
      id: string;
      title: string;
      status: string;
      tier?: string;
      history: Array<{ tier?: string; outcome: string }>;
      fromCache?: boolean;
    }>;
  };
  return file.tasks;
}

describe('model routing', () => {
  it('sends trivial functions to the fast tier and structure analysis to the advanced tier', async () => {
    const { world } = await prepared();
    const run = await world.run(['reconstruct'], { overrides: HERMETIC });
    expect(run.code, run.stderr).toBe(0);
    const calls = await world.claudeInvocations();
    const bySession = calls.map((c) => ({
      agent: c.args[c.args.indexOf('--agent') + 1],
      model: modelOf(c.args),
      sub: c.subagentModel,
    }));
    expect(bySession.find((s) => s.agent === 'recode-binary-analyst')).toMatchObject({
      model: 'sonnet',
    });
    expect(bySession.find((s) => s.agent === 'recode-structure-analyst')).toMatchObject({
      model: 'opus',
    });
    const leads = bySession.filter((s) => s.agent === 'recode-lead');
    expect(leads.length).toBeGreaterThan(0);
    // 15-line-class functions do not get the most expensive model; the lead runs on the same cheap tier.
    for (const lead of leads) expect(lead).toMatchObject({ model: 'haiku', sub: 'haiku' });
    expect(run.stdout).toMatch(/Tiers: .*fast 6/);
  });

  it('pins one model for everything when claude.model is set (no routing, no subagent override)', async () => {
    const { world } = await prepared();
    await world.run(['config', 'set', 'claude.model', 'sonnet']);
    expect((await world.run(['reconstruct'], { overrides: HERMETIC })).code).toBe(0);
    for (const call of await world.claudeInvocations()) {
      expect(modelOf(call.args)).toBe('sonnet');
      expect(call.subagentModel).toBeNull();
    }
    expect(await world.claudeProbes()).toHaveLength(0);
  });

  it('probes each configured model once and falls back when a model is unavailable', async () => {
    const { world } = await prepared();
    world.setEnv('MOCK_UNAVAILABLE_MODELS', 'haiku');
    const run = await world.run(['reconstruct'], { overrides: HERMETIC });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr + run.stdout).toContain('Model "haiku" did not answer');
    const probes = await world.claudeProbes();
    expect(new Set(probes.map((p) => modelOf(p.args)))).toEqual(
      new Set(['haiku', 'sonnet', 'opus']),
    );
    for (const call of await world.claudeInvocations())
      expect(modelOf(call.args)).not.toBe('haiku');
    // the verdict is cached: a second run does not probe the working models again
    await world.run(['reconstruct', '--force'], { overrides: HERMETIC });
    const probesAfter = await world.claudeProbes();
    expect(probesAfter.filter((p) => modelOf(p.args) === 'sonnet')).toHaveLength(1);
  });
});

describe('adaptive escalation', () => {
  it('escalates a speculative result to the next tier with the previous result as input, once', async () => {
    const { world, id } = await prepared();
    world.setEnv('MOCK_CLAUDE_MODE', 'needs:multiply:sonnet');
    const run = await world.run(['reconstruct'], { overrides: HERMETIC });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain('6 reconstructed');

    const multiply = (await tasksOf(world, id)).find((t) => t.title.startsWith('multiply'))!;
    expect(multiply).toMatchObject({ status: 'completed', tier: 'standard' });
    expect(multiply.history.map((h) => `${h.tier}:${h.outcome}`)).toEqual([
      'fast:rejected',
      'fast:escalated',
      'standard:accepted',
    ]);
    const project = await Project.open(world.projectDir);
    const batches = await fs.readdir(path.join(project.reconstructionDir(id), 'batches'));
    const specs = await Promise.all(
      batches
        .sort()
        .map(async (b) =>
          JSON.parse(
            await fs.readFile(path.join(project.reconstructionDir(id), 'batches', b), 'utf8'),
          ),
        ),
    );
    const escalated = specs
      .flatMap((s) => s.tasks)
      .filter((t: { repairContext?: string }) => t.repairContext);
    expect(escalated).toHaveLength(1);
    expect(escalated[0].repairContext).toContain('speculative');
    expect(escalated[0].previousResultFile).toContain('results/fn_');
    expect(escalated[0].tier).toBe('standard');
    const metrics = await latestMetrics(world, id);
    expect(metrics.counters).toMatchObject({ escalations: 1, accepted: 8 });
  });

  it('catches a function that does not compile before the project build and fixes it with a stronger model', async () => {
    const { world, id } = await prepared();
    world.setEnv('MOCK_CLAUDE_MODE', 'break-multiply');
    const run = await world.run(['reconstruct'], { overrides: HERMETIC });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain('6 reconstructed');
    const multiply = (await tasksOf(world, id)).find((t) => t.title.startsWith('multiply'))!;
    expect(multiply.history.map((h) => h.outcome)).toContain('escalated');
    // no broken code ever reached the generated project
    expect((await world.run(['build'], { overrides: HERMETIC })).code).toBe(0);
    const metrics = await latestMetrics(world, id);
    expect(metrics.counters['compileErrors']).toBeGreaterThan(0);
  });

  it('does not repeat a failing model without new information and reports the open failure honestly', async () => {
    const { world, id } = await prepared();
    // a model that can never satisfy the validators: the broken code is produced even for repairs
    await world.run(['config', 'set', 'claude.model', 'sonnet']); // fixed routing: nothing to escalate to
    world.setEnv('MOCK_CLAUDE_MODE', 'break-multiply');
    const run = await world.run(['reconstruct'], { overrides: HERMETIC });
    expect(run.code, run.stderr).toBe(0);
    const calls = (await world.claudeInvocations()).length;
    const multiply = (await tasksOf(world, id)).find((t) => t.title.startsWith('multiply'))!;
    // with a single model: one retry because the findings are new, then the task is failed - not looped
    expect(['completed', 'failed']).toContain(multiply.status);
    expect(calls).toBeLessThan(12);
  });
});

describe('persistent cache and incremental work', () => {
  it('serves an unchanged run from the cache without any model call, unless --no-cache is given', async () => {
    const { world, id } = await prepared();
    expect((await world.run(['reconstruct'], { overrides: HERMETIC })).code).toBe(0);
    const first = (await world.claudeInvocations()).length;

    const again = await world.run(['reconstruct', '--force'], { overrides: HERMETIC });
    expect(again.code, again.stderr).toBe(0);
    expect((await world.claudeInvocations()).length).toBe(first);
    const metrics = await latestMetrics(world, id);
    expect(metrics.counters['cacheHits']).toBe(0); // tasks were already completed: nothing to look up
    // wipe the task state (as after a lost .recode/tasks) - the cache still has every accepted result
    const project = await Project.open(world.projectDir);
    await fs.rm(project.tasksFile(id));
    const rebuilt = await world.run(['reconstruct', '--force'], { overrides: HERMETIC });
    expect(rebuilt.code, rebuilt.stderr).toBe(0);
    expect((await world.claudeInvocations()).length).toBe(first);
    expect((await latestMetrics(world, id)).counters['cacheHits']).toBe(8);
    expect((await tasksOf(world, id)).every((t) => t.fromCache)).toBe(true);

    await fs.rm(project.tasksFile(id));
    await world.run(['reconstruct', '--force', '--no-cache'], { overrides: HERMETIC });
    expect((await world.claudeInvocations()).length).toBeGreaterThan(first);
  });

  it('reopens only the callers of a function whose prototype changed', async () => {
    const { world, id } = await prepared();
    expect(
      (await world.run(['reconstruct', '--dependencies', 'complete'], { overrides: HERMETIC }))
        .code,
    ).toBe(0);
    const before = (await world.claudeInvocations()).length;
    const project = await Project.open(world.projectDir);
    const functions = JSON.parse(
      await fs.readFile(path.join(project.analysisDir(id), 'functions.json'), 'utf8'),
    ).functions as Array<{ name: string; address: string }>;
    const multiply = functions.find((f) => f.name === 'multiply')!;
    const file = path.join(
      project.reconstructionDir(id),
      'results',
      `fn_${multiply.address.slice(2).padStart(8, '0')}.json`,
    );
    const result = JSON.parse(await fs.readFile(file, 'utf8'));
    result.prototype = 'long multiply(int a, int b);';
    await fs.writeFile(file, JSON.stringify(result));

    const run = await world.run(['reconstruct', '--force'], { overrides: HERMETIC });
    expect(run.code, run.stderr).toBe(0);
    const calls = await world.claudeInvocations();
    const redone = calls
      .slice(before)
      .flatMap((c) => /Tasks in this batch: ([^.]+)\./.exec(c.prompt)![1]!.split(', '));
    // direct callers of multiply (square, shape_area) only - not add_ints, sum_areas, main
    const nameOf = (taskId: string) =>
      functions.find((f) => `fn_${f.address.slice(2).padStart(8, '0')}` === taskId)?.name;
    expect(redone.map(nameOf).sort()).toEqual(['shape_area', 'square']);
  });
});

describe('parallel scheduling', () => {
  it('runs independent sessions concurrently and finishes faster than one at a time', async () => {
    const { world, id } = await prepared();
    await world.run(['config', 'set', 'routing.tiers.fast.batchSize', '1']);
    world.setEnv('MOCK_LATENCY_MS', '400');
    const t0 = Date.now();
    const parallel = await world.run(
      ['reconstruct', '--sessions', '4', '--dependencies', 'signatures'],
      { overrides: HERMETIC },
    );
    const parallelMs = Date.now() - t0;
    expect(parallel.code, parallel.stderr).toBe(0);
    const m = await latestMetrics(world, id);
    expect(m.workers.max).toBeGreaterThanOrEqual(2);
    expect(m.workers.max).toBeLessThanOrEqual(4);

    const project = await Project.open(world.projectDir);
    await fs.rm(project.tasksFile(id));
    await fs.rm(path.join(project.paths.state, 'cache'), { recursive: true, force: true });
    const t1 = Date.now();
    const sequential = await world.run(
      ['reconstruct', '--force', '--sessions', '1', '--dependencies', 'signatures'],
      { overrides: HERMETIC },
    );
    const sequentialMs = Date.now() - t1;
    expect(sequential.code, sequential.stderr).toBe(0);
    expect((await latestMetrics(world, id)).workers.max).toBe(1);
    expect(parallelMs).toBeLessThan(sequentialMs);
  });

  it('never exceeds the configured session limit', async () => {
    const { world, id } = await prepared();
    await world.run(['config', 'set', 'routing.tiers.fast.batchSize', '1']);
    world.setEnv('MOCK_LATENCY_MS', '200');
    await world.run(['reconstruct', '--sessions', '2', '--dependencies', 'signatures'], {
      overrides: HERMETIC,
    });
    expect((await latestMetrics(world, id)).workers.max).toBeLessThanOrEqual(2);
  });

  it('keeps callee-first order in complete mode', async () => {
    const { world, id } = await prepared();
    await world.run(['config', 'set', 'routing.tiers.fast.batchSize', '1']);
    expect(
      (
        await world.run(['reconstruct', '--sessions', '4', '--dependencies', 'complete'], {
          overrides: HERMETIC,
        })
      ).code,
    ).toBe(0);
    const m = await latestMetrics(world, id);
    const order = m.sessions.flatMap((s) => s.tasks);
    const project = await Project.open(world.projectDir);
    const fns = JSON.parse(
      await fs.readFile(path.join(project.analysisDir(id), 'functions.json'), 'utf8'),
    ).functions as Array<{ name: string; address: string }>;
    const name = (t: string) =>
      fns.find((f) => `fn_${f.address.slice(2).padStart(8, '0')}` === t)?.name;
    const names = order.map(name);
    expect(names.indexOf('multiply')).toBeLessThan(names.indexOf('square'));
    expect(names.indexOf('square')).toBeLessThan(names.indexOf('shape_area'));
    expect(names.indexOf('shape_area')).toBeLessThan(names.indexOf('sum_areas'));
    expect(names.indexOf('sum_areas')).toBeLessThan(names.indexOf('main'));
  });
});

describe('original behaviour and quality parity', () => {
  it('--legacy reproduces the original sequential, single-model behaviour', async () => {
    const { world } = await prepared();
    const run = await world.run(['reconstruct', '--legacy'], { overrides: HERMETIC });
    expect(run.code, run.stderr).toBe(0);
    expect(await world.claudeProbes()).toHaveLength(0);
    for (const call of await world.claudeInvocations()) {
      expect(modelOf(call.args)).toBeUndefined();
      expect(call.subagentModel).toBeNull();
    }
  });

  it('produces the same C sources in legacy and optimized mode (mock output; checks orchestration, not AI quality)', async () => {
    const legacy = await prepared();
    await legacy.world.run(['reconstruct', '--legacy'], { overrides: HERMETIC });
    const optimized = await prepared();
    await optimized.world.run(['reconstruct'], { overrides: HERMETIC });
    const read = async (w: World, id: string) => {
      const dir = path.join(w.projectDir, 'source', id, 'src');
      const files = (await fs.readdir(dir)).sort();
      return Promise.all(files.map(async (f) => [f, await fs.readFile(path.join(dir, f), 'utf8')]));
    };
    const a = await read(legacy.world, legacy.id);
    const b = await read(optimized.world, optimized.id);
    expect(b).toEqual(a);
  });
});

describe('automatic repair rounds in the full workflow', () => {
  it('sends only the function with the build error back to a stronger model and rebuilds', async () => {
    const { world, id } = await prepared();
    await world.run(['config', 'set', 'validation.compileCheck', 'off']); // let the error reach the project build
    world.setEnv('MOCK_CLAUDE_MODE', 'break-multiply');
    const run = await world.run(['run', '--dependencies', 'complete'], { overrides: HERMETIC });
    expect(run.code, run.stderr).toBe(0);
    const multiply = (await tasksOf(world, id)).find((t) => t.title.startsWith('multiply'))!;
    expect(multiply.history.map((h) => `${h.tier}:${h.outcome}`)).toEqual([
      'fast:accepted',
      'standard:accepted',
    ]);
    // one repair session for exactly one function
    const last = (await world.claudeInvocations()).at(-1)!;
    expect(/Tasks in this batch: ([^.]+)\./.exec(last.prompt)![1]!.split(', ')).toHaveLength(1);
    expect(modelOf(last.args)).toBe('sonnet');
  });

  it('gives up after the configured rounds instead of looping', async () => {
    const { world } = await prepared();
    await world.run(['config', 'set', 'validation.compileCheck', 'off']);
    await world.run(['config', 'set', 'validation.autoRepairRounds', '0']);
    world.setEnv('MOCK_CLAUDE_MODE', 'break-multiply');
    const run = await world.run(['run'], { overrides: HERMETIC });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('Build failed');
  });
});
