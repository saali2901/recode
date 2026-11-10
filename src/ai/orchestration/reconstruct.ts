import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { RecodeError, errorMessage } from '../../core/errors/index.js';
import type { EventBus } from '../../core/events/event-bus.js';
import type { BinaryRecord, Project } from '../../core/project/project.js';
import { TaskStore, type Task } from '../../core/tasks/task-store.js';
import { buildAnalysisStore, type Dossier } from '../../decompiler/analysis/store.js';
import { loadFunctions, loadTypes } from '../../decompiler/extraction/analysis-files.js';
import type { FunctionInfo, TypeInfo } from '../../decompiler/interfaces/schemas.js';
import { mapLimit } from '../../infrastructure/concurrency.js';
import { ResultCache, cacheKey } from '../../infrastructure/cache/content-cache.js';
import type { RecodeConfig } from '../../infrastructure/config/config.js';
import { assetPath } from '../../infrastructure/filesystem/assets.js';
import {
  pathExists,
  readJson,
  sha256Text,
  writeFileAtomic,
  writeJsonAtomic,
} from '../../infrastructure/filesystem/files.js';
import { MetricsCollector } from '../../infrastructure/monitoring/run-metrics.js';
import { CTargetLanguage, functionTaskId } from '../../reconstruction/c/c-generator.js';
import {
  FunctionResultSchema,
  TypesResultSchema,
  type FunctionResult,
  type TypesResult,
} from '../../reconstruction/interfaces/results.js';
import type { GenerationReport } from '../../reconstruction/interfaces/target-language.js';
import {
  compileCheckFunction,
  compileCheckTypes,
  findCCompiler,
} from '../../validation/static/compile-check.js';
import {
  formatFindings,
  hasErrors,
  validateFunctionResult,
  type Finding,
} from '../../validation/static/function-validator.js';
import type { BlockReason, ClaudeRunResult } from '../claude/runner.js';
import { probeModels, type ProbeRunner } from '../routing/availability.js';
import { decideEscalation, keyIssue } from '../routing/escalation.js';
import { RoutingHistory, bucketOf } from '../routing/history.js';
import {
  TIERS,
  buildModelTable,
  difficultyScore,
  effectiveTier,
  isFixedRouting,
  nextTier,
  routeFunction,
  routeKind,
  tierIndex,
  type Availability,
  type RouteDecision,
  type Tier,
} from '../routing/router.js';
import {
  leadPrompt,
  specialistPrompt,
  type BatchSpec,
  type BatchTask,
} from '../prompts/prompts.js';
import {
  calleeViews,
  promptFingerprint,
  protoHash,
  writeTaskContext,
  type CalleeView,
} from './context.js';
import { planTasks } from './planner.js';
import {
  AdaptiveLimiter,
  pickBatch,
  tierOfTask,
  type Candidate,
  type ResourceProbe,
} from './scheduler.js';
import { writeBatchFile, type SessionRunner } from './session.js';

export interface ReconstructOptions {
  /** Re-queue tasks whose generated code failed to compile, with the compiler diagnostics. */
  repair?: boolean;
  /** Give permanently failed tasks a fresh set of attempts. */
  retryFailed?: boolean;
  /** Ignore the persistent result cache for this run (it is still written). */
  noCache?: boolean;
}

export interface ReconstructSummary {
  counts: Record<Task['status'], number>;
  generation: GenerationReport;
  sessions: number;
  totalCostUsd: number;
  excluded: number;
  failedTasks: Array<{ id: string; error: string }>;
  /** Results accepted although validators still had findings (never hidden). */
  openIssues: Array<{ id: string; issues: string[] }>;
  routing: {
    /** Function tasks per tier at the end of the run. */
    tiers: Record<string, number>;
    escalations: number;
    retries: number;
    cacheHits: number;
    relaxedStarts: number;
    invalidated: number;
    maxConcurrentSessions: number;
    modelWarnings: string[];
  };
  /** Project-relative path of the metrics file of this run. */
  metricsFile: string | undefined;
}

export interface ReconstructDeps {
  project: Project;
  binary: BinaryRecord;
  config: RecodeConfig;
  events: EventBus;
  runSession: SessionRunner;
  signal?: AbortSignal | undefined;
  /** Injectable for tests. */
  resourceProbe?: ResourceProbe | undefined;
  /** Injectable for tests: how models are probed. `false` skips probing. */
  modelProbe?: ProbeRunner | false | undefined;
  /** Injectable for tests: C compiler for the per-function check; `null` disables the check. */
  compiler?: string | null | undefined;
  metrics?: MetricsCollector | undefined;
}

const DiagnosticsFileSchema = z.object({
  diagnostics: z.array(
    z.object({
      file: z.string(),
      line: z.number().int(),
      severity: z.string(),
      message: z.string(),
      taskId: z.string().optional(),
    }),
  ),
});

/** Codes that mean "this may be a simplified or wrong reconstruction": such results are not cached as clean. */
const SUSPICIOUS = new Set([
  'placeholder',
  'loops-dropped',
  'branches-dropped',
  'calls-dropped',
  'speculative',
  'many-speculative-assumptions',
]);

