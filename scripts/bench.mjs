#!/usr/bin/env node
// Reproducible orchestration benchmark. Runs the reconstruction loop of a built ReCode (dist directory)
// against a deterministic synthetic binary with an in-process fake session runner. No Ghidra, no Claude.
// It measures ReCode's own scheduling/persistence overhead and the effect of simulated session latency;
// it says NOTHING about the quality of AI output.
//
// Usage: node scripts/bench.mjs <dist-dir> [--functions N] [--latency-ms MS] [--seed S] [--shape layered|chain|wide|cycles] [--legacy] [--compile] [--json]
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const dist = path.resolve(argv[0] ?? 'dist');
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const N = Number(opt('functions', '1000'));
const latencyMs = Number(opt('latency-ms', '0'));
const seed = Number(opt('seed', '1'));
const shape = opt('shape', 'layered');
const legacy = argv.includes('--legacy');
const asJson = argv.includes('--json');
const withCompile = argv.includes('--compile');

const imp = (rel) => import(pathToFileURL(path.join(dist, rel)).href);
const { Project } = await imp('core/project/project.js');
const { reconstruct } = await imp('ai/orchestration/reconstruct.js');
const { defaultConfig, parseConfig } = await imp('infrastructure/config/config.js');
const { EventBus } = await imp('core/events/event-bus.js');

function rng(s) {
  let x = s >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0x100000000;
  };
}
const hex = (n) => `0x${n.toString(16)}`;

/** Deterministic synthetic call graph. Function i may call functions with a larger index (callees first order). */
function buildGraph(n, kind, random) {
  const calls = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    if (kind === 'chain') {
      if (i + 1 < n) calls[i].push(i + 1);
    } else if (kind === 'wide') {
      if (i === 0) for (let j = 1; j < n; j++) calls[0].push(j);
    } else {
      const fan = 1 + Math.floor(random() * 3);
      for (let k = 0; k < fan; k++) {
        const span = kind === 'layered' ? Math.min(n - i - 1, 40) : n - i - 1;
        if (span > 0) calls[i].push(i + 1 + Math.floor(random() * span));
      }
      if (kind === 'cycles' && i > 5 && random() < 0.05)
        calls[i].push(i - 1 - Math.floor(random() * 5));
    }
    calls[i] = [...new Set(calls[i])];
  }
  return calls;
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'recode-bench-'));
const project = await Project.create(path.join(root, 'proj'), 'bench');
const binary = {
  id: 'bench',
  fileName: 'bench.bin',
  sha256: '0'.repeat(64),
  metadata: { format: 'elf', architecture: 'x86_64' },
};
const random = rng(seed);
const calls = buildGraph(N, shape, random);
const addr = (i) => hex(0x401000 + i * 0x40);
const dir = project.analysisDir(binary.id);
await fs.mkdir(path.join(dir, 'decompiled'), { recursive: true });
await fs.mkdir(path.join(dir, 'asm'), { recursive: true });
const calledBy = Array.from({ length: N }, () => []);
calls.forEach((list, i) => list.forEach((j) => calledBy[j].push(addr(i))));
const functions = [];
for (let i = 0; i < N; i++) {
  const stem = `function_${(0x401000 + i * 0x40).toString(16).padStart(8, '0')}`;
  const lines = 8 + Math.floor(random() * 60);
  const body = [`int FUN_${stem}(int param_1, long param_2)`, '{', '  int local_c;'];
  for (let l = 0; l < lines; l++) {
    body.push(
      random() < 0.2
        ? `  if (param_1 < ${l}) { local_c = *(int *)(param_2 + ${l * 4}); }`
        : `  local_c = param_1 + ${l};`,
    );
  }
  for (const j of calls[i]) body.push(`  local_c = FUN_${addr(j)}(local_c, param_2);`);
  body.push('  return local_c;', '}');
  await fs.writeFile(path.join(dir, 'decompiled', `${stem}.c`), body.join('\n'));
  await fs.writeFile(path.join(dir, 'asm', `${stem}.asm`), `${addr(i)}: nop\n`);
  functions.push({
    address: addr(i),
    name: `FUN_${addr(i).slice(2)}`,
    signature: 'int FUN(int, long)',
    size: 16 + lines * 4,
    isThunk: false,
    isExternal: false,
    calls: calls[i].map(addr),
    calledBy: calledBy[i],
    decompiledFile: `decompiled/${stem}.c`,
    disassemblyFile: `asm/${stem}.asm`,
  });
}
await fs.writeFile(path.join(dir, 'functions.json'), JSON.stringify({ functions }));
for (const [f, v] of [
  ['references.json', { references: [] }],
  ['symbols.json', { symbols: [] }],
  ['types.json', { types: [] }],
  ['call-graph.json', { edges: [] }],
])
  await fs.writeFile(path.join(dir, f), JSON.stringify(v));

