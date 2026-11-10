import { z } from 'zod';
import { WorkflowStatusSchema } from '../workflow/workflow.js';
import { readJsonIfExists, writeJsonAtomic } from '../../infrastructure/filesystem/files.js';

export const TaskKindSchema = z.enum(['overview', 'types', 'function']);
export type TaskKind = z.infer<typeof TaskKindSchema>;

export const TaskHistoryEntrySchema = z.object({
  at: z.string(),
  tier: z.string().optional(),
  model: z.string().optional(),
  outcome: z.enum(['accepted', 'rejected', 'session-failed', 'escalated', 'cached']),
  issues: z.array(z.string()).default([]),
});
export type TaskHistoryEntry = z.infer<typeof TaskHistoryEntrySchema>;

const HISTORY_LIMIT = 12;

export const TaskSchema = z.object({
  id: z.string(),
  kind: TaskKindSchema,
  title: z.string(),
  address: z.string().optional(),
  /** Hard dependencies: the task cannot start before these completed (or failed permanently). */
  dependsOn: z.array(z.string()),
  status: WorkflowStatusSchema,
  attempts: z.number().int().nonnegative(),
  lastError: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  sessionId: z.string().optional(),
  /** Extra context for repairs, e.g. compiler diagnostics for this function. */
  repairContext: z.string().optional(),
  /**
   * Dependencies that only improve quality (callees whose reconstructed prototype is preferable to the decompiler
   * signature). They order the work but may be relaxed by the scheduler when workers would otherwise idle.
   */
  softDependsOn: z.array(z.string()).default([]),
  /** Tasks of one strongly connected component (mutual recursion) share a group and are run in one session. */
  group: z.string().optional(),
  /** Critical-path priority: number of dependency levels above this task. Higher runs first. */
  priority: z.number().int().nonnegative().default(0),
  /** Routing label (e.g. "standard") chosen for the next attempt; opaque to the store. */
  tier: z.string().optional(),
  /** Why the router picked the tier (short, machine-written reasons). */
  routeReasons: z.array(z.string()).default([]),
  /** Hash of the analysis inputs the task was planned from (changes when the function itself changes). */
  inputHash: z.string().optional(),
  /** Hash of everything a completed result depended on (inputs, callee prototypes, prompts). */
  contextHash: z.string().optional(),
  /** Outcome of every attempt, newest last (capped). Used to avoid repeating a failed approach. */
  history: z.array(TaskHistoryEntrySchema).default([]),
  /** Set when the result came from the persistent cache instead of a model call. */
  fromCache: z.boolean().optional(),
  /** Callee task id -> hash of the reconstructed prototype the result was written against. */
  seenCallees: z.record(z.string(), z.string()).default({}),
  /** Why the last result was accepted with open findings (kept for the report, never hidden). */
  openIssues: z.array(z.string()).default([]),
});
export type Task = z.infer<typeof TaskSchema>;

/** Fields a planner supplies; the rest has defaults. */
export type NewTask = Pick<Task, 'id' | 'kind' | 'title'> & Partial<Task>;

export const TaskFileSchema = z.object({
  schemaVersion: z.literal(1),
  /** Fingerprint of the analysis these tasks were planned from. */
  planFingerprint: z.string(),
  tasks: z.array(TaskSchema),
  updatedAt: z.string(),
});
export type TaskFile = z.infer<typeof TaskFileSchema>;

/** Builds a complete task from planner output. */
export function makeTask(partial: NewTask): Task {
  return TaskSchema.parse({ dependsOn: [], status: 'pending', attempts: 0, ...partial });
}

/**
 * Persistent list of reconstruction tasks with crash-safe status transitions.
 *
 * Writes are coalesced and optionally throttled: at most one write is in flight and every change made meanwhile is
 * covered by one follow-up write of the then-current state. Each write is atomic (temp file + rename), so the file is
 * always valid. This replaces the former synchronous full rewrite (with fsync) on every status change, which cost
 * O(tasks) per update. Callers use `flush()` at points where durability matters; results themselves are persisted
 * separately (result files, cache), so a lost trailing update only repeats cheap bookkeeping.
 */
export class TaskStore {
  private data: TaskFile | undefined;
  private index = new Map<string, number>();
  private dirty = false;
  private forceNow = false;
  private lastWrite = 0;
  private failure: unknown;
  private wake: (() => void) | undefined;
  private writing: Promise<void> | undefined;