/** Runs (or resumes) the AI reconstruction and regenerates the C project from accepted results. */
export async function reconstruct(
  deps: ReconstructDeps,
  options: ReconstructOptions = {},
): Promise<ReconstructSummary> {
  const { project, binary, events } = deps;
  const legacy = deps.config.scheduler.mode === 'legacy';
  // "legacy" reproduces the original behaviour: one session at a time, one model, no routing, caching or checks.
  const config: RecodeConfig = legacy
    ? {
        ...deps.config,
        routing: { ...deps.config.routing, mode: 'fixed', escalation: false, verifyModels: false },
        scheduler: { ...deps.config.scheduler, maxSessions: 1, initialSessions: 1 },
      }
    : deps.config;
  const advanced = !legacy;
  const maxAttempts = config.claude.maxAttempts;
  const analysisDir = project.analysisDir(binary.id);
  const runId = new Date().toISOString().replace(/[:.]/g, '-');

  const functions = await loadFunctions(analysisDir);
  const byAddress = new Map(functions.map((f) => [f.address, f]));
  const byTaskId = new Map(functions.map((f) => [functionTaskId(f.address), f]));
  const typeInfos = advanced ? await loadTypes(analysisDir) : [];
  const typesByName: ReadonlyMap<string, TypeInfo> = new Map(typeInfos.map((t) => [t.name, t]));

  const metrics =
    deps.metrics ??
    new MetricsCollector({
      runId,
      binaryId: binary.id,
      mode: config.scheduler.mode,
      functionTasks: functions.length,
    });
  const dossiers = advanced
    ? await metrics.phase('analysis-store', () =>
        buildAnalysisStore({ analysisDir, functions, types: typeInfos }),
      )
    : undefined;
  const dossierOf = (address: string | undefined): Dossier | undefined =>
    address ? dossiers?.dossiers.get(address) : undefined;

  const plan = metrics.phase('plan', async () =>
    planTasks(functions, {
      mode: config.scheduler.mode,
      maxGroupSize: config.scheduler.maxGroupSize,
      inputHashes: new Map(
        [...(dossiers?.dossiers.values() ?? [])].map((d) => [d.address, d.contentHash]),
      ),
    }),
  );
  const planned = await plan;
  Object.assign(metrics.planStats, planned.stats);

  const store = new TaskStore(project.tasksFile(binary.id), 400);
  await store.load();
  const fingerprint = sha256Text(
    JSON.stringify(functions.map((f) => [f.address, f.name, f.size, f.calls, f.decompiledFile])),
  );
  const discarded = await store.setPlan(fingerprint, planned.tasks);
  if (discarded.length > 0) {
    metrics.counters.invalidated += discarded.length;
    events.emit({
      type: 'info',
      message: `${discarded.length} task(s) restart because their function changed; the other tasks keep their results.`,
    });
  }

  if (options.retryFailed) {
    for (const task of store.tasks.filter((t) => t.status === 'failed'))
      await store.reopen(task.id);
  }
  if (options.repair) await queueRepairs(project, binary, store, events);

  const results = new ResultBook(project, binary.id);
  await results.loadAccepted(store);
  if (advanced) await invalidateStaleCallers(store, results, byTaskId, metrics, events);

  // ---- routing -------------------------------------------------------------------------------------------
  const table = buildModelTable(config);
  const fixed = isFixedRouting(config);
  const routingHistory = new RoutingHistory(path.join(project.paths.state, 'routing-history.json'));
  if (advanced && !fixed) await routingHistory.load();
  let available: Availability = new Set(TIERS);
  const modelWarnings: string[] = [];
  if (advanced && !fixed && deps.modelProbe !== false && store.queuedCount(maxAttempts) > 0) {
    const probed = await metrics.phase('model-probe', () =>
      probeModels({
        project,
        config,
        ...(deps.modelProbe ? { run: deps.modelProbe } : {}),
        signal: deps.signal,
      }),
    );
    available = probed.available;
    for (const warning of probed.warnings) {
      modelWarnings.push(warning);
      events.emit({ type: 'warning', message: warning });
    }
  }
  const decisions = new Map<string, RouteDecision>();
  const sccSizes = new Map<string, number>();
  for (const t of planned.tasks) {
    if (t.group) sccSizes.set(t.group, (sccSizes.get(t.group) ?? 0) + 1);
  }
  for (const task of store.tasks) {
    if (task.status === 'completed') continue;
    const wanted = routeTask(task);
    const tier = effectiveTier(wanted, available) ?? 'standard';
    await store.update(task.id, { tier, routeReasons: decisions.get(task.id)?.reasons ?? [] });
  }

  function routeTask(task: Task): Tier {
    if (task.kind !== 'function') return routeKind(task.kind, config);
    const dossier = dossierOf(task.address);
    if (!dossier || legacy) return 'standard';
    const bucket = bucketOf(dossier);
    const decision = routeFunction(dossier, config, {
      sccSize: task.group ? (sccSizes.get(task.group) ?? 1) : 1,
      historyBoost: Math.max(
        routingHistory.boost(bucket, 'fast'),
        routingHistory.boost(bucket, 'standard'),
      ),
      inputChars: dossier.inputChars,
    });
    decisions.set(task.id, decision);
    let tier = decision.tier;
    // Earlier attempts already showed the lower tiers are not enough: never route below the escalated tier.
    const previous = tierIndexOf(task.tier);
    if (task.history.some((h) => h.outcome === 'escalated') && previous > tierIndex(tier))
      tier = TIERS[previous] ?? tier;
    // A repair follows a result that compiled per function but failed in the project build: ask one tier up.
    if (task.repairContext) {
      const last = [...task.history].reverse().find((h) => h.outcome === 'accepted');
      const lastTier = last?.tier as Tier | undefined;
      const stronger = lastTier ? nextTier(lastTier, table, available) : undefined;
      if (stronger && tierIndex(stronger) > tierIndex(tier)) tier = stronger;
    }
    return tier;
  }

  // ---- shared state of the run --------------------------------------------------------------------------
  const cache = new ResultCache(
    path.join(project.paths.state, 'cache', 'results'),
    advanced && config.cache.enabled && !options.noCache,
  );
  const writeCache = new ResultCache(
    path.join(project.paths.state, 'cache', 'results'),
    advanced && config.cache.enabled,
  );
  const promptHash = advanced ? await promptFingerprint(project) : '';
  const compiler =
    advanced && config.validation.compileCheck === 'auto'
      ? deps.compiler === undefined
        ? await findCCompiler(config.tools.cCompiler)
        : (deps.compiler ?? undefined)
      : undefined;
  const platformNotes = await installPlatformNotes(project, binary);
  const limiter = new AdaptiveLimiter({
    initial: config.scheduler.initialSessions,
    max: config.scheduler.maxSessions,
    maxLoadPerCpu: config.scheduler.maxLoadPerCpu,
    minFreeMemoryFraction: config.scheduler.minFreeMemoryFraction,
    ...(deps.resourceProbe ? { probe: deps.resourceProbe } : {}),
  });

  const running = new Set<Promise<void>>();
  const runningByTier = new Map<Tier, number>();
  const readySince = new Map<string, number>();
  let sessions = 0;
  let totalCostUsd = 0;
  let fatal: unknown;
  let blockedInfo: { reason: BlockReason; text: string; reverted: number } | undefined;
  let nameCounter = 0;

  const candidatesFrom = (tasks: Task[], relaxed: boolean): Candidate[] => {
    const now = performance.now();
    return tasks.map((task) => {
      if (!readySince.has(task.id)) readySince.set(task.id, now);
      const dossier = dossierOf(task.address);
      return {
        task,
        relaxed,
        tier: tierOfTask(task),
        inputTokens: dossier ? Math.ceil(dossier.inputChars / 3.2) + 4_000 : 8_000,
      };
    });
  };

  const pick = (): Candidate[] | undefined => {
    const limits = { table, config, runningByTier };
    const strict = pickBatch(candidatesFrom(store.ready(maxAttempts), false), limits);
    if (strict) return strict;
    if (config.scheduler.mode !== 'adaptive') return undefined;
    return pickBatch(candidatesFrom(store.readyRelaxed(maxAttempts), true), limits);
  };

  // ---- one batch: cache, session, verdicts ---------------------------------------------------------------
  const launch = async (batch: Candidate[]): Promise<boolean> => {
    let tasks = batch.map((c) => c.task);
    const tier = batch[0]?.tier ?? 'standard';
    const relaxed = batch[0]?.relaxed === true;

    // 1. Persistent cache: results that need no model call at all.
    if (advanced) {
      const remaining: Task[] = [];
      for (const task of tasks) {
        if (await tryCache(task, tier)) continue;
        remaining.push(task);
      }
      tasks = remaining;
      if (tasks.length === 0) return false;
    }

    sessions++;
    const name = `${runId}-${String(++nameCounter).padStart(3, '0')}`;
    const head = tasks[0];
    if (!head) return false;
    const spec = await buildBatchSpec(tasks, tier);
    const batchFile = await writeBatchFile(project, binary.id, name, spec);
    const relativeBatch = relativeToProject(project, batchFile);
    await prepareResultFiles(project, binary.id, tasks);
    await store.start(
      tasks.map((t) => t.id),
      name,
    );
    for (const task of tasks)
      events.emit({ type: 'task-started', taskId: task.id, label: task.title });
    if (relaxed) metrics.counters.relaxedStarts += tasks.length;

    const models = modelsFor(head.kind, tier);
    const request = {
      label: name,
      agent: agentFor(head),
      prompt:
        head.kind === 'function'
          ? leadPrompt({ batchFile: relativeBatch, spec })
          : specialistPrompt({ batchFile: relativeBatch, spec }),
      spec,
      batchFile,
      tier,
      ...models,
      signal: deps.signal,
    };
    const waited = tasks.map(
      (t) => performance.now() - (readySince.get(t.id) ?? performance.now()),
    );
    const startedAt = performance.now();
    const workersAtStart = running.size + 1;
    runningByTier.set(tier, (runningByTier.get(tier) ?? 0) + 1);
    metrics.workerChange(1);

    const work = (async () => {
      let outcome: ClaudeRunResult | undefined;
      let sessionFailure: string | undefined;
      let blocked: BlockReason | undefined;
      let cancelled = false;
      try {
        outcome = await deps.runSession(request);
        totalCostUsd += outcome.costUsd ?? 0;
        sessionFailure = outcome.failure;
        blocked = outcome.blocked;
      } catch (error) {
        if (error instanceof RecodeError && error.code === 'CANCELLED') {
          cancelled = true;
          for (const task of tasks) await store.update(task.id, { status: 'pending' });
          fatal ??= error;
        } else sessionFailure = errorMessage(error);
      } finally {
        runningByTier.set(tier, Math.max(0, (runningByTier.get(tier) ?? 1) - 1));
        metrics.workerChange(-1);
      }
      metrics.sessions.push({
        label: name,
        agent: request.agent,
        tier,
        ...(models.model ? { model: models.model } : {}),
        ...(outcome?.model ? { resolvedModel: outcome.model } : {}),
        tasks: tasks.map((t) => t.id),
        startedAtMs: Math.round(startedAt),
        durationMs: Math.round(performance.now() - startedAt),
        queueWaitMs: Math.round(waited.reduce((a, b) => a + b, 0) / Math.max(1, waited.length)),
        workersAtStart,
        ok: outcome?.ok === true,
        ...(sessionFailure ? { failure: sessionFailure.slice(0, 300) } : {}),
        ...(blocked ? { blocked } : {}),
        ...(outcome?.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}),
        ...(outcome?.turns !== undefined ? { turns: outcome.turns } : {}),
        ...(outcome?.usage ? { usage: outcome.usage } : {}),
      });
      if (cancelled) return;
      const blockedText = outcome?.resultText || outcome?.failure || '';

      // Results are accepted even if the session ended abnormally: files that validate are real progress.
      let reverted = 0;
      const verdicts = await mapLimit(tasks, 4, async (task) => ({
        task,
        verdict: await judge(task, tier, models.model, sessionFailure, blocked !== undefined),
      }));
      for (const { task, verdict } of verdicts) {
        if (verdict === 'reverted') {
          reverted++;
        } else if (verdict === 'accepted') {
          events.emit({ type: 'task-completed', taskId: task.id, label: task.title });
        }
      }
      if (blocked) {
        limiter.recordFailure();
        if (reverted > 0) blockedInfo ??= { reason: blocked, text: blockedText, reverted };
      } else if (outcome?.ok) limiter.recordSuccess();
      else limiter.recordFailure();
    })()
      .catch((error: unknown) => {
        fatal ??= error;
      })
      .finally(() => {
        running.delete(work);
      });
    running.add(work);
    return true;
  };

  function modelsFor(kind: Task['kind'], tier: Tier): { model?: string; subagentModel?: string } {
    if (fixed) return {};
    const own = table[tier].model;
    if (kind !== 'function') return own ? { model: own, subagentModel: own } : {};
    // The lead only coordinates and verifies; the specialists carry the difficulty and run at the routed tier.
    const lead =
      table[
        tierIndex(tier) > tierIndex('standard')
          ? (effectiveTier('standard', available) ?? 'standard')
          : tier
      ].model;
    return {
      ...(lead ? { model: lead } : {}),
      ...(own ? { subagentModel: own } : {}),
    };
  }

  const keyFor = (task: Task): string | undefined => {
    if (task.kind === 'function') {
      const dossier = dossierOf(task.address);
      if (!dossier) return undefined;
      const callees = calleeViews(dossier, byAddress, results.functionResults)
        .map((c) => `${c.address}:${c.status === 'reconstructed' ? protoHash(c.prototype) : 'sig'}`)
        .sort();
      return cacheKey([
        promptHash,
        'function',
        dossier.contentHash,
        results.typesResult ? sha256Text(results.typesResult.header) : 'no-types',
        ...callees,
      ]);
    }
    if (task.kind === 'types') {
      return cacheKey([
        promptHash,
        'types',
        sha256Text(JSON.stringify(typeInfos)),
        String(functions.length),
      ]);
    }
    return cacheKey([
      promptHash,
      'overview',
      sha256Text(JSON.stringify(functions.map((f) => [f.address, f.name, f.size]))),
      sha256Text(JSON.stringify(binary.metadata)),
    ]);
  };

  /** Restores a cached result file and runs it through the normal acceptance path. */
  async function tryCache(task: Task, tier: Tier): Promise<boolean> {
    if (task.repairContext) return false;
    const key = keyFor(task);
    if (!key) return false;
    const hit = await cache.get(key);
    if (!hit) {
      metrics.counters.cacheMisses++;
      return false;
    }
    if (tierIndexOf(hit.tier) < tierIndex(tier)) {
      metrics.counters.cacheMisses++;
      return false;
    }
    const file = resultPath(project, binary.id, task);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, hit.payload);
    const inspected = await results.inspect(task, byTaskId.get(task.id));
    if (!inspected.ok) {
      await fs.rm(file, { force: true });
      metrics.counters.cacheMisses++;
      return false;
    }
    results.commit(task, inspected);
    metrics.counters.cacheHits++;
    await store.record(task.id, {
      tier: hit.tier,
      ...(hit.model ? { model: hit.model } : {}),
      outcome: 'cached',
      issues: [],
    });
    await store.complete(task.id, {
      fromCache: true,
      tier: hit.tier,
      openIssues: [],
      seenCallees: seenCalleesOf(task),
      contextHash: promptHash,
    });
    events.emit({ type: 'task-completed', taskId: task.id, label: `${task.title} (cache)` });
    return true;
  }

  function seenCalleesOf(task: Task): Record<string, string> {
    const dossier = dossierOf(task.address);
    if (!dossier) return {};
    const seen: Record<string, string> = {};
    for (const c of calleeViews(dossier, byAddress, results.functionResults)) {
      if (c.status === 'reconstructed' && c.taskId) seen[c.taskId] = protoHash(c.prototype);
    }
    return seen;
  }

  /** Decides what to do with one task after its session. Returns what happened. */
  async function judge(
    task: Task,
    tier: Tier,
    model: string | undefined,
    sessionFailure: string | undefined,
    blocked: boolean,
  ): Promise<'accepted' | 'retry' | 'escalated' | 'failed' | 'reverted'> {
    const fn = byTaskId.get(task.id);
    const inspected = await results.inspect(task, fn);
    const history = store.get(task.id)?.history ?? [];

    if (!inspected.ok) {
      if (blocked) {
        // Not the task's fault: do not count the attempt, stop below.
        await store.revert(task.id);
        return 'reverted';
      }
      const message = sessionFailure
        ? `${inspected.error} (session: ${sessionFailure})`
        : inspected.error;
      const sameTier = history.filter(
        (h) => h.tier === tier && (h.outcome === 'session-failed' || h.outcome === 'rejected'),
      ).length;
      const stronger =
        advanced && config.routing.escalation ? nextTier(tier, table, available) : undefined;
      await store.record(task.id, {
        tier,
        ...(model ? { model } : {}),
        outcome: 'session-failed',
        issues: [message.slice(0, 300)],
      });
      // The first failure at a tier is retried with the message as new information; the second one escalates.
      if (stronger && sameTier >= 1) {
        metrics.counters.escalations++;
        await store.update(task.id, { status: 'pending', tier: stronger, lastError: message });
        await store.record(task.id, { tier, outcome: 'escalated', issues: [`to ${stronger}`] });
        events.emit({
          type: 'info',
          message: `${task.title}: escalating ${tier} -> ${stronger} (no usable result).`,
        });
        return 'escalated';
      }
      metrics.counters.retries++;
      await store.fail(task.id, message);
      events.emit({ type: 'task-failed', taskId: task.id, label: task.title, message });
      return 'failed';
    }

    // A structurally valid result: deterministic validation (static checks, per-function compile).
    const findings: Finding[] = [];
    if (advanced) findings.push(...(await validateResult(task, inspected)));

    const action = decideEscalation({
      tier,
      table,
      available,
      escalationEnabled: advanced && config.routing.escalation && !fixed,
      findings,
      noResult: false,
      history,
    });
    const dossier = dossierOf(task.address);
    if (dossier && !fixed)
      routingHistory.record(bucketOf(dossier), tier, action.action !== 'accept');
    metrics.counters.validatorErrors += findings.filter((f) => f.severity === 'error').length;

    if (action.action === 'accept') {
      results.commit(task, inspected);
      const issues = action.issues.filter((i) => !i.startsWith('compile-warning'));
      await store.record(task.id, {
        tier,
        ...(model ? { model } : {}),
        outcome: 'accepted',
        issues,
      });
      await store.complete(task.id, {
        tier,
        openIssues: issues,
        seenCallees: seenCalleesOf(task),
        contextHash: promptHash,
        fromCache: false,
      });
      metrics.counters.accepted++;
      const clean = !findings.some((f) => f.severity === 'error' || SUSPICIOUS.has(f.code));
      const key = keyFor(task);
      if (advanced && clean && key) {
        const payload = await fs.readFile(resultPath(project, binary.id, task), 'utf8');
        await writeCache.put({ key, kind: task.kind, tier, ...(model ? { model } : {}), payload });
      }
      return 'accepted';
    }

    metrics.counters.rejected++;
    const text = formatFindings(findings);
    const history2 = {
      tier,
      ...(model ? { model } : {}),
      outcome: 'rejected' as const,
      issues: [keyIssue(findings), ...text],
    };
    await store.record(task.id, history2);
    const context =
      `Validation findings for the previous result (tier ${tier}):\n${text.map((l) => `- ${l}`).join('\n')}\n` +
      'Refine the previous result (previousResultFile) so that every listed finding is fixed. Do not start over.';
    if (action.action === 'escalate') {
      metrics.counters.escalations++;
      await store.record(task.id, {
        tier,
        outcome: 'escalated',
        issues: [`to ${action.tier}: ${action.reason}`],
      });
      await store.update(task.id, {
        status: 'pending',
        tier: action.tier,
        repairContext: context,
        lastError: action.reason,
      });
      events.emit({
        type: 'info',
        message: `${task.title}: escalating ${tier} -> ${action.tier} (${action.reason}).`,
      });
      return 'escalated';
    }
    if (action.action === 'retry') {
      metrics.counters.retries++;
      await store.update(task.id, { repairContext: context });
      await store.fail(task.id, action.reason);
      return 'retry';
    }
    // give-up: honest failure; the function is not included in the project.
    metrics.counters.failedPermanently++;
    await store.update(task.id, {
      repairContext: context,
      attempts: Math.max(maxAttempts, store.get(task.id)?.attempts ?? 0),
    });
    await store.fail(task.id, `${action.reason}: ${text.slice(0, 3).join(' | ')}`);
    events.emit({
      type: 'task-failed',
      taskId: task.id,
      label: task.title,
      message: action.reason,
    });
    return 'failed';
  }

  async function validateResult(
    task: Task,
    inspected: Extract<Inspection, { ok: true }>,
  ): Promise<Finding[]> {
    if (inspected.kind === 'function') {
      const dossier = dossierOf(task.address);
      const result = inspected.result;
      const known = new Set<string>(
        (results.typesResult?.header.match(/[A-Za-z_]\w*/g) ?? []) as string[],
      );
      const findings = validateFunctionResult(result, {
        originalMetrics: dossier?.metrics,
        knownTypes: known,
      });
      if (!hasErrors(findings) && compiler && result.status === 'reconstructed' && dossier) {
        metrics.counters.compileChecks++;
        const fn = byTaskId.get(task.id);
        if (fn) {
          const callees = calleeViews(dossier, byAddress, results.functionResults)
            .filter((c) => c.status === 'reconstructed')
            .map((c) => c.prototype);
          const compiled = await compileCheckFunction({
            compiler,
            workDirectory: path.join(project.paths.state, 'work', binary.id, 'compile-check'),
            info: fn,
            result,
            typesHeader: results.typesResult?.header,
            otherPrototypes: callees,
            signal: deps.signal,
          });
          metrics.counters.compileErrors += compiled.findings.filter(
            (f) => f.severity === 'error',
          ).length;
          findings.push(...compiled.findings);
        }
      }
      return findings;
    }
    if (inspected.kind === 'types' && compiler) {
      metrics.counters.compileChecks++;
      const compiled = await compileCheckTypes({
        compiler,
        workDirectory: path.join(project.paths.state, 'work', binary.id, 'compile-check'),
        typesHeader: inspected.result.header,
        signal: deps.signal,
      });
      metrics.counters.compileErrors += compiled.findings.filter(
        (f) => f.severity === 'error',
      ).length;
      return compiled.findings;
    }
    return [];
  }

  async function buildBatchSpec(batch: Task[], tier: Tier): Promise<BatchSpec> {
    const analysis = `analysis/${binary.id}`;
    const shared: Record<string, string> = {
      metadata: `${analysis}/metadata.json`,
      program: `${analysis}/program.json`,
    };
    const functionBatch = batch[0]?.kind === 'function';
    // Function agents get their knowledge through per-task context files; whole-program files stay for the
    // overview and structure tasks (and in legacy mode, which keeps the original hand-over).
    if (!advanced || !functionBatch) {
      shared['functions'] = `${analysis}/functions.json`;
      shared['symbols'] = `${analysis}/symbols.json`;
      shared['types'] = `${analysis}/types.json`;
      shared['callGraph'] = `${analysis}/call-graph.json`;
    }
    if (results.hasOverview) shared['overview'] = `reconstruction/${binary.id}/overview.md`;
    if (results.typesResult)
      shared['sharedTypes'] = `reconstruction/${binary.id}/results/types.json`;
    if (platformNotes) shared['platformNotes'] = platformNotes;
    if (project.references.length > 0) shared['referenceDirectory'] = 'reference/';

    const groupMembers = (group: string | undefined) =>
      group
        ? batch
            .filter((t) => t.group === group)
            .map((t) => ({
              taskId: t.id,
              address: t.address ?? '',
              name: byTaskId.get(t.id)?.name ?? t.id,
            }))
        : [];

    const tasks: BatchTask[] = [];
    for (const task of batch) {
      const fn = byTaskId.get(task.id);
      const dossier = dossierOf(task.address);
      const files: Record<string, string> = {};
      if (fn?.decompiledFile) files['decompiled'] = `${analysis}/${fn.decompiledFile}`;
      if (fn?.disassemblyFile) files['assembly'] = `${analysis}/${fn.disassemblyFile}`;
      const views: CalleeView[] = dossier
        ? calleeViews(dossier, byAddress, results.functionResults)
        : legacyCallees(fn, byAddress, results);
      let contextFile: string | undefined;
      if (advanced && task.kind === 'function' && dossier) {
        const decision = decisions.get(task.id) ?? difficultyFallback(dossier);
        const previousFile = task.repairContext
          ? {
              resultFile: relativeToProject(project, resultPath(project, binary.id, task)),
              tier: task.history.at(-1)?.tier,
              findings: task.repairContext.split('\n').slice(0, 40),
            }
          : undefined;
        contextFile = relativeToProject(
          project,
          await writeTaskContext({
            project,
            binary,
            dossier,
            taskId: task.id,
            route: { tier, model: table[tier].model, decision },
            callees: views,
            types: typesByName,
            group: groupMembers(task.group),
            previous: previousFile,
          }),
        );
      }
      tasks.push({
        taskId: task.id,
        kind: task.kind,
        ...(fn ? { address: fn.address, ghidraName: fn.name, ghidraSignature: fn.signature } : {}),
        files,
        ...(contextFile ? { contextFile } : {}),
        ...(advanced ? { tier } : {}),
        ...(advanced && table[tier].model ? { model: table[tier].model } : {}),
        resultFile: relativeToProject(project, resultPath(project, binary.id, task)),
        ...(task.kind === 'function'
          ? { analysisNoteFile: `reconstruction/${binary.id}/analysis/${task.id}.md` }
          : {}),
        calleePrototypes: views.map((c) => ({
          address: c.address,
          name: c.name,
          prototype: c.prototype,
          status: c.status,
        })),
        ...(task.repairContext
          ? {
              repairContext: task.repairContext,
              previousResultFile: relativeToProject(project, resultPath(project, binary.id, task)),
            }
          : {}),
        ...(task.lastError ? { previousFailure: task.lastError } : {}),
      });
    }
    return {
      binaryId: binary.id,
      createdAt: new Date().toISOString(),
      maxParallelAgents: config.claude.maxParallelAgents,
      sharedFiles: shared,
      tasks,
    };
  }

  const difficultyFallback = (d: Dossier): Pick<RouteDecision, 'score' | 'reasons'> =>
    difficultyScore(d, { sccSize: 1 });

  // ---- main loop -----------------------------------------------------------------------------------------
  const loopStart = performance.now();
  for (;;) {
    if (deps.signal?.aborted)
      fatal ??= new RecodeError('CANCELLED', 'Reconstruction cancelled; progress is saved.');
    if (!fatal && !blockedInfo) {
      while (limiter.canStart(running.size)) {
        const batch = pick();
        if (!batch) break;
        await launch(batch);
        if (fatal || blockedInfo) break;
      }
    }
    if (running.size === 0) break;
    await Promise.race(running);
  }
  metrics.phases['reconstruct-loop'] = Math.round(performance.now() - loopStart);
  metrics.adjustments = limiter.adjustments;
  await store.flush();
  await routingHistory.save().catch(() => undefined);
  if (fatal) {
    await metrics.write(metricsDir(project, binary.id)).catch(() => undefined);
    throw fatal;
  }
  if (blockedInfo) {
    await metrics.write(metricsDir(project, binary.id)).catch(() => undefined);
    throw blockedError(blockedInfo.reason, blockedInfo.text, project);
  }

  const taskIds = new Set(planned.tasks.map((t) => t.id));
  const generation = await metrics.phase('generate', () =>
    new CTargetLanguage().generateProject({
      project,
      binary,
      functions: functions.filter((f) => taskIds.has(functionTaskId(f.address))),
      functionResults: results.functionResults,
      typesResult: results.typesResult,
    }),
  );

  const tierCounts: Record<string, number> = {};
  for (const t of store.tasks) {
    if (t.kind === 'function')
      tierCounts[t.tier ?? 'standard'] = (tierCounts[t.tier ?? 'standard'] ?? 0) + 1;
  }
  metrics.counters.cacheHits ||= 0;
  const openIssues = store.tasks
    .filter((t) => t.openIssues.length > 0)
    .map((t) => ({ id: t.id, issues: t.openIssues }));
  await writeJsonAtomic(path.join(project.reconstructionDir(binary.id), 'quality.json'), {
    generatedAt: new Date().toISOString(),
    tasks: store.tasks
      .filter((t) => t.kind === 'function')
      .map((t) => ({
        taskId: t.id,
        tier: t.tier,
        status: t.status,
        attempts: t.attempts,
        escalations: t.history.filter((h) => h.outcome === 'escalated').length,
        fromCache: t.fromCache === true,
        openIssues: t.openIssues,
        ...(t.status === 'failed' && t.lastError ? { error: t.lastError } : {}),
      })),
  });
  const written = await metrics.write(metricsDir(project, binary.id)).catch(() => undefined);

  return {
    counts: store.counts(),
    generation,
    sessions,
    totalCostUsd,
    excluded: planned.excluded.length,
    failedTasks: store.tasks
      .filter((t) => t.status === 'failed')
      .map((t) => ({ id: t.id, error: t.lastError ?? 'unknown' })),
    openIssues,
    routing: {
      tiers: tierCounts,
      escalations: metrics.counters.escalations,
      retries: metrics.counters.retries,
      cacheHits: metrics.counters.cacheHits,
      relaxedStarts: metrics.counters.relaxedStarts,
      invalidated: metrics.counters.invalidated,
      maxConcurrentSessions: written?.workers.max ?? 0,
      modelWarnings,
    },
    metricsFile: written
      ? relativeToProject(
          project,
          path.join(metricsDir(project, binary.id), `${written.runId}.json`),
        )
      : undefined,
  };
}

