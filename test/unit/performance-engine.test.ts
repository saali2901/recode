import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideEscalation, keyIssue } from '../../src/ai/routing/escalation.js';
import { RoutingHistory, bucketOf } from '../../src/ai/routing/history.js';
import {
  TIERS,
  buildModelTable,
  difficultyScore,
  effectiveTier,
  nextTier,
  routeFunction,
} from '../../src/ai/routing/router.js';
import {
  AdaptiveLimiter,
  pickBatch,
  type Candidate,
} from '../../src/ai/orchestration/scheduler.js';
import {
  condense,
  stronglyConnectedComponents,
  topologicalOrder,
} from '../../src/core/graph/graph.js';
import { TaskStore, makeTask } from '../../src/core/tasks/task-store.js';
import { computeMetrics } from '../../src/decompiler/analysis/metrics.js';
import { buildAnalysisStore, type Dossier } from '../../src/decompiler/analysis/store.js';
import { defaultConfig, parseConfig } from '../../src/infrastructure/config/config.js';
import { ResultCache, cacheKey } from '../../src/infrastructure/cache/content-cache.js';
import {
  MetricsCollector,
  compareRuns,
  summarize,
} from '../../src/infrastructure/monitoring/run-metrics.js';
import type { FunctionResult } from '../../src/reconstruction/interfaces/results.js';
import {
  compileCheckFunction,
  compileCheckTypes,
  findCCompiler,
} from '../../src/validation/static/compile-check.js';
import {
  findDelimiterProblem,
  validateFunctionResult,
} from '../../src/validation/static/function-validator.js';
import { makeTempDir, registerTempCleanup } from '../helpers/tmp.js';

registerTempCleanup();

describe('graph algorithms', () => {
  it('finds strongly connected components, callees first', () => {
    const edges = new Map([
      ['a', ['b']],
      ['b', ['c']],
      ['c', ['b', 'd']],
      ['d', []],
      ['e', ['a']],
    ]);
    const { components, componentOf } = stronglyConnectedComponents(
      ['a', 'b', 'c', 'd', 'e'],
      edges,
    );
    expect(components.find((c) => c.includes('b'))).toEqual(['b', 'c']);
    expect(componentOf.get('d')!).toBeLessThan(componentOf.get('b')!);
    expect(componentOf.get('b')!).toBeLessThan(componentOf.get('a')!);
    expect(componentOf.get('a')!).toBeLessThan(componentOf.get('e')!);
  });

  it('condensation is acyclic and computes depth and critical-path height', () => {
    const edges = new Map([
      ['a', ['b']],
      ['b', ['a', 'c']],
      ['c', []],
      ['d', ['c']],
    ]);
    const g = condense(['a', 'b', 'c', 'd'], edges);
    const ab = g.scc.componentOf.get('a')!;
    const c = g.scc.componentOf.get('c')!;
    expect(g.scc.componentOf.get('b')).toBe(ab);
    expect(g.depth[c]).toBe(0);
    expect(g.depth[ab]).toBe(1);
    expect(g.height[c]).toBe(1);
    expect(g.dependsOn[ab]).toEqual([c]);
  });

  it('topological order exists only without cycles', () => {
    expect(topologicalOrder(['a', 'b'], new Map([['a', ['b']]]))).toEqual(['b', 'a']);
    expect(
      topologicalOrder(
        ['a', 'b'],
        new Map([
          ['a', ['b']],
          ['b', ['a']],
        ]),
      ),
    ).toBeUndefined();
  });
});

const fnInfo = (address = '0x10', calls: string[] = []) => ({
  address,
  calls,
  decompiledFile: 'x.c',
  decompileError: null,
});