  /** @param minWriteIntervalMs minimum time between background writes (0 = write as soon as possible). */
  constructor(
    private readonly file: string,
    private readonly minWriteIntervalMs = 0,
  ) {}

  async load(): Promise<TaskFile | undefined> {
    this.data = await readJsonIfExists(this.file, TaskFileSchema);
    if (this.data) {
      // Tasks left "running" by a crashed process go back to pending; the attempt still counts.
      this.data.tasks = this.data.tasks.map((t) =>
        t.status === 'running' ? { ...t, status: 'pending' as const, lastError: 'Interrupted' } : t,
      );
      this.reindex();
    }
    return this.data;
  }

  get tasks(): readonly Task[] {
    return this.data?.tasks ?? [];
  }

  get planFingerprint(): string | undefined {
    return this.data?.planFingerprint;
  }

  /**
   * Replaces the plan. A task keeps its state when it is unchanged: the same `inputHash` as before, or (for plans
   * stored before hashes existed) an unchanged plan fingerprint. Changed tasks start over. Returns the ids of tasks
   * whose previous state was discarded although they existed before.
   */
  async setPlan(planFingerprint: string, planned: Task[]): Promise<string[]> {
    const sameFingerprint = this.data?.planFingerprint === planFingerprint;
    const previous = new Map(this.data?.tasks.map((t) => [t.id, t]));
    const discarded: string[] = [];
    const tasks = planned.map((task) => {
      const old = previous.get(task.id);
      if (!old) return task;
      const unchanged =
        old.inputHash === undefined
          ? sameFingerprint
          : task.inputHash !== undefined && old.inputHash === task.inputHash;
      if (!unchanged) {
        discarded.push(task.id);
        return task;
      }
      // Keep progress, but take the structure (dependencies, priority, group) from the new plan.
      return {
        ...old,
        title: task.title,
        dependsOn: task.dependsOn,
        softDependsOn: task.softDependsOn,
        group: task.group,
        priority: task.priority,
        inputHash: task.inputHash ?? old.inputHash,
      };
    });
    this.data = { schemaVersion: 1, planFingerprint, tasks, updatedAt: new Date().toISOString() };
    this.reindex();
    await this.flush();
    return discarded;
  }

  get(id: string): Task | undefined {
    const position = this.index.get(id);
    return position === undefined ? undefined : this.data?.tasks[position];
  }

  async update(id: string, patch: Partial<Task>): Promise<Task> {
    const data = this.requireData();
    const position = this.index.get(id);
    const current = position === undefined ? undefined : data.tasks[position];
    if (position === undefined || !current) throw new Error(`Unknown task ${id}`);
    const next = { ...current, ...patch };
    data.tasks[position] = next;
    await this.persist();
    return next;
  }

  /** Puts a task back into the queue with fresh attempts, e.g. for build-error repair. */
  async reopen(id: string, repairContext?: string): Promise<void> {
    await this.update(id, {
      status: 'pending',
      attempts: 0,
      lastError: undefined,
      finishedAt: undefined,
      repairContext,
    });
  }

  /** Gives a task back to the queue without counting the attempt (the session never had a chance). */
  async revert(id: string): Promise<void> {
    const task = this.get(id);
    if (!task) return;
    await this.update(id, {
      status: 'pending',
      attempts: Math.max(0, task.attempts - 1),
      lastError: undefined,
    });
  }

  /** Marks tasks running and counts the attempt. */
  async start(ids: readonly string[], sessionId?: string): Promise<void> {
    const data = this.requireData();
    const now = new Date().toISOString();
    const wanted = new Set(ids);
    data.tasks = data.tasks.map((t) =>
      wanted.has(t.id)
        ? {
            ...t,
            status: 'running' as const,
            attempts: t.attempts + 1,
            startedAt: now,
            sessionId,
            lastError: undefined,
          }
        : t,
    );
    await this.persist();
  }

  async complete(id: string, patch: Partial<Task> = {}): Promise<void> {
    await this.update(id, {
      status: 'completed',
      finishedAt: new Date().toISOString(),
      lastError: undefined,
      repairContext: undefined,
      ...patch,
    });
  }