export function metricsDir(project: Project, binaryId: string): string {
  return path.join(project.paths.state, 'metrics', binaryId);
}

const tierIndexOf = (tier: string | undefined): number => {
  const i = (TIERS as readonly string[]).indexOf(tier ?? '');
  return i < 0 ? tierIndex('standard') : i;
};

function legacyCallees(
  fn: FunctionInfo | undefined,
  functions: ReadonlyMap<string, FunctionInfo>,
  results: ResultBook,
): CalleeView[] {
  return (fn?.calls ?? []).flatMap((target) => {
    const callee = functions.get(target);
    if (!callee) return [];
    const known = results.functionResults.get(functionTaskId(target));
    return [
      known && known.status === 'reconstructed'
        ? {
            address: target,
            name: known.name,
            prototype: known.prototype,
            status: 'reconstructed' as const,
            external: false,
            thunk: false,
          }
        : {
            address: target,
            name: callee.name,
            prototype: callee.signature,
            status: 'ghidra-signature (not yet reconstructed)' as const,
            external: false,
            thunk: false,
          },
    ];
  });
}

/**
 * A completed caller was written against the prototype its callee had then. If the callee's accepted prototype
 * changed since (e.g. it was re-reconstructed), only those callers are reopened - not the whole project.
 */
async function invalidateStaleCallers(
  store: TaskStore,
  results: ResultBook,
  byTaskId: ReadonlyMap<string, FunctionInfo>,
  metrics: MetricsCollector,
  events: EventBus,
): Promise<void> {
  for (const task of store.tasks) {
    if (task.status !== 'completed' || task.kind !== 'function') continue;
    const changed: string[] = [];
    for (const [calleeId, seen] of Object.entries(task.seenCallees)) {
      const now = results.functionResults.get(calleeId);
      if (now && now.status === 'reconstructed' && protoHash(now.prototype) !== seen) {
        changed.push(`${byTaskId.get(calleeId)?.name ?? calleeId} -> ${now.prototype.trim()}`);
      }
    }
    if (changed.length === 0) continue;
    await store.reopen(
      task.id,
      `Callee prototype(s) changed since this function was reconstructed:\n${changed.map((c) => `- ${c}`).join('\n')}\nUpdate the calls accordingly.`,
    );
    metrics.counters.invalidated++;
    events.emit({
      type: 'info',
      message: `${task.title}: reopened because a callee prototype changed.`,
    });
  }
}