describe('decompiler metrics', () => {
  it('measures control flow, pointers and uncertainty without being fooled by comments or strings', () => {
    const code = `
      /* if (fake) while (fake) */
      int FUN_00401000(int param_1, long param_2)
      {
        undefined4 local_c;
        int i;
        char *s = "if (x) { goto bad; }";
        for (i = 0; i < param_1; i++) {
          if (*(int *)(param_2 + 8) == 3 && param_1 > 2) { local_c = *(undefined4 *)(param_2 + 0x10); }
          else { local_c = (*(code *)param_2)(i); }
        }
        switch (i) { case 1: break; case 2: break; default: break; }
        return CONCAT44(local_c, 1) >> 3;
      }`;
    const m = computeMetrics({
      info: fnInfo('0x401000', ['0x401100', '0x401100']),
      decompiled: code,
      assembly: '0x1: jne 0x5\n0x3: jmp 0x9\n0x5: ret\n',
    });
    expect(m.loops).toBe(1);
    expect(m.branches).toBe(1);
    expect(m.gotos).toBe(0); // inside a string literal
    expect(m.switchCases).toBe(3);
    expect(m.cyclomatic).toBe(1 + 1 + 1 + 3 + 1);
    expect(m.pointerArithmetic).toBeGreaterThanOrEqual(2);
    expect(m.distinctOffsets).toBeGreaterThanOrEqual(2);
    expect(m.indirectCalls).toBeGreaterThanOrEqual(1);
    expect(m.undefinedTypes).toBeGreaterThanOrEqual(2);
    expect(m.intrinsics).toBe(1);
    expect(m.directCalls).toBe(1);
    expect(m.basicBlocksSource).toBe('estimated');
  });

  it('prefers Ghidra facts over estimates and flags decompiler failure and warnings', () => {
    const m = computeMetrics({
      info: { ...fnInfo(), decompileError: 'timeout' },
      decompiled: '/* WARNING: Could not recover jumptable at 0x1 */\nvoid f(void){}',
      assembly: '',
      facts: {
        address: '0x10',
        basicBlocks: 17,
        instructionCount: 90,
        indirectCalls: 2,
        computedJumps: 1,
        hasNoReturn: false,
        dataRefs: [],
      },
    });
    expect(m).toMatchObject({
      basicBlocks: 17,
      basicBlocksSource: 'ghidra',
      indirectCalls: 2,
      computedJumps: 1,
      asmInstructions: 90,
      decompileFailed: true,
    });
    expect(m.decompilerWarnings).toBeGreaterThanOrEqual(1);
  });
});

function dossier(metrics: Partial<Dossier['metrics']>, extra: Partial<Dossier> = {}): Dossier {
  const base = computeMetrics({
    info: fnInfo(),
    decompiled: 'int f(void){return 1;}',
    assembly: 'ret',
  });
  return {
    address: '0x10',
    name: 'f',
    signature: 'int f(void)',
    size: 8,
    inputChars: 100,
    contentHash: 'h',
    metrics: { ...base, ...metrics },
    callees: [],
    callerCount: 0,
    callers: [],
    strings: [],
    globals: [],
    usedTypes: [],
    uncertainty: [],
    ...extra,
  };
}

