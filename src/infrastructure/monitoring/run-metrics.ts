import path from 'node:path';
import { z } from 'zod';
import { pathExists, readJson, writeJsonAtomic } from '../filesystem/files.js';

const UsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
});

export const SessionRecordSchema = z.object({
  label: z.string(),
  agent: z.string(),
  tier: z.string(),
  model: z.string().optional(),
  resolvedModel: z.string().optional(),
  tasks: z.array(z.string()),
  startedAtMs: z.number(),
  durationMs: z.number(),
  /** Mean time the session's tasks were ready before the session started. */
  queueWaitMs: z.number(),
  workersAtStart: z.number().int(),
  ok: z.boolean(),
  failure: z.string().optional(),
  blocked: z.string().optional(),
  costUsd: z.number().optional(),
  turns: z.number().optional(),
  usage: UsageSchema.optional(),
});
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

export const RunMetricsSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  binaryId: z.string(),
  startedAt: z.string(),
  endedAt: z.string(),
  wallMs: z.number(),
  /** scheduler.mode of the run ("legacy" = the original sequential behaviour). */
  mode: z.string(),
  functionTasks: z.number(),
  counters: z.object({
    accepted: z.number(),
    rejected: z.number(),
    failedPermanently: z.number(),
    escalations: z.number(),
    retries: z.number(),
    cacheHits: z.number(),
    cacheMisses: z.number(),
    compileChecks: z.number(),
    compileErrors: z.number(),
    validatorErrors: z.number(),
    invalidated: z.number(),
    relaxedStarts: z.number(),
  }),
  workers: z.object({
    max: z.number(),
    /** Time-weighted mean number of sessions in flight while any session was running. */
    average: z.number(),
    /** Number of times the limiter lowered or raised the limit. */
    adjustments: z.number(),
  }),
  phases: z.record(z.string(), z.number()).default({}),
  planStats: z.record(z.string(), z.number()).default({}),
  sessions: z.array(SessionRecordSchema),
  notes: z.array(z.string()).default([]),
});
export type RunMetrics = z.infer<typeof RunMetricsSchema>;

/** Timing of the Ghidra step, written next to the run files by the analyze step. */
export const AnalysisTimingSchema = z.object({
  ghidraMs: z.number(),
  decompilerThreads: z.number(),
  functions: z.number(),
  decompiled: z.number(),
  failedFunctions: z.number(),
  toolVersion: z.string(),
});

export class MetricsCollector {
  readonly counters = {
    accepted: 0,
    rejected: 0,
    failedPermanently: 0,
    escalations: 0,
    retries: 0,
    cacheHits: 0,
    cacheMisses: 0,
    compileChecks: 0,
    compileErrors: 0,
    validatorErrors: 0,
    invalidated: 0,
    relaxedStarts: 0,
  };
  readonly sessions: SessionRecord[] = [];
  readonly phases: Record<string, number> = {};
  readonly planStats: Record<string, number> = {};
  readonly notes: string[] = [];
  private readonly started = performance.now();
  private readonly startedAt = new Date().toISOString();
  private inFlight = 0;
  private maxInFlight = 0;
  private lastTick = performance.now();
  private busyMs = 0;
  private weighted = 0;
  adjustments = 0;

  constructor(
    private readonly meta: {
      runId: string;
      binaryId: string;
      mode: string;
      functionTasks: number;
    },
  ) {}

  /** Call when a session starts (+1) or ends (-1) to keep the time-weighted worker average. */
  workerChange(delta: 1 | -1): void {
    const now = performance.now();
    if (this.inFlight > 0) {
      this.busyMs += now - this.lastTick;
      this.weighted += this.inFlight * (now - this.lastTick);
    }
    this.lastTick = now;
    this.inFlight += delta;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
  }

  async phase<T>(name: string, work: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    try {
      return await work();
    } finally {
      this.phases[name] = (this.phases[name] ?? 0) + Math.round(performance.now() - t0);
    }
  }

  snapshot(): RunMetrics {
    return {
      schemaVersion: 1,
      ...this.meta,
      startedAt: this.startedAt,
      endedAt: new Date().toISOString(),
      wallMs: Math.round(performance.now() - this.started),
      counters: { ...this.counters },
      workers: {
        max: this.maxInFlight,
        average: this.busyMs > 0 ? Math.round((this.weighted / this.busyMs) * 100) / 100 : 0,
        adjustments: this.adjustments,
      },
      phases: { ...this.phases },
      planStats: { ...this.planStats },
      sessions: [...this.sessions],
      notes: [...this.notes],
    };
  }

  async write(directory: string): Promise<RunMetrics> {
    const data = this.snapshot();
    await writeJsonAtomic(path.join(directory, `${data.runId}.json`), data);
    await writeJsonAtomic(path.join(directory, 'latest.json'), data);
    return data;
  }
}

