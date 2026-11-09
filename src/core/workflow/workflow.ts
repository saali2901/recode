import { z } from 'zod';
import type { EventBus } from '../events/event-bus.js';
import { RecodeError, errorMessage } from '../errors/index.js';
import { readJsonIfExists, writeJsonAtomic } from '../../infrastructure/filesystem/files.js';

export const WorkflowStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
]);
export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;

export const STEP_ORDER = ['prepare', 'analyze', 'reconstruct', 'build', 'validate'] as const;
export type StepName = (typeof STEP_ORDER)[number];
export const StepNameSchema = z.enum(STEP_ORDER);

export const StepStateSchema = z.object({
  status: WorkflowStatusSchema,
  attempts: z.number().int().nonnegative(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  error: z.string().optional(),
  /** Hash of the inputs the step ran with; equal fingerprint + completed means "skip". */
  fingerprint: z.string().optional(),
  summary: z.string().optional(),
});
export type StepState = z.infer<typeof StepStateSchema>;

export const WorkflowStateSchema = z.object({
  schemaVersion: z.literal(1),
  binaryId: z.string(),
  currentStep: StepNameSchema.optional(),
  steps: z.record(StepNameSchema, StepStateSchema),
  updatedAt: z.string(),
});
export type WorkflowState = z.infer<typeof WorkflowStateSchema>;

export function initialWorkflowState(binaryId: string): WorkflowState {
  const steps = Object.fromEntries(
    STEP_ORDER.map((step) => [step, { status: 'pending', attempts: 0 } satisfies StepState]),
  ) as Record<StepName, StepState>;
  return { schemaVersion: 1, binaryId, steps, updatedAt: new Date().toISOString() };
}

export interface StepExecution {
  /** One-line result stored with the step. */
  summary: string;
}

export interface RunStepOptions {
  step: StepName;
  fingerprint: string;
  /** Re-run even if the step completed with the same inputs. */
  force?: boolean;
  signal?: AbortSignal;
  execute: () => Promise<StepExecution>;
}

export interface RunStepResult {
  skipped: boolean;
  summary: string | undefined;
}

/** Persists and drives the per-binary workflow state machine. */
export class WorkflowManager {
  private state: WorkflowState | undefined;

  constructor(
    private readonly file: string,
    private readonly binaryId: string,
    private readonly events: EventBus,
  ) {}

  /**
   * Loads state from disk. Steps left in "running" by a crashed process become "failed"
   * with an explanatory message, so they can be retried deliberately.
   */
  async load(): Promise<WorkflowState> {
    const stored = await readJsonIfExists(this.file, WorkflowStateSchema);
    const state = stored ?? initialWorkflowState(this.binaryId);
    for (const step of STEP_ORDER) {
      const entry = state.steps[step];
      if (entry.status === 'running') {
        state.steps[step] = {
          ...entry,
          status: 'failed',
          error: 'Interrupted: the previous run ended unexpectedly.',
          finishedAt: new Date().toISOString(),
        };
      }
    }
    this.state = state;
    return state;
  }

  async getState(): Promise<WorkflowState> {
    return this.state ?? (await this.load());
  }

  /** Marks a step as completed without running it (used by import for "prepare"). */
  async markCompleted(step: StepName, fingerprint: string, summary: string): Promise<void> {
    const state = await this.getState();
    const now = new Date().toISOString();
    state.steps[step] = {
      status: 'completed',
      attempts: state.steps[step].attempts,
      startedAt: now,
      finishedAt: now,
      fingerprint,
      summary,
    };
    await this.save(state);
  }

  async runStep(options: RunStepOptions): Promise<RunStepResult> {
    const state = await this.getState();
    const { step } = options;
    const existing = state.steps[step];

    this.assertPrerequisites(state, step);

    if (
      !options.force &&
      existing.status === 'completed' &&
      existing.fingerprint === options.fingerprint
    ) {
      this.events.emit({ type: 'step-completed', step, binaryId: this.binaryId, skipped: true });
      return { skipped: true, summary: existing.summary };
    }

    state.currentStep = step;
    state.steps[step] = {
      status: 'running',
      attempts: existing.attempts + 1,
      startedAt: new Date().toISOString(),
      fingerprint: options.fingerprint,
    };
    await this.save(state);
    this.events.emit({ type: 'step-started', step, binaryId: this.binaryId });

    try {
      const result = await options.execute();
      if (options.signal?.aborted) throw new RecodeError('CANCELLED', 'Cancelled.');
      state.steps[step] = {
        ...state.steps[step],
        status: 'completed',
        finishedAt: new Date().toISOString(),
        summary: result.summary,
      };
      this.invalidateDownstream(state, step);
      await this.save(state);
      this.events.emit({ type: 'step-completed', step, binaryId: this.binaryId, skipped: false });
      return { skipped: false, summary: result.summary };
    } catch (error) {
      const cancelled =
        options.signal?.aborted === true ||
        (error instanceof RecodeError && error.code === 'CANCELLED');
      state.steps[step] = {
        ...state.steps[step],
        status: cancelled ? 'cancelled' : 'failed',
        finishedAt: new Date().toISOString(),
        error: errorMessage(error),
      };
      await this.save(state);
      this.events.emit({
        type: 'step-failed',
        step,
        binaryId: this.binaryId,
        message: errorMessage(error),
      });
      throw error;
    }
  }

  private assertPrerequisites(state: WorkflowState, step: StepName): void {
    const index = STEP_ORDER.indexOf(step);
    const previous = STEP_ORDER[index - 1];
    if (previous && state.steps[previous].status !== 'completed') {
      throw new RecodeError(
        'WORKFLOW',
        `Step "${step}" requires "${previous}" to be completed first.`,
        {
          hint: `Current status of "${previous}": ${state.steps[previous].status}. Run "recode ${previous}".`,
        },
      );
    }
  }

  private invalidateDownstream(state: WorkflowState, step: StepName): void {
    for (const later of STEP_ORDER.slice(STEP_ORDER.indexOf(step) + 1)) {
      const entry = state.steps[later];
      if (entry.status !== 'pending') {
        state.steps[later] = { status: 'pending', attempts: entry.attempts };
      }
    }
  }

  private async save(state: WorkflowState): Promise<void> {
    state.updatedAt = new Date().toISOString();
    this.state = state;
    await writeJsonAtomic(this.file, state);
  }
}