/** Error for sessions that retrying cannot fix; progress so far is saved and the tasks stay pending. */
export function blockedError(reason: BlockReason, text: string, project: Project): RecodeError {
  if (reason === 'rate-limit') {
    return new RecodeError(
      'RATE_LIMIT',
      `Claude Code usage limit reached: ${text.trim().slice(0, 300) || 'no details'}`,
      {
        hint: 'Progress is saved and no attempts were used up. Start the step again after the limit has reset.',
      },
    );
  }
  return new RecodeError(
    'UNTRUSTED',
    'Claude Code does not trust this project folder and therefore ignores its permission rules.',
    {
      hint:
        `Run "recode trust" in ${project.root} (or click "Trust this project" in the web interface), ` +
        'or start "claude" once in this folder and accept the trust dialog. Then run the step again.',
    },
  );
}

function agentFor(task: Task): string {
  if (task.kind === 'overview') return 'recode-binary-analyst';
  if (task.kind === 'types') return 'recode-structure-analyst';
  return 'recode-lead';
}

async function prepareResultFiles(
  project: Project,
  binaryId: string,
  batch: Task[],
): Promise<void> {
  for (const task of batch) {
    if (task.repairContext) continue; // repair/escalation tasks keep the previous result as input
    await fs.rm(resultPath(project, binaryId, task), { force: true });
  }
}

