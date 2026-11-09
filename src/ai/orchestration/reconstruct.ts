import fs from 'node:fs/promises';
import path from 'node:path';
import { RecodeError, errorMessage } from '../../core/errors/index.js';
import type { EventBus } from '../../core/events/event-bus.js';
import type { BinaryRecord, Project } from '../../core/project/project.js';
import { TaskStore, type Task } from '../../core/tasks/task-store.js';
import { loadFunctions } from '../../decompiler/extraction/analysis-files.js';
import type { FunctionInfo } from '../../decompiler/interfaces/schemas.js';
import type { RecodeConfig } from '../../infrastructure/config/config.js';
import { pathExists, readJson, sha256Text } from '../../infrastructure/filesystem/files.js';
import { CTargetLanguage, functionTaskId } from '../../reconstruction/c/c-generator.js';
import type { BlockReason } from '../claude/runner.js';
import {
  FunctionResultSchema,
  TypesResultSchema,
  type FunctionResult,
  type TypesResult,
} from '../../reconstruction/interfaces/results.js';
import type { GenerationReport } from '../../reconstruction/interfaces/target-language.js';
import {
  leadPrompt,
  specialistPrompt,
  type BatchSpec,
  type BatchTask,
} from '../prompts/prompts.js';
import { planTasks } from './planner.js';
import { writeBatchFile, type SessionRunner } from './session.js';
import { z } from 'zod';

export interface ReconstructOptions {
  /** Re-queue tasks whose generated code failed to compile, with the compiler diagnostics. */
  repair?: boolean;
  /** Give permanently failed tasks a fresh set of attempts. */
  retryFailed?: boolean;
}

export interface ReconstructSummary {
  counts: Record<Task['status'], number>;
  generation: GenerationReport;
  sessions: number;
  totalCostUsd: number;
  excluded: number;
  failedTasks: Array<{ id: string; error: string }>;
}

