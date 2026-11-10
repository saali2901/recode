import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  reconstruct,
  type ReconstructOptions,
  type ReconstructSummary,
} from '../ai/orchestration/reconstruct.js';
import { reviewReconstruction } from '../ai/orchestration/review.js';
import { createClaudeSessionRunner, type SessionRunner } from '../ai/orchestration/session.js';
import { RecodeError } from '../core/errors/index.js';
import type { EventBus } from '../core/events/event-bus.js';
import type { BinaryRecord, Project } from '../core/project/project.js';
import { WorkflowManager, type RunStepResult } from '../core/workflow/workflow.js';
import type { Decompiler } from '../decompiler/interfaces/decompiler.js';
import { GhidraDecompiler } from '../decompiler/ghidra/ghidra-decompiler.js';
import type { RecodeConfig } from '../infrastructure/config/config.js';
import {
  readJsonIfExists,
  sha256Text,
  writeJsonAtomic,
} from '../infrastructure/filesystem/files.js';
import { requireTools } from '../infrastructure/tools/doctor.js';
import { buildProject, type BuildReport } from '../validation/build/builder.js';
import type { ValidationReport } from '../validation/interfaces.js';
import { validateReconstruction } from '../validation/comparison/validate.js';

export interface PipelineDeps {
  project: Project;
  config: RecodeConfig;
  events: EventBus;
  signal?: AbortSignal | undefined;
  /** Injectable for tests; defaults to Ghidra. */
  decompiler?: Decompiler | undefined;
  /** Injectable for tests; defaults to the Claude Code CLI. */
  sessionRunner?: SessionRunner | undefined;
  /** Skip the prerequisite check (tests with mocked tools). */
  skipPrerequisites?: boolean | undefined;
}

export function workflowFor(deps: PipelineDeps, binary: BinaryRecord): WorkflowManager {
  return new WorkflowManager(deps.project.workflowFile(binary.id), binary.id, deps.events);
}

export function prepareFingerprint(binary: BinaryRecord): string {
  return sha256Text(`prepare:${binary.sha256}:${JSON.stringify(binary.metadata)}`);
}

async function hashFiles(root: string, files: string[]): Promise<string> {
  const parts: string[] = [];
  for (const file of [...files].sort()) {
    const content = await fs.readFile(path.join(root, file)).catch(() => Buffer.alloc(0));
    parts.push(`${file}:${sha256Text(content.toString('latin1'))}`);
  }
  return sha256Text(parts.join('\n'));
}

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(full, base)));
    else files.push(path.relative(base, full));
  }
  return files;
}