export function resultPath(
  project: Project,
  binaryId: string,
  task: Pick<Task, 'id' | 'kind'>,
): string {
  const dir = project.reconstructionDir(binaryId);
  return task.kind === 'overview'
    ? path.join(dir, 'overview.md')
    : path.join(dir, 'results', `${task.id}.json`);
}

function relativeToProject(project: Project, absolute: string): string {
  return path.relative(project.root, absolute).split(path.sep).join('/');
}

/**
 * Copies the static, ReCode-owned guidance for the binary's platform next to the reconstruction results, where
 * agents may read it. Returns its project-relative path, or undefined for binaries without a known platform.
 */
async function installPlatformNotes(
  project: Project,
  binary: BinaryRecord,
): Promise<string | undefined> {
  const platform = binary.metadata.platform;
  if (!platform) return undefined;
  const relative = `reconstruction/${binary.id}/platform-notes.md`;
  await fs.mkdir(project.reconstructionDir(binary.id), { recursive: true });
  await fs.copyFile(
    assetPath('templates', 'platforms', `${platform}.md`),
    path.join(project.root, relative),
  );
  return relative;
}

async function queueRepairs(
  project: Project,
  binary: BinaryRecord,
  store: TaskStore,
  events: EventBus,
): Promise<void> {
  const file = path.join(project.buildDir(binary.id), 'diagnostics.json');
  if (!(await pathExists(file))) {
    throw new RecodeError('WORKFLOW', 'No build diagnostics found; run "recode build" first.');
  }
  const { diagnostics } = await readJson(file, DiagnosticsFileSchema);
  const grouped = new Map<string, string[]>();
  for (const d of diagnostics) {
    if (d.severity !== 'error' || !d.taskId) continue;
    const list = grouped.get(d.taskId) ?? [];
    list.push(`${d.file}:${d.line}: ${d.message}`);
    grouped.set(d.taskId, list);
  }
  for (const [taskId, lines] of grouped) {
    if (!store.get(taskId)) continue;
    await store.reopen(taskId, `Compiler errors:\n${lines.slice(0, 30).join('\n')}`);
    events.emit({
      type: 'info',
      message: `Queued repair of ${taskId} (${lines.length} compiler error(s)).`,
    });
  }
}