let sessionsRun = 0;
let inFlight = 0;
let maxInFlight = 0;
let simulated = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runSession = async (request) => {
  sessionsRun++;
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  try {
    if (latencyMs > 0) {
      simulated += latencyMs;
      await sleep(latencyMs);
    }
    for (const task of request.spec.tasks) {
      const out = path.join(project.root, task.resultFile);
      await fs.mkdir(path.dirname(out), { recursive: true });
      if (task.kind === 'overview')
        await fs.writeFile(out, '# Overview\n\nSynthetic benchmark overview text.\n');
      else if (task.kind === 'types')
        await fs.writeFile(
          out,
          JSON.stringify({ taskId: 'types', header: '/* none */', items: [], assumptions: [] }),
        );
      else {
        const name = `fn_${task.address.slice(2)}`;
        await fs.writeFile(
          out,
          JSON.stringify({
            taskId: task.taskId,
            address: task.address,
            status: 'reconstructed',
            name,
            prototype: `int ${name}(int a, long b);`,
            code: `int ${name}(int a, long b)\n{\n    return a + (int)b;\n}`,
            includes: [],
            confidence: 'probable',
            assumptions: [],
          }),
        );
      }
    }
    return {
      ok: true,
      sessionId: 's',
      resultText: 'ok',
      costUsd: 0,
      turns: 1,
      subagentsStarted: [],
      unknownEventTypes: [],
      failure: undefined,
      blocked: undefined,
      raw: {},
    };
  } finally {
    inFlight--;
  }
};

const config = parseConfig({
  claude: { batchSize: 6 },
  ...(legacy ? { scheduler: { mode: 'legacy' } } : {}),
});
const t0 = performance.now();
const rssBefore = process.memoryUsage().rss;
const summary = await reconstruct(
  {
    project,
    binary,
    config: config ?? defaultConfig(),
    events: new EventBus(),
    runSession,
    // Newer builds only; the original ignores these. Probing and per-function compiles are measured separately.
    modelProbe: false,
    compiler: withCompile ? undefined : null,
  },
  {},
);
const wallMs = performance.now() - t0;
const rssAfter = process.memoryUsage().rss;
const result = {
  dist,
  shape,
  functions: N,
  latencyMs,
  legacy,
  wallMs: Math.round(wallMs),
  sessions: sessionsRun,
  maxConcurrentSessions: maxInFlight,
  orchestrationOverheadMs: Math.round(
    wallMs - (maxInFlight <= 1 ? simulated : simulated / Math.max(1, maxInFlight)),
  ),
  completed: summary.counts.completed,
  failed: summary.counts.failed,
  reconstructed: summary.generation.reconstructed,
  rssGrowthMiB: Math.round((rssAfter - rssBefore) / 1048576),
};
if (summary.metricsFile) {
  const run = JSON.parse(await fs.readFile(path.join(project.root, summary.metricsFile), 'utf8'));
  result.phasesMs = run.phases;
}
await fs.rm(root, { recursive: true, force: true });
if (asJson) console.log(JSON.stringify(result));
else console.table([result]);
