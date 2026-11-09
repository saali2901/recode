import { z } from 'zod';
import { WorkflowStatusSchema } from '../workflow/workflow.js';
import { readJsonIfExists, writeJsonAtomic } from '../../infrastructure/filesystem/files.js';

export const TaskKindSchema = z.enum(['overview', 'types', 'function']);
export type TaskKind = z.infer<typeof TaskKindSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  kind: TaskKindSchema,
  title: z.string(),
  address: z.string().optional(),
  dependsOn: z.array(z.string()),
  status: WorkflowStatusSchema,
  attempts: z.number().int().nonnegative(),
  lastError: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  sessionId: z.string().optional(),
  /** Extra context for repairs, e.g. compiler diagnostics for this function. */
  repairContext: z.string().optional(),
});
export type Task = z.infer<typeof TaskSchema>;

export const TaskFileSchema = z.object({
  schemaVersion: z.literal(1),
  /** Fingerprint of the analysis these tasks were planned from. */
  planFingerprint: z.string(),
  tasks: z.array(TaskSchema),
  updatedAt: z.string(),
});
export type TaskFile = z.infer<typeof TaskFileSchema>;

/** Persistent list of reconstruction tasks with crash-safe status transitions. */
export class TaskStore {
  private data: TaskFile | undefined;

  constructor(private readonly file: string) {}

  async load(): Promise<TaskFile | undefined> {
    this.data = await readJsonIfExists(this.file, TaskFileSchema);
    if (this.data) {
      // Tasks left "running" by a crashed process go back to pending; the attempt still counts.
      this.data.tasks = this.data.tasks.map((t) =>
        t.status === 'running' ? { ...t, status: 'pending' as const, lastError: 'Interrupted' } : t,
      );
    }
    return this.data;
  }

  get tasks(): readonly Task[] {
    return this.data?.tasks ?? [];
  }

  get planFingerprint(): string | undefined {
    return this.data?.planFingerprint;
  }

  /** Replaces the plan. Existing task states are kept only if the fingerprint is unchanged. */
  async setPlan(planFingerprint: string, planned: Task[]): Promise<void> {
    const keep = this.data?.planFingerprint === planFingerprint;
    const previous = new Map(this.data?.tasks.map((t) => [t.id, t]));
    const tasks = planned.map((task) => (keep ? (previous.get(task.id) ?? task) : task));
    this.data = { schemaVersion: 1, planFingerprint, tasks, updatedAt: new Date().toISOString() };
    await this.save();
  }

  get(id: string): Task | undefined {
    return this.data?.tasks.find((t) => t.id === id);
  }

  async update(id: string, patch: Partial<Task>): Promise<Task> {
    const data = this.requireData();
    const index = data.tasks.findIndex((t) => t.id === id);
    const current = data.tasks[index];
    if (index < 0 || !current) throw new Error(`Unknown task ${id}`);
    const next = { ...current, ...patch };
    data.tasks[index] = next;
    await this.save();
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

  /** Marks tasks running and counts the attempt. */
  async start(ids: readonly string[], sessionId?: string): Promise<void> {
    const data = this.requireData();
    const now = new Date().toISOString();
    data.tasks = data.tasks.map((t) =>
      ids.includes(t.id)
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
    await this.save();
  }

  async complete(id: string): Promise<void> {
    await this.update(id, {
      status: 'completed',
      finishedAt: new Date().toISOString(),
      lastError: undefined,
      repairContext: undefined,
    });
  }

  async fail(id: string, message: string): Promise<void> {
    await this.update(id, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      lastError: message,
    });
  }

  /**
   * Pending (or retryable failed) tasks whose dependencies are resolved. A dependency counts as
   * resolved when it completed or permanently failed: dependencies only order the work, callers
   * can still rely on the callee's Ghidra signature.
   */
  ready(maxAttempts: number): Task[] {
    const resolved = new Set(
      this.tasks
        .filter(
          (t) => t.status === 'completed' || (t.status === 'failed' && t.attempts >= maxAttempts),
        )
        .map((t) => t.id),
    );
    return this.tasks.filter(
      (t) =>
        (t.status === 'pending' || (t.status === 'failed' && t.attempts < maxAttempts)) &&
        t.dependsOn.every((dep) => resolved.has(dep)),
    );
  }

  counts(): Record<Task['status'], number> {
    const counts = { pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const task of this.tasks) counts[task.status]++;
    return counts;
  }

  private requireData(): TaskFile {
    if (!this.data) throw new Error('Task store has no plan.');
    return this.data;
  }

  private async save(): Promise<void> {
    const data = this.requireData();
    data.updatedAt = new Date().toISOString();
    await writeJsonAtomic(this.file, data);
  }
}