type Verdict = { ok: true } | { ok: false; error: string };

export type Inspection =
  | { ok: true; kind: 'overview' }
  | { ok: true; kind: 'types'; result: TypesResult }
  | { ok: true; kind: 'function'; result: FunctionResult }
  | { ok: false; error: string };

/** Holds accepted agent results and validates new ones. */
class ResultBook {
  readonly functionResults = new Map<string, FunctionResult>();
  typesResult: TypesResult | undefined;
  hasOverview = false;

  constructor(
    private readonly project: Project,
    private readonly binaryId: string,
  ) {}

  async loadAccepted(store: TaskStore): Promise<void> {
    for (const task of store.tasks.filter((t) => t.status === 'completed')) {
      const verdict = await this.accept(task, undefined);
      if (!verdict.ok) await store.reopen(task.id);
    }
  }

  /** Validates a result file structurally without registering it. */
  async inspect(task: Task, fn: FunctionInfo | undefined): Promise<Inspection> {
    const file = resultPath(this.project, this.binaryId, task);
    if (!(await pathExists(file)))
      return { ok: false, error: `Result file ${path.basename(file)} was not written.` };
    try {
      if (task.kind === 'overview') {
        const text = await fs.readFile(file, 'utf8');
        if (text.trim().length < 20) return { ok: false, error: 'overview.md is empty.' };
        return { ok: true, kind: 'overview' };
      }
      if (task.kind === 'types') {
        return { ok: true, kind: 'types', result: await readJson(file, TypesResultSchema) };
      }
      const result = await readJson(file, FunctionResultSchema);
      const problem = this.functionProblem(task, fn, result);
      return problem ? { ok: false, error: problem } : { ok: true, kind: 'function', result };
    } catch (error) {
      return { ok: false, error: `Invalid result: ${errorMessage(error)}` };
    }
  }