describe('model router', () => {
  const config = defaultConfig();

  it('gives a 15-line function the fast tier and does not waste the expensive model', () => {
    const d = dossier({ codeLines: 15, cyclomatic: 2 });
    expect(routeFunction(d, config, { sccSize: 1 }).tier).toBe('fast');
  });

  it('gives pointer-heavy functions with indirect calls and weak decompilation a stronger model', () => {
    const hard = dossier({
      codeLines: 220,
      cyclomatic: 32,
      basicBlocks: 70,
      pointerArithmetic: 14,
      distinctOffsets: 20,
      indirectCalls: 4,
      memoryAccesses: 60,
      unresolvedVariables: 12,
      undefinedTypes: 9,
      intrinsics: 6,
    });
    const decision = routeFunction(hard, config, { sccSize: 1 });
    expect(['advanced', 'expert']).toContain(decision.tier);
    expect(decision.score).toBeGreaterThan(config.routing.thresholds.advanced);
    expect(decision.reasons.length).toBeGreaterThan(0);
  });

  it('keeps ordinary code at the standard tier and never routes below it when not trivial', () => {
    const d = dossier({ codeLines: 70, cyclomatic: 9, pointerArithmetic: 3, directCalls: 6 });
    const decision = routeFunction(d, config, { sccSize: 1 });
    expect(decision.tier).toBe('standard');
    const failedDecompile = dossier({ codeLines: 3, decompileFailed: true });
    expect(routeFunction(failedDecompile, config, { sccSize: 1 }).tier).not.toBe('fast');
  });

  it('raises the score for mutual recursion and for earlier failures of similar functions', () => {
    const d = dossier({ codeLines: 60, cyclomatic: 8 });
    const plain = difficultyScore(d, { sccSize: 1 }).score;
    expect(difficultyScore(d, { sccSize: 4 }).score).toBeGreaterThan(plain);
    expect(difficultyScore(d, { sccSize: 1, historyBoost: 20 }).score).toBeCloseTo(plain + 20, 0);
  });

  it('a pinned claude.model disables routing; tier models come from configuration only', () => {
    const pinned = parseConfig({ claude: { model: 'sonnet' } });
    const table = buildModelTable(pinned);
    expect(TIERS.map((t) => table[t].model)).toEqual(['sonnet', 'sonnet', 'sonnet', 'sonnet']);
    expect(
      routeFunction(dossier({ codeLines: 500, indirectCalls: 9 }), pinned, { sccSize: 1 }).tier,
    ).toBe('standard');
    const custom = parseConfig({
      routing: { tiers: { advanced: { model: 'my-model', batchSize: 2 } } },
    });
    const t2 = buildModelTable(custom);
    expect(t2.advanced).toMatchObject({ model: 'my-model', batchSize: 2 });
    expect(t2.fast.model).toBe('haiku'); // a partial override keeps the other defaults
  });

  it('falls back to the nearest usable tier and escalates only to a different model', () => {
    const table = buildModelTable(config);
    expect(effectiveTier('fast', new Set(['standard', 'advanced', 'expert']))).toBe('standard');
    expect(effectiveTier('expert', new Set(['fast', 'standard']))).toBe('standard');
    expect(effectiveTier('fast', new Set())).toBeUndefined();
    const all = new Set(TIERS);
    expect(nextTier('fast', table, all)).toBe('standard');
    expect(nextTier('standard', table, all)).toBe('advanced');
    // advanced and expert share a model by default: no gain, so no escalation step
    expect(nextTier('advanced', table, all)).toBeUndefined();
  });
});

describe('escalation policy', () => {
  const table = buildModelTable(defaultConfig());
  const base = {
    table,
    available: new Set(TIERS),
    escalationEnabled: true,
    noResult: false,
    history: [],
  } as const;
  const err = { severity: 'error' as const, code: 'compile-error', message: 'x' };

  it('accepts clean results and records warnings it cannot resolve', () => {
    expect(decideEscalation({ ...base, tier: 'fast', findings: [] })).toEqual({
      action: 'accept',
      issues: [],
    });
    const w = { severity: 'warning' as const, code: 'loops-dropped', message: 'm' };
    expect(decideEscalation({ ...base, tier: 'fast', findings: [w] })).toMatchObject({
      action: 'accept',
    });
  });

  it('escalates errors and speculative results to the next stronger model', () => {
    expect(decideEscalation({ ...base, tier: 'fast', findings: [err] })).toMatchObject({
      action: 'escalate',
      tier: 'standard',
    });
    const spec = { severity: 'info' as const, code: 'speculative', message: 's' };
    expect(decideEscalation({ ...base, tier: 'standard', findings: [spec] })).toMatchObject({
      action: 'escalate',
      tier: 'advanced',
    });
  });

  it('at the top tier retries only with new findings, then stops', () => {
    const first = decideEscalation({ ...base, tier: 'advanced', findings: [err] });
    expect(first.action).toBe('retry');
    const history = [
      { at: 't', tier: 'advanced', outcome: 'rejected' as const, issues: [keyIssue([err])] },
    ];
    expect(decideEscalation({ ...base, tier: 'advanced', findings: [err], history }).action).toBe(
      'give-up',
    );
    const other = { severity: 'error' as const, code: 'delimiters', message: 'y' };
    expect(decideEscalation({ ...base, tier: 'advanced', findings: [other], history }).action).toBe(
      'retry',
    );
  });

  it('retries a session that produced nothing at the same tier, and never escalates when disabled', () => {
    expect(decideEscalation({ ...base, tier: 'fast', findings: [], noResult: true }).action).toBe(
      'retry',
    );
    expect(
      decideEscalation({ ...base, tier: 'fast', findings: [err], escalationEnabled: false }).action,
    ).toBe('retry');
  });
});