export async function analyzeStep(
  deps: PipelineDeps,
  binary: BinaryRecord,
  options: { force?: boolean } = {},
): Promise<RunStepResult> {
  const { project, config } = deps;
  const decompiler =
    deps.decompiler ??
    new GhidraDecompiler({
      installDir: config.tools.ghidraInstallDir,
      javaCommand: config.tools.javaCommand,
    });
  const tool = await decompiler.check();
  const fingerprint = sha256Text(
    `analyze:${binary.sha256}:${decompiler.id}:${tool.version}:${config.ghidra.maxFunctions}:${JSON.stringify(binary.metadata)}`,
  );
  return workflowFor(deps, binary).runStep({
    step: 'analyze',
    fingerprint,
    ...(options.force ? { force: true } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
    execute: async () => {
      if (!deps.skipPrerequisites) await requireTools(config, ['java']);
      const outputDirectory = project.analysisDir(binary.id);
      const summary = await decompiler.analyze({
        binaryPath: project.binaryPath(binary),
        metadata: binary.metadata,
        outputDirectory,
        workDirectory: path.join(project.paths.state, 'work', binary.id),
        logFile: path.join(project.paths.logs, `analyze-${binary.id}.log`),
        timeoutSeconds: config.ghidra.analysisTimeoutSeconds,
        maxFunctions: config.ghidra.maxFunctions,
        ...(deps.signal ? { signal: deps.signal } : {}),
      });
      await writeJsonAtomic(path.join(outputDirectory, 'metadata.json'), binary.metadata);
      for (const message of summary.warnings) deps.events.emit({ type: 'warning', message });
      return {
        summary: `${summary.tool} ${summary.toolVersion}: ${summary.functionCount} functions, ${summary.decompiledCount} decompiled`,
      };
    },
  });
}

export interface ReconstructStepResult extends RunStepResult {
  details?: ReconstructSummary;
}

export async function reconstructStep(
  deps: PipelineDeps,
  binary: BinaryRecord,
  options: ReconstructOptions & { force?: boolean } = {},
): Promise<ReconstructStepResult> {
  const { project, config, events } = deps;
  const workflow = workflowFor(deps, binary);
  const state = await workflow.getState();
  const fingerprint = sha256Text(`reconstruct:${state.steps.analyze.fingerprint ?? ''}:v1`);
  let details: ReconstructSummary | undefined;
  const result = await workflow.runStep({
    step: 'reconstruct',
    fingerprint,
    ...(options.force || options.repair || options.retryFailed ? { force: true } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
    execute: async () => {
      if (!deps.skipPrerequisites && !deps.sessionRunner)
        await requireTools(config, ['claude', 'claude-auth']);
      const runSession =
        deps.sessionRunner ??
        createClaudeSessionRunner({ project, config, events, binaryId: binary.id });
      details = await reconstruct(
        {
          project,
          binary,
          config,
          events,
          runSession,
          ...(deps.signal ? { signal: deps.signal } : {}),
        },
        options,
      );
      const done = details.generation.reconstructed;
      if (done === 0) {
        throw new RecodeError('TOOL_FAILED', 'No function could be reconstructed.', {
          hint: details.failedTasks
            .slice(0, 5)
            .map((t) => `${t.id}: ${t.error}`)
            .join('\n'),
        });
      }
      return {
        summary:
          `${done} reconstructed, ${details.generation.unreconstructed} unreconstructable, ` +
          `${details.counts.failed} failed, ${details.generation.notAttempted} not attempted`,
      };
    },
  });
  return { ...result, ...(details ? { details } : {}) };
}

export interface BuildStepResult extends RunStepResult {
  report?: BuildReport;
}

export async function buildStep(
  deps: PipelineDeps,
  binary: BinaryRecord,
  options: { force?: boolean } = {},
): Promise<BuildStepResult> {
  const { project, config } = deps;
  const sourceDir = project.sourceDir(binary.id);
  const fingerprint = sha256Text(`build:${await hashFiles(sourceDir, await listFiles(sourceDir))}`);
  let report: BuildReport | undefined;
  const result = await workflowFor(deps, binary).runStep({
    step: 'build',
    fingerprint,
    ...(options.force ? { force: true } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
    execute: async () => {
      if (!deps.skipPrerequisites) await requireTools(config, ['cmake', 'ninja', 'compiler']);
      report = await buildProject({ project, binary, config, signal: deps.signal });
      if (report.status !== 'success') {
        throw new RecodeError(
          'TOOL_FAILED',
          `Build failed (${report.status}): ${report.errorCount} error(s). Details: build/${binary.id}/build-report.json`,
          {
            hint:
              report.diagnostics
                .filter((d) => d.severity === 'error')
                .slice(0, 8)
                .map((d) => `${d.file}:${d.line}: ${d.message}`)
                .join('\n') || report.outputTail,
          },
        );
      }
      return { summary: `build succeeded with ${report.warningCount} warning(s)` };
    },
  });
  return { ...result, ...(report ? { report } : {}) };
}

export interface RepairLoopResult {
  rounds: number;
  build: BuildStepResult;
}

/**
 * Builds the project; while the build fails with errors attributable to single functions, sends exactly those
 * functions back to the agents (one tier stronger than before, with the compiler output) and rebuilds. The build is
 * incremental: unchanged generated files keep their timestamps, so only the repaired sources are recompiled.
 * Stops after `validation.autoRepairRounds` rounds or when a round fixes nothing.
 */
export async function buildWithRepairs(
  deps: PipelineDeps,
  binary: BinaryRecord,
): Promise<RepairLoopResult> {
  const rounds = deps.config.validation.autoRepairRounds;
  let round = 0;
  for (;;) {
    try {
      return {
        rounds: round,
        build: await buildStep(deps, binary, round > 0 ? { force: true } : {}),
      };
    } catch (error) {
      const retryable = error instanceof RecodeError && error.code === 'TOOL_FAILED';
      if (!retryable || round >= rounds || deps.signal?.aborted) throw error;
      const diagnostics = await readJsonIfExists(
        path.join(deps.project.buildDir(binary.id), 'build-report.json'),
        z.object({
          diagnostics: z.array(z.object({ severity: z.string(), taskId: z.string().optional() })),
        }),
      );
      const attributable = diagnostics?.diagnostics.some((d) => d.severity === 'error' && d.taskId);
      if (!attributable) throw error;
      round++;
      deps.events.emit({
        type: 'info',
        message: `Build failed; repair round ${round} of ${rounds}: sending the affected functions back to the agents.`,
      });
      await reconstructStep(deps, binary, { repair: true });
    }
  }
}

export interface ValidateStepResult extends RunStepResult {
  report?: ValidationReport;
}

export async function validateStep(
  deps: PipelineDeps,
  binary: BinaryRecord,
  options: { force?: boolean; aiReview?: boolean } = {},
): Promise<ValidateStepResult> {
  const { project, config, events } = deps;
  const inputs = [
    ...(await listFiles(path.join(project.reconstructionDir(binary.id), 'results'))).map((f) =>
      path.join('results', f),
    ),
  ];
  const buildReport = await readJsonIfExists(
    path.join(project.buildDir(binary.id), 'build-report.json'),
    z.unknown(),
  );
  const fingerprint = sha256Text(
    `validate:${options.aiReview ? 'review' : 'plain'}:${await hashFiles(project.reconstructionDir(binary.id), inputs)}:${JSON.stringify(buildReport)}`,
  );
  let report: ValidationReport | undefined;
  const result = await workflowFor(deps, binary).runStep({
    step: 'validate',
    fingerprint,
    ...(options.force ? { force: true } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
    execute: async () => {
      if (options.aiReview) {
        if (!deps.skipPrerequisites && !deps.sessionRunner)
          await requireTools(config, ['claude', 'claude-auth']);
        const runSession =
          deps.sessionRunner ??
          createClaudeSessionRunner({ project, config, events, binaryId: binary.id });
        const review = await reviewReconstruction({
          project,
          binary,
          config,
          events,
          runSession,
          ...(deps.signal ? { signal: deps.signal } : {}),
        });
        events.emit({
          type: 'info',
          message: `AI review: ${review.written}/${review.requested} reviews written.`,
        });
      }
      report = await validateReconstruction({
        project,
        binary,
        includeReviews: options.aiReview === true,
      });
      const failed = report.checks.filter((c) => c.outcome === 'failed').length;
      const passed = report.checks.filter((c) => c.outcome === 'passed').length;
      const open = report.checks.filter((c) => c.outcome === 'not-assessed').length;
      return { summary: `${passed} passed, ${failed} failed, ${open} not assessed` };
    },
  });
  return { ...result, ...(report ? { report } : {}) };
}