  /** Registers an inspected result as accepted. */
  commit(task: Task, inspection: Extract<Inspection, { ok: true }>): void {
    if (inspection.kind === 'overview') this.hasOverview = true;
    else if (inspection.kind === 'types') this.typesResult = inspection.result;
    else this.functionResults.set(task.id, inspection.result);
  }

  async accept(task: Task, fn: FunctionInfo | undefined): Promise<Verdict> {
    const inspection = await this.inspect(task, fn);
    if (!inspection.ok) return inspection;
    this.commit(task, inspection);
    return { ok: true };
  }

  private functionProblem(
    task: Task,
    fn: FunctionInfo | undefined,
    result: FunctionResult,
  ): string | undefined {
    if (result.taskId !== task.id) return `taskId mismatch (${result.taskId}).`;
    if (fn && result.address !== fn.address) {
      return `address mismatch: expected ${fn.address}, got ${result.address}.`;
    }
    if (result.status === 'reconstructed') {
      if (
        !result.code.includes(`${result.name}(`) &&
        !new RegExp(`\\b${result.name}\\s*\\(`).test(result.code)
      ) {
        return `code does not define "${result.name}".`;
      }
      if (result.prototype.trim() === '') return 'prototype is empty.';
      if (/^\s*#\s*include/m.test(result.code)) return 'code must not contain #include lines.';
      const clash = [...this.functionResults.entries()].find(
        ([id, other]) =>
          id !== task.id && other.status === 'reconstructed' && other.name === result.name,
      );
      if (clash) return `name "${result.name}" is already used by ${clash[0]}.`;
    }
    return undefined;
  }
}

export { ResultBook };