export interface ReconstructDeps {
  project: Project;
  binary: BinaryRecord;
  config: RecodeConfig;
  events: EventBus;
  runSession: SessionRunner;
  signal?: AbortSignal | undefined;
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

/** Runs (or resumes) the AI reconstruction and regenerates the C project from accepted results. */
export async function reconstruct(
  deps: ReconstructDeps,
  options: ReconstructOptions = {},
): Promise<ReconstructSummary> {
  const { project, binary, config, events } = deps;
  const analysisDir = project.analysisDir(binary.id);
  const functions = await loadFunctions(analysisDir);
  const byTaskId = new Map(functions.map((f) => [functionTaskId(f.address), f]));

  const plan = planTasks(functions);
  const store = new TaskStore(project.tasksFile(binary.id));
  await store.load();
  const fingerprint = sha256Text(
    JSON.stringify(functions.map((f) => [f.address, f.name, f.size, f.calls, f.decompiledFile])),
  );
  await store.setPlan(fingerprint, plan.tasks);

  if (options.retryFailed) {
    for (const task of store.tasks.filter((t) => t.status === 'failed'))
      await store.reopen(task.id);
  }
  if (options.repair) await queueRepairs(project, binary, store, events);

  const results = new ResultBook(project, binary.id);
  await results.loadAccepted(store);

  let sessions = 0;
  let totalCostUsd = 0;
  const maxAttempts = config.claude.maxAttempts;

  for (;;) {
    if (deps.signal?.aborted)
      throw new RecodeError('CANCELLED', 'Reconstruction cancelled; progress is saved.');
    const ready = store.ready(maxAttempts);
    if (ready.length === 0) break;
    const head = ready[0];
    if (!head) break;
    const batch = head.kind === 'function' ? ready.slice(0, config.claude.batchSize) : [head];
    sessions++;
    const spec = buildBatchSpec(project, binary, config, batch, byTaskId, results);
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${String(sessions).padStart(3, '0')}`;
    const batchFile = await writeBatchFile(project, binary.id, name, spec);
    const relativeBatch = path.relative(project.root, batchFile).split(path.sep).join('/');

    await prepareResultFiles(project, binary.id, batch);
    await store.start(
      batch.map((t) => t.id),
      name,
    );
    for (const task of batch)
      events.emit({ type: 'task-started', taskId: task.id, label: task.title });

    const request = {
      label: name,
      agent: agentFor(head),
      prompt:
        head.kind === 'function'
          ? leadPrompt({ batchFile: relativeBatch, spec })
          : specialistPrompt({ batchFile: relativeBatch, spec }),
      spec,
      batchFile,
      signal: deps.signal,
    };

    let sessionFailure: string | undefined;
    let blocked: BlockReason | undefined;
    let blockedText = '';
    try {
      const outcome = await deps.runSession(request);
      totalCostUsd += outcome.costUsd ?? 0;
      sessionFailure = outcome.failure;
      blocked = outcome.blocked;
      blockedText = outcome.resultText || outcome.failure || '';
    } catch (error) {
      if (error instanceof RecodeError && error.code === 'CANCELLED') {
        for (const task of batch) await store.update(task.id, { status: 'pending' });
        throw error;
      }
      sessionFailure = errorMessage(error);
    }

    // Results are accepted even if the session ended abnormally: files that validate are real progress.
    let reverted = 0;
    for (const task of batch) {
      const verdict = await results.accept(task, byTaskId.get(task.id));
      if (verdict.ok) {
        await store.complete(task.id);
        events.emit({ type: 'task-completed', taskId: task.id, label: task.title });
      } else if (blocked) {
        // Not the task's fault: do not count the attempt, stop below.
        await store.revert(task.id);
        reverted++;
      } else {
        const message = sessionFailure
          ? `${verdict.error} (session: ${sessionFailure})`
          : verdict.error;
        await store.fail(task.id, message);
        events.emit({ type: 'task-failed', taskId: task.id, label: task.title, message });
      }
    }
    if (blocked && reverted > 0) throw blockedError(blocked, blockedText, project);
  }

  const generation = await new CTargetLanguage().generateProject({
    project,
    binary,
    functions: functions.filter(
      (f) =>
        byTaskId.has(functionTaskId(f.address)) &&
        plan.tasks.some((t) => t.id === functionTaskId(f.address)),
    ),
    functionResults: results.functionResults,
    typesResult: results.typesResult,
  });

  return {
    counts: store.counts(),
    generation,
    sessions,
    totalCostUsd,
    excluded: plan.excluded.length,
    failedTasks: store.tasks
      .filter((t) => t.status === 'failed')
      .map((t) => ({ id: t.id, error: t.lastError ?? 'unknown' })),
  };
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
    if (task.repairContext) continue; // repair tasks keep the previous result as input
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

function buildBatchSpec(
  project: Project,
  binary: BinaryRecord,
  config: RecodeConfig,
  batch: Task[],
  functions: Map<string, FunctionInfo>,
  results: ResultBook,
): BatchSpec {
  const analysis = `analysis/${binary.id}`;
  const shared: Record<string, string> = {
    metadata: `${analysis}/metadata.json`,
    functions: `${analysis}/functions.json`,
    symbols: `${analysis}/symbols.json`,
    types: `${analysis}/types.json`,
    callGraph: `${analysis}/call-graph.json`,
    program: `${analysis}/program.json`,
  };
  if (results.hasOverview) shared['overview'] = `reconstruction/${binary.id}/overview.md`;
  if (results.typesResult) shared['sharedTypes'] = `reconstruction/${binary.id}/results/types.json`;
  if (project.references.length > 0) shared['referenceDirectory'] = 'reference/';

  const tasks: BatchTask[] = batch.map((task) => {
    const fn = functions.get(task.id);
    const files: Record<string, string> = {};
    if (fn?.decompiledFile) files['decompiled'] = `${analysis}/${fn.decompiledFile}`;
    if (fn?.disassemblyFile) files['assembly'] = `${analysis}/${fn.disassemblyFile}`;
    return {
      taskId: task.id,
      kind: task.kind,
      ...(fn ? { address: fn.address, ghidraName: fn.name, ghidraSignature: fn.signature } : {}),
      files,
      resultFile: relativeToProject(project, resultPath(project, binary.id, task)),
      ...(task.kind === 'function'
        ? { analysisNoteFile: `reconstruction/${binary.id}/analysis/${task.id}.md` }
        : {}),
      calleePrototypes: (fn?.calls ?? []).flatMap((target) => {
        const callee = functions.get(functionTaskId(target));
        if (!callee) return [];
        const known = results.functionResults.get(functionTaskId(target));
        return [
          known && known.status === 'reconstructed'
            ? {
                address: target,
                name: known.name,
                prototype: known.prototype,
                status: 'reconstructed',
              }
            : {
                address: target,
                name: callee.name,
                prototype: callee.signature,
                status: 'ghidra-signature (not yet reconstructed)',
              },
        ];
      }),
      ...(task.repairContext
        ? {
            repairContext: task.repairContext,
            previousResultFile: relativeToProject(project, resultPath(project, binary.id, task)),
          }
        : {}),
      ...(task.lastError ? { previousFailure: task.lastError } : {}),
    };
  });

  return {
    binaryId: binary.id,
    createdAt: new Date().toISOString(),
    maxParallelAgents: config.claude.maxParallelAgents,
    sharedFiles: shared,
    tasks,
  };
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

  async accept(task: Task, fn: FunctionInfo | undefined): Promise<Verdict> {
    const file = resultPath(this.project, this.binaryId, task);
    if (!(await pathExists(file)))
      return { ok: false, error: `Result file ${path.basename(file)} was not written.` };
    try {
      if (task.kind === 'overview') {
        const text = await fs.readFile(file, 'utf8');
        if (text.trim().length < 20) return { ok: false, error: 'overview.md is empty.' };
        this.hasOverview = true;
        return { ok: true };
      }
      if (task.kind === 'types') {
        this.typesResult = await readJson(file, TypesResultSchema);
        return { ok: true };
      }
      const result = await readJson(file, FunctionResultSchema);
      return this.acceptFunction(task, fn, result);
    } catch (error) {
      return { ok: false, error: `Invalid result: ${errorMessage(error)}` };
    }
  }

  private acceptFunction(
    task: Task,
    fn: FunctionInfo | undefined,
    result: FunctionResult,
  ): Verdict {
    if (result.taskId !== task.id)
      return { ok: false, error: `taskId mismatch (${result.taskId}).` };
    if (fn && result.address !== fn.address) {
      return {
        ok: false,
        error: `address mismatch: expected ${fn.address}, got ${result.address}.`,
      };
    }
    if (result.status === 'reconstructed') {
      if (
        !result.code.includes(`${result.name}(`) &&
        !new RegExp(`\\b${result.name}\\s*\\(`).test(result.code)
      ) {
        return { ok: false, error: `code does not define "${result.name}".` };
      }
      if (result.prototype.trim() === '') return { ok: false, error: 'prototype is empty.' };
      if (/^\s*#\s*include/m.test(result.code))
        return { ok: false, error: 'code must not contain #include lines.' };
      const clash = [...this.functionResults.entries()].find(
        ([id, other]) =>
          id !== task.id && other.status === 'reconstructed' && other.name === result.name,
      );
      if (clash)
        return { ok: false, error: `name "${result.name}" is already used by ${clash[0]}.` };
    }
    this.functionResults.set(task.id, result);
    return { ok: true };
  }
}

export { ResultBook };