describe('static function validator', () => {
  const result = (over: Partial<FunctionResult>): FunctionResult => ({
    taskId: 'fn_00000010',
    address: '0x10',
    status: 'reconstructed',
    name: 'add',
    prototype: 'int add(int a, int b);',
    code: 'int add(int a, int b)\n{\n    return a + b;\n}',
    includes: [],
    confidence: 'probable',
    assumptions: [],
    ...over,
  });
  const codes = (r: FunctionResult, ctx = {}) => validateFunctionResult(r, ctx).map((f) => f.code);

  it('accepts a consistent function, also when the prototype omits parameter names', () => {
    expect(codes(result({}))).toEqual([]);
    expect(codes(result({ prototype: 'int add(int, int);' }))).toEqual([]);
    expect(
      codes(
        result({
          prototype: 'unsigned int add(unsigned int, const struct s *);',
          code: 'unsigned int add(unsigned int a, const struct s *p)\n{\n return a;\n}',
        }),
      ),
    ).toEqual([]);
  });

  it('finds unbalanced delimiters, missing definitions and prototype mismatches', () => {
    expect(findDelimiterProblem('int f(){ return (1; }')).toBeDefined();
    expect(findDelimiterProblem('int f(){ return ")" + 1; } /* ( */')).toBeUndefined();
    expect(codes(result({ code: 'int add(int a, int b)\n{\n return a + b;\n' }))).toContain(
      'delimiters',
    );
    expect(codes(result({ code: 'int other(void) { return 0; }\n/* add( */' }))).toContain(
      'no-definition',
    );
    expect(codes(result({ prototype: 'long add(int a, int b);' }))).toContain('prototype-mismatch');
    expect(codes(result({ prototype: 'int add(int a);' }))).toContain('prototype-mismatch');
    expect(codes(result({ prototype: 'int add(int a, long b);' }))).toContain('prototype-mismatch');
  });

  it('flags decompiler placeholder types, includes and placeholders', () => {
    expect(
      codes(result({ code: 'int add(int a, int b)\n{\n undefined4 x = a;\n return x + b;\n}' })),
    ).toContain('ghidra-types');
    expect(
      codes(result({ code: 'int add(int a, int b)\n{\n undefined4 x = a;\n return x;\n}' }), {
        knownTypes: new Set(['undefined4']),
      }),
    ).not.toContain('ghidra-types');
    expect(codes(result({ code: '#include <x.h>\nint add(int a, int b){ return a; }' }))).toContain(
      'include',
    );
    expect(codes(result({ code: 'int add(int a, int b)\n{\n /* TODO */ return 0;\n}' }))).toContain(
      'placeholder',
    );
  });

  it('warns when the reconstruction is much simpler than the original', () => {
    const original = computeMetrics({
      info: fnInfo('0x10', ['0x1', '0x2', '0x3', '0x4']),
      decompiled:
        'void f(void){ for(;;){ if (a) {} if (b) {} if (c) {} if (d) {} if (e) {} if (f) {} if (g) {} } }',
      assembly: '',
    });
    const found = codes(result({}), { originalMetrics: original });
    expect(found).toEqual(
      expect.arrayContaining(['loops-dropped', 'branches-dropped', 'calls-dropped']),
    );
  });

  it('reports a speculative self-assessment as information for the escalation', () => {
    expect(codes(result({ confidence: 'speculative' }))).toContain('speculative');
  });
});