export interface MetricsSummary {
  wallSeconds: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  perModel: Array<{
    tier: string;
    model: string;
    calls: number;
    seconds: number;
    inputTokens: number;
    outputTokens: number;
    failures: number;
  }>;
  meanSecondsPerFunctionTask: number;
  meanQueueWaitSeconds: number;
  cacheHitRate: number;
  workersMax: number;
  workersAverage: number;
  retries: number;
  escalations: number;
  accepted: number;
  failed: number;
  compileErrors: number;
}

export function summarize(run: RunMetrics): MetricsSummary {
  const perModel = new Map<string, MetricsSummary['perModel'][number]>();
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cost = 0;
  let tasks = 0;
  let sessionSeconds = 0;
  let waitMs = 0;
  for (const s of run.sessions) {
    const key = `${s.tier}|${s.model ?? 'default'}`;
    const row = perModel.get(key) ?? {
      tier: s.tier,
      model: s.model ?? 'default',
      calls: 0,
      seconds: 0,
      inputTokens: 0,
      outputTokens: 0,
      failures: 0,
    };
    row.calls++;
    row.seconds += s.durationMs / 1000;
    row.inputTokens += s.usage?.inputTokens ?? 0;
    row.outputTokens += s.usage?.outputTokens ?? 0;
    if (!s.ok) row.failures++;
    perModel.set(key, row);
    input += s.usage?.inputTokens ?? 0;
    output += s.usage?.outputTokens ?? 0;
    cacheRead += s.usage?.cacheReadTokens ?? 0;
    cost += s.costUsd ?? 0;
    tasks += s.tasks.length;
    sessionSeconds += s.durationMs / 1000;
    waitMs += s.queueWaitMs;
  }
  const lookups = run.counters.cacheHits + run.counters.cacheMisses;
  return {
    wallSeconds: run.wallMs / 1000,
    modelCalls: run.sessions.length,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    costUsd: cost,
    perModel: [...perModel.values()],
    meanSecondsPerFunctionTask: tasks > 0 ? sessionSeconds / tasks : 0,
    meanQueueWaitSeconds: run.sessions.length > 0 ? waitMs / run.sessions.length / 1000 : 0,
    cacheHitRate: lookups > 0 ? run.counters.cacheHits / lookups : 0,
    workersMax: run.workers.max,
    workersAverage: run.workers.average,
    retries: run.counters.retries,
    escalations: run.counters.escalations,
    accepted: run.counters.accepted,
    failed: run.counters.failedPermanently,
    compileErrors: run.counters.compileErrors,
  };
}

export async function loadRun(directory: string, name: string): Promise<RunMetrics | undefined> {
  const file = path.join(directory, name.endsWith('.json') ? name : `${name}.json`);
  return (await pathExists(file)) ? readJson(file, RunMetricsSchema) : undefined;
}

/** Plain-text comparison of two runs (e.g. the original sequential mode vs. the optimized scheduler). */
export function compareRuns(a: RunMetrics, b: RunMetrics): string[] {
  const x = summarize(a);
  const y = summarize(b);
  const row = (label: string, left: number, right: number, unit = '', digits = 1): string => {
    const delta =
      left === 0
        ? ''
        : ` (${right >= left ? '+' : ''}${(((right - left) / left) * 100).toFixed(0)}%)`;
    return `${label.padEnd(32)} ${left.toFixed(digits).padStart(10)}${unit}  ->  ${right.toFixed(digits).padStart(10)}${unit}${delta}`;
  };
  return [
    `A: ${a.runId} (${a.mode})   B: ${b.runId} (${b.mode})`,
    row('wall time', x.wallSeconds, y.wallSeconds, ' s'),
    row('model calls (sessions)', x.modelCalls, y.modelCalls, '', 0),
    row('input tokens', x.inputTokens, y.inputTokens, '', 0),
    row('output tokens', x.outputTokens, y.outputTokens, '', 0),
    row('cost (reported by Claude Code)', x.costUsd, y.costUsd, ' USD', 2),
    row(
      'mean seconds per function task',
      x.meanSecondsPerFunctionTask,
      y.meanSecondsPerFunctionTask,
      ' s',
    ),
    row('mean queue wait', x.meanQueueWaitSeconds, y.meanQueueWaitSeconds, ' s'),
    row('max concurrent sessions', x.workersMax, y.workersMax, '', 0),
    row('average concurrent sessions', x.workersAverage, y.workersAverage, '', 2),
    row('cache hit rate', x.cacheHitRate * 100, y.cacheHitRate * 100, ' %'),
    row('retries', x.retries, y.retries, '', 0),
    row('escalations', x.escalations, y.escalations, '', 0),
    row('functions accepted', x.accepted, y.accepted, '', 0),
    row('functions failed', x.failed, y.failed, '', 0),
    row('compile errors', x.compileErrors, y.compileErrors, '', 0),
  ];
}