  async fail(id: string, message: string): Promise<void> {
    await this.update(id, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      lastError: message,
    });
  }

  /** Appends an attempt record (capped). */
  async record(id: string, entry: Omit<TaskHistoryEntry, 'at'>): Promise<void> {
    const task = this.get(id);
    if (!task) return;
    const history = [...task.history, { ...entry, at: new Date().toISOString() }].slice(
      -HISTORY_LIMIT,
    );
    await this.update(id, { history });
  }

  /**
   * Pending (or retryable failed) tasks whose dependencies are resolved. A dependency counts as
   * resolved when it completed or permanently failed: dependencies only order the work, callers
   * can still rely on the callee's Ghidra signature.
   */
  ready(maxAttempts: number): Task[] {
    const resolved = this.resolvedSet(maxAttempts);
    return this.tasks.filter(
      (t) =>
        this.isQueued(t, maxAttempts) &&
        t.dependsOn.every((dep) => resolved.has(dep)) &&
        t.softDependsOn.every((dep) => resolved.has(dep)),
    );
  }

  /**
   * Tasks that could start now if soft dependencies were ignored: all hard dependencies are resolved but at
   * least one soft dependency is still open. Excludes tasks that are `ready`.
   */
  readyRelaxed(maxAttempts: number): Task[] {
    const resolved = this.resolvedSet(maxAttempts);
    return this.tasks.filter(
      (t) =>
        this.isQueued(t, maxAttempts) &&
        t.dependsOn.every((dep) => resolved.has(dep)) &&
        !t.softDependsOn.every((dep) => resolved.has(dep)),
    );
  }

  /** Number of queued tasks (pending or retryable) regardless of dependencies. */
  queuedCount(maxAttempts: number): number {
    return this.tasks.filter((t) => this.isQueued(t, maxAttempts)).length;
  }

  counts(): Record<Task['status'], number> {
    const counts = { pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const task of this.tasks) counts[task.status]++;
    return counts;
  }

  /** Writes pending changes and waits for any write in flight. Call before reading the file elsewhere. */
  async flush(): Promise<void> {
    if (!this.data) return;
    this.forceNow = true;
    try {
      this.schedule();
      this.wake?.();
      while (this.writing) await this.writing;
    } finally {
      this.forceNow = false;
    }
    if (this.failure) {
      const failure = this.failure;
      this.failure = undefined;
      throw failure;
    }
  }

  private isQueued(t: Task, maxAttempts: number): boolean {
    return t.status === 'pending' || (t.status === 'failed' && t.attempts < maxAttempts);
  }

  private resolvedSet(maxAttempts: number): Set<string> {
    const resolved = new Set<string>();
    for (const t of this.tasks) {
      if (t.status === 'completed' || (t.status === 'failed' && t.attempts >= maxAttempts))
        resolved.add(t.id);
    }
    return resolved;
  }

  private reindex(): void {
    this.index = new Map(this.data?.tasks.map((t, i) => [t.id, i]));
  }

  private requireData(): TaskFile {
    if (!this.data) throw new Error('Task store has no plan.');
    return this.data;
  }

  /** Unthrottled stores wait for the disk (durable after every change); throttled ones return at once. */
  private async persist(): Promise<void> {
    if (this.minWriteIntervalMs === 0) await this.flush();
    else this.schedule();
  }

  /**
   * Marks the state dirty and makes sure a write happens soon (at most one in flight, at most one per
   * `minWriteIntervalMs`). Does not wait for the disk; use `flush()` where durability matters.
   */
  private schedule(): void {
    this.requireData();
    this.dirty = true;
    if (!this.writing) this.writing = this.drain();
  }

  private async drain(): Promise<void> {
    try {
      while (this.dirty) {
        if (this.minWriteIntervalMs > 0 && !this.forceNow) {
          const wait = this.lastWrite + this.minWriteIntervalMs - Date.now();
          if (wait > 0) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, wait);
              // flush() wakes the writer early.
              this.wake = () => {
                clearTimeout(timer);
                resolve();
              };
            });
            this.wake = undefined;
          }
        }
        this.dirty = false;
        const data = this.requireData();
        data.updatedAt = new Date().toISOString();
        this.lastWrite = Date.now();
        await writeJsonAtomic(this.file, data);
      }
    } catch (error) {
      this.failure = error;
    } finally {
      this.writing = undefined;
    }
  }
}