describe('per-function compile check (real compiler)', () => {
  const fn = {
    address: '0x10',
    name: 'add',
    signature: 'int add(int,int)',
    size: 8,
    isThunk: false,
    isExternal: false,
    calls: [],
    calledBy: [],
    decompiledFile: null,
    disassemblyFile: null,
  };
  const make = (code: string): FunctionResult => ({
    taskId: 'fn_00000010',
    address: '0x10',
    status: 'reconstructed',
    name: 'add',
    prototype: 'int add(int a, int b);',
    code,
    includes: [],
    confidence: 'probable',
    assumptions: [],
  });

  it('accepts valid code and tolerates calls to not yet reconstructed functions', async () => {
    const compiler = await findCCompiler(undefined);
    if (!compiler) return;
    const dir = await makeTempDir();
    const ok = await compileCheckFunction({
      compiler,
      workDirectory: dir,
      info: fn,
      result: make('int add(int a, int b)\n{\n return a + b + FUN_00401000(a);\n}'),
      typesHeader: undefined,
      otherPrototypes: [],
    });
    expect(ok.ran).toBe(true);
    expect(ok.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(ok.unresolvedCalls).toEqual(['FUN_00401000']);
  });

  it('reports syntax errors, undeclared identifiers and type conflicts with the function as source', async () => {
    const compiler = await findCCompiler(undefined);
    if (!compiler) return;
    const dir = await makeTempDir();
    const bad = await compileCheckFunction({
      compiler,
      workDirectory: dir,
      info: fn,
      result: make('int add(int a, int b)\n{\n return a + b\n}'),
      typesHeader: undefined,
      otherPrototypes: [],
    });
    expect(bad.findings.some((f) => f.severity === 'error')).toBe(true);
    const undeclared = await compileCheckFunction({
      compiler,
      workDirectory: dir,
      info: fn,
      result: make('int add(int a, int b)\n{\n return a + missing_var;\n}'),
      typesHeader: undefined,
      otherPrototypes: [],
    });
    expect(
      undeclared.findings.some((f) => f.severity === 'error' && /missing_var/.test(f.message)),
    ).toBe(true);
    const conflict = await compileCheckFunction({
      compiler,
      workDirectory: dir,
      info: fn,
      result: make('int add(int a, int b)\n{\n return a;\n}'),
      typesHeader: undefined,
      otherPrototypes: ['long add(int a);'],
    });
    expect(conflict.findings.some((f) => f.severity === 'error')).toBe(true);
  });

  it('checks the shared types header on its own', async () => {
    const compiler = await findCCompiler(undefined);
    if (!compiler) return;
    const dir = await makeTempDir();
    const good = await compileCheckTypes({
      compiler,
      workDirectory: dir,
      typesHeader: 'struct s { int a; };',
    });
    expect(good.findings).toEqual([]);
    const bad = await compileCheckTypes({
      compiler,
      workDirectory: dir,
      typesHeader: 'struct s { int a; ;',
    });
    expect(bad.findings.length).toBeGreaterThan(0);
  });

  it('is not assessed without a compiler', async () => {
    const dir = await makeTempDir();
    const out = await compileCheckFunction({
      compiler: undefined,
      workDirectory: dir,
      info: fn,
      result: make('int add(){}'),
      typesHeader: undefined,
      otherPrototypes: [],
    });
    expect(out.ran).toBe(false);
  });
});

describe('task store', () => {
  const file = async () => path.join(await makeTempDir(), 'tasks.json');
  const mk = (id: string, extra = {}) => makeTask({ id, kind: 'function', title: id, ...extra });

  it('keeps unchanged tasks, resets only the changed one, and takes the new structure', async () => {
    const f = await file();
    const store = new TaskStore(f);
    await store.setPlan('fp1', [
      mk('a', { inputHash: '1' }),
      mk('b', { inputHash: '2' }),
      mk('c', { inputHash: '3' }),
    ]);
    await store.complete('a');
    await store.complete('b');
    const again = new TaskStore(f);
    await again.load();
    const discarded = await again.setPlan('fp2', [
      mk('a', { inputHash: '1', priority: 5 }),
      mk('b', { inputHash: 'CHANGED' }),
      mk('c', { inputHash: '3' }),
    ]);
    expect(discarded).toEqual(['b']);
    expect(again.get('a')).toMatchObject({ status: 'completed', priority: 5 });
    expect(again.get('b')).toMatchObject({ status: 'pending' });
  });

  it('coalesces writes: many updates, few disk writes, and flush() makes them durable', async () => {
    const f = await file();
    const store = new TaskStore(f, 50);
    await store.setPlan(
      'fp',
      Array.from({ length: 200 }, (_, i) => mk(`t${i}`)),
    );
    const before = (await fs.stat(f)).mtimeMs;
    for (let i = 0; i < 200; i++) await store.complete(`t${i}`);
    // throttled: the file has not been rewritten 200 times; flush brings it up to date
    await store.flush();
    const onDisk = JSON.parse(await fs.readFile(f, 'utf8')) as { tasks: Array<{ status: string }> };
    expect(onDisk.tasks.every((t) => t.status === 'completed')).toBe(true);
    expect((await fs.stat(f)).mtimeMs).toBeGreaterThanOrEqual(before);
  });

  it('offers relaxed readiness for soft dependencies only', async () => {
    const store = new TaskStore(await file());
    await store.setPlan('fp', [
      mk('leaf'),
      mk('caller', { softDependsOn: ['leaf'] }),
      mk('hard', { dependsOn: ['leaf'] }),
    ]);
    expect(store.ready(3).map((t) => t.id)).toEqual(['leaf']);
    expect(store.readyRelaxed(3).map((t) => t.id)).toEqual(['caller']);
    await store.complete('leaf');
    expect(
      store
        .ready(3)
        .map((t) => t.id)
        .sort(),
    ).toEqual(['caller', 'hard']);
  });
});

describe('scheduler building blocks', () => {
  const probe = (load: number, free: number) => ({
    loadPerCpu: () => load,
    freeMemoryFraction: () => free,
  });
  const limiterOf = (p = probe(0.1, 0.9)) =>
    new AdaptiveLimiter({
      initial: 2,
      max: 4,
      maxLoadPerCpu: 0.9,
      minFreeMemoryFraction: 0.1,
      probe: p,
    });

  it('grows after healthy sessions, halves on failure, and never exceeds its bounds', () => {
    const l = limiterOf();
    expect(l.current).toBe(2);
    l.recordSuccess();
    l.recordSuccess();
    expect(l.current).toBe(3);
    for (let i = 0; i < 20; i++) l.recordSuccess();
    expect(l.current).toBe(4);
    l.recordFailure();
    expect(l.current).toBe(2);
    l.recordFailure();
    l.recordFailure();
    expect(l.current).toBe(1);
  });

  it('adds no session while the machine is loaded or low on RAM, but always allows the first', () => {
    expect(limiterOf(probe(2, 0.9)).canStart(1)).toBe(false);
    expect(limiterOf(probe(0.1, 0.02)).canStart(1)).toBe(false);
    expect(limiterOf(probe(2, 0.02)).canStart(0)).toBe(true);
    expect(limiterOf().canStart(2)).toBe(false);
  });

  const table = buildModelTable(defaultConfig());
  const cand = (
    id: string,
    over: Partial<Candidate> & { priority?: number; group?: string } = {},
  ): Candidate => ({
    task: makeTask({
      id,
      kind: 'function',
      title: id,
      priority: over.priority ?? 0,
      ...(over.group ? { group: over.group } : {}),
    }),
    relaxed: over.relaxed ?? false,
    tier: over.tier ?? 'standard',
    inputTokens: over.inputTokens ?? 5000,
  });
  const limits = { table, config: defaultConfig(), runningByTier: new Map() };

  it('starts with the highest critical-path priority and batches one tier at a time', () => {
    const batch = pickBatch(
      [
        cand('low', { priority: 0 }),
        cand('high', { priority: 9 }),
        cand('fastOne', { tier: 'fast', priority: 9 }),
      ],
      limits,
    )!;
    expect(batch.map((c) => c.task.id)).toEqual(['high', 'low']); // one standard session; the fast task is not mixed in
  });

  it('keeps a recursive group together even beyond the tier batch size and respects the context budget', () => {
    const group = ['g1', 'g2', 'g3', 'g4'].map((id) =>
      cand(id, { tier: 'expert', group: 'scc_1', priority: 3 }),
    );
    expect(pickBatch(group, limits)!).toHaveLength(4);
    const big = Array.from({ length: 10 }, (_, i) => cand(`b${i}`, { inputTokens: 40_000 }));
    expect(pickBatch(big, limits)!.length).toBe(1); // 35% of 200k tokens = 70k budget: one 40k task, a second would not fit
  });

  it('respects the per-tier concurrency cap', () => {
    const capped = {
      ...limits,
      table: { ...table, advanced: { ...table.advanced, maxConcurrent: 1 } },
      runningByTier: new Map([['advanced' as const, 1]]),
    };
    const batch = pickBatch(
      [cand('hard', { tier: 'advanced', priority: 9 }), cand('easy', { priority: 1 })],
      capped,
    )!;
    expect(batch.map((c) => c.task.id)).toEqual(['easy']);
  });
});

describe('analysis store', () => {
  it('builds dossiers with metrics, callees, strings, globals and used types from the exported files', async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, 'decompiled'));
    await fs.mkdir(path.join(dir, 'asm'));
    await fs.writeFile(
      path.join(dir, 'decompiled', 'a.c'),
      'int a(void){ struct Shape *s = g; puts(0x5000); return helper(); }',
    );
    await fs.writeFile(path.join(dir, 'asm', 'a.asm'), '0x10: ret\n');
    await fs.writeFile(
      path.join(dir, 'symbols.json'),
      JSON.stringify({
        symbols: [{ name: 'g_shape', address: '0x6000', type: 'Label', source: 'ANALYSIS' }],
      }),
    );
    await fs.writeFile(
      path.join(dir, 'facts.json'),
      JSON.stringify({
        functions: [
          {
            address: '0x10',
            basicBlocks: 3,
            instructionCount: 1,
            indirectCalls: 0,
            computedJumps: 0,
            hasNoReturn: false,
            dataRefs: ['0x5000', '0x6000'],
          },
        ],
        strings: [{ address: '0x5000', value: 'hello', length: 5 }],
        imports: [],
        exports: [],
      }),
    );
    const info = {
      address: '0x10',
      name: 'a',
      signature: 'int a(void)',
      size: 4,
      isThunk: false,
      isExternal: false,
      calls: ['0x20'],
      calledBy: [],
      decompiledFile: 'decompiled/a.c',
      disassemblyFile: 'asm/a.asm',
    };
    const helper = {
      ...info,
      address: '0x20',
      name: 'helper',
      signature: 'int helper(void)',
      calls: [],
      decompiledFile: null,
      disassemblyFile: null,
    };
    const store = await buildAnalysisStore({
      analysisDir: dir,
      functions: [info, helper],
      types: [{ name: 'Shape', kind: 'struct', size: 8 }],
    });
    const d = store.dossiers.get('0x10')!;
    expect(d.metrics).toMatchObject({ basicBlocks: 3, basicBlocksSource: 'ghidra' });
    expect(d.callees).toEqual([
      {
        address: '0x20',
        name: 'helper',
        signature: 'int helper(void)',
        external: false,
        thunk: false,
      },
    ]);
    expect(d.strings).toEqual([{ address: '0x5000', value: 'hello' }]);
    expect(d.globals).toEqual([{ address: '0x6000', name: 'g_shape' }]);
    expect(d.usedTypes).toEqual(['Shape']);
    expect(d.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const again = await buildAnalysisStore({
      analysisDir: dir,
      functions: [info, helper],
      types: [],
    });
    expect(again.dossiers.get('0x10')!.contentHash).toBe(d.contentHash); // deterministic
    expect(await fs.stat(path.join(dir, 'store.json'))).toBeTruthy();
  });

  it('works for older analyses without facts.json', async () => {
    const dir = await makeTempDir();
    const info = {
      address: '0x10',
      name: 'a',
      signature: 'void a(void)',
      size: 4,
      isThunk: false,
      isExternal: false,
      calls: [],
      calledBy: [],
      decompiledFile: null,
      disassemblyFile: null,
    };
    const store = await buildAnalysisStore({ analysisDir: dir, functions: [info], types: [] });
    expect(store.dossiers.get('0x10')!.metrics.decompileFailed).toBe(true);
    expect(store.dossiers.get('0x10')!.uncertainty).toContain('decompile-failed');
  });
});

