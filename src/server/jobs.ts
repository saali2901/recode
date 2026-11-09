import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  analyzeStep,
  buildStep,
  reconstructStep,
  validateStep,
  type PipelineDeps,
} from '../app/pipeline.js';
import { RecodeError, errorMessage } from '../core/errors/index.js';
import { EventBus } from '../core/events/event-bus.js';
import type { Project } from '../core/project/project.js';
import { loadConfig } from '../infrastructure/config/config.js';
import { createFileLogger } from '../infrastructure/logging/logger.js';
import { EventLog } from './event-log.js';
import { LogTailer } from './log-tailer.js';

export const JobRequestSchema = z.object({
  step: z.enum(['analyze', 'reconstruct', 'build', 'validate', 'run']),
  binaryId: z.string().min(1).optional(),
  force: z.boolean().optional(),
  aiReview: z.boolean().optional(),
});
export type JobRequest = z.infer<typeof JobRequestSchema>;

export interface JobInfo {
  id: string;
  step: JobRequest['step'];
  binaryId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  summary?: string;
  error?: string;
  /** Machine-readable cause, e.g. RATE_LIMIT or UNTRUSTED, so the UI can offer the right action. */
  errorCode?: string;
  hint?: string;
}

export type PipelineOverrides = Partial<
  Pick<PipelineDeps, 'decompiler' | 'sessionRunner' | 'skipPrerequisites'>
>;

/** Runs workflow steps for one project in the background and records their progress. */
export class JobManager {
  readonly log = new EventLog();
  private current: JobInfo | undefined;
  private last: JobInfo | undefined;
  private controller: AbortController | undefined;
  private finished: Promise<void> = Promise.resolve();

  constructor(private readonly overrides: PipelineOverrides = {}) {}

  get active(): JobInfo | undefined {
    return this.current;
  }

  /** The running job, or the most recent finished one. */
  get latest(): JobInfo | undefined {
    return this.current ?? this.last;
  }

  /** Resolves when the running job (if any) has ended. Used by tests and shutdown. */
  whenIdle(): Promise<void> {
    return this.finished;
  }

  cancel(): boolean {
    if (!this.controller) return false;
    this.controller.abort();
    return true;
  }

  async start(project: Project, request: JobRequest): Promise<JobInfo> {
    if (this.current) {
      throw new RecodeError('WORKFLOW', `A job is already running (${this.current.step}).`);
    }
    const binary = project.resolveBinary(request.binaryId);
    const config = await loadConfig({ projectLayer: project.configLayer });
    const controller = new AbortController();
    const events = new EventBus();
    events.subscribe((event) => this.log.push('event', event));
    const logger = createFileLogger(project.paths.logs, config.logging.level);
    events.subscribe((event) => logger.info({ event }, event.type));

    const job: JobInfo = {
      id: randomUUID(),
      step: request.step,
      binaryId: binary.id,
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    this.current = job;
    this.controller = controller;
    this.log.push('job', job);

    const tailer = new LogTailer(project.paths.logs, (line) => this.log.push('log', line));
    await tailer.start();

    const deps: PipelineDeps = {
      project,
      config,
      events,
      signal: controller.signal,
      ...this.overrides,
    };

    this.finished = (async () => {
      let outcome: Partial<JobInfo>;
      try {
        const summary = await project.withLock(() => executeSteps(deps, binary.id, request));
        outcome = { status: 'completed', summary };
      } catch (error) {
        const cancelled =
          controller.signal.aborted || (error instanceof RecodeError && error.code === 'CANCELLED');
        outcome = {
          status: cancelled ? 'cancelled' : 'failed',
          error: errorMessage(error),
          ...(error instanceof RecodeError ? { errorCode: error.code } : {}),
          ...(error instanceof RecodeError && error.hint ? { hint: error.hint } : {}),
        };
      }
      await tailer.stop();
      const done: JobInfo = { ...job, ...outcome, finishedAt: new Date().toISOString() };
      this.last = done;
      this.current = undefined;
      this.controller = undefined;
      this.log.push('job', done);
    })();
    return job;
  }
}

async function executeSteps(
  deps: PipelineDeps,
  binaryId: string,
  request: JobRequest,
): Promise<string> {
  const binary = deps.project.resolveBinary(binaryId);
  const force = request.force === true;
  const summaries: string[] = [];
  const note = (label: string, summary: string | undefined): void => {
    summaries.push(`${label}: ${summary ?? 'done'}`);
  };
  const wants = (step: string): boolean => request.step === step || request.step === 'run';

  if (wants('analyze')) note('analyze', (await analyzeStep(deps, binary, { force })).summary);
  if (wants('reconstruct')) {
    note('reconstruct', (await reconstructStep(deps, binary, { force })).summary);
  }
  if (wants('build')) note('build', (await buildStep(deps, binary, { force })).summary);
  if (wants('validate')) {
    note(
      'validate',
      (await validateStep(deps, binary, { force, aiReview: request.aiReview === true })).summary,
    );
  }
  return summaries.join(' | ');
}

/** Keeps one JobManager per project directory. */
export class JobRegistry {
  private readonly managers = new Map<string, JobManager>();

  constructor(private readonly overrides: PipelineOverrides = {}) {}

  forProject(projectRoot: string): JobManager {
    const key = path.resolve(projectRoot);
    let manager = this.managers.get(key);
    if (!manager) {
      manager = new JobManager(this.overrides);
      this.managers.set(key, manager);
    }
    return manager;
  }

  /** Aborts all running jobs and waits for them to finish. */
  async shutdown(): Promise<void> {
    for (const manager of this.managers.values()) manager.cancel();
    await Promise.all([...this.managers.values()].map((m) => m.whenIdle()));
  }
}