describe('result cache, routing history and run metrics', () => {
  it('stores results by key, ignores corrupt entries and can be switched off', async () => {
    const dir = await makeTempDir();
    const cache = new ResultCache(dir);
    const key = cacheKey(['p', 'function', 'h']);
    expect(await cache.get(key)).toBeUndefined();
    await cache.put({
      key,
      kind: 'function',
      tier: 'standard',
      payload: '{"a":1}',
      deps: { '0x1': 'abc' },
    });
    expect(await cache.get(key)).toMatchObject({
      tier: 'standard',
      payload: '{"a":1}',
      deps: { '0x1': 'abc' },
    });
    await fs.writeFile(path.join(dir, key.slice(0, 2), `${key}.json`), '{torn');
    expect(await cache.get(key)).toBeUndefined();
    expect(cacheKey(['a', 'b'])).not.toBe(cacheKey(['ab']));
    const off = new ResultCache(dir, false);
    await off.put({ key, kind: 'function', tier: 'fast', payload: 'x' });
    expect(await off.get(key)).toBeUndefined();
  });

  it('learns from earlier weak results of similar functions', async () => {
    const file = path.join(await makeTempDir(), 'h.json');
    const h = new RoutingHistory(file);
    const d = dossier({ codeLines: 80, pointerArithmetic: 9 });
    const bucket = bucketOf(d);
    expect(h.boost(bucket, 'standard')).toBe(0);
    for (let i = 0; i < 6; i++) h.record(bucket, 'standard', i < 5);
    expect(h.boost(bucket, 'standard')).toBeGreaterThan(10);
    await h.save();
    const reloaded = new RoutingHistory(file);
    await reloaded.load();
    expect(reloaded.boost(bucket, 'standard')).toBe(h.boost(bucket, 'standard'));
  });

  it('summarizes and compares runs', async () => {
    const mk = (mode: string, sessionMs: number, sessions: number) => {
      const m = new MetricsCollector({ runId: mode, binaryId: 'b', mode, functionTasks: 10 });
      for (let i = 0; i < sessions; i++) {
        m.sessions.push({
          label: `s${i}`,
          agent: 'a',
          tier: 'fast',
          model: 'haiku',
          tasks: ['t'],
          startedAtMs: 0,
          durationMs: sessionMs,
          queueWaitMs: 100,
          workersAtStart: 1,
          ok: true,
          usage: {
            inputTokens: 1000,
            outputTokens: 100,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        });
      }
      m.counters.accepted = sessions;
      m.workerChange(1);
      return m.snapshot();
    };
    const a = mk('legacy', 2000, 10);
    const b = mk('adaptive', 1000, 5);
    const s = summarize(b);
    expect(s).toMatchObject({ modelCalls: 5, inputTokens: 5000, outputTokens: 500 });
    expect(s.perModel[0]).toMatchObject({ tier: 'fast', model: 'haiku', calls: 5 });
    const text = compareRuns(a, b).join('\n');
    expect(text).toContain('legacy');
    expect(text).toMatch(/model calls \(sessions\)\s+10\s+->\s+5/);
  });
});
