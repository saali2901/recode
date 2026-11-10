import type { Command } from 'commander';
import { ExitCode, RecodeError } from '../../core/errors/index.js';
import { readJson } from '../../infrastructure/filesystem/files.js';
import { ValidationReportSchema } from '../report-schema.js';
import {
  analyzeStep,
  buildStep,
  DEPENDENCY_MODES,
  applyTuning,
  buildWithRepairs,
  reconstructStep,
  validateStep,
  type PipelineDeps,
} from '../../app/pipeline.js';
import { validationReportPath } from '../../validation/comparison/validate.js';
import type { ValidationReport } from '../../validation/interfaces.js';
import type { Runtime } from '../runtime.js';

interface TuningOptions {
  parallel?: string;
  batchSize?: string;
  sessions?: string;
  dependencies?: string;
  legacy?: boolean;
}

async function pipelineDeps(runtime: Runtime, overrides: TuningOptions = {}) {
  const context = await runtime.context();
  const mode = overrides.dependencies
    ? DEPENDENCY_MODES.find((m) => m === overrides.dependencies)
    : undefined;
  if (overrides.dependencies && !mode) {
    throw new RecodeError(
      'INVALID_INPUT',
      `Unknown --dependencies mode "${overrides.dependencies}".`,
      { hint: `Use one of: ${DEPENDENCY_MODES.join(', ')}.` },
    );
  }
  const number = (text: string | undefined): number | undefined =>
    text === undefined ? undefined : Number.parseInt(text, 10);
  const config = applyTuning(context.config, {
    parallel: number(overrides.parallel),
    batchSize: number(overrides.batchSize),
    sessions: number(overrides.sessions),
    dependencies: mode,
    legacy: overrides.legacy,
  });
  const deps: PipelineDeps = {
    project: context.project,
    config,
    events: context.events,
    signal: context.signal,
    ...runtime.overrides,
  };
  return deps;
}

function printValidation(runtime: Runtime, report: ValidationReport): void {
  const symbol = { passed: '✓', failed: '✗', 'not-assessed': '–' } as const;
  runtime.out.table(
    report.checks.map((c) => [symbol[c.outcome], c.level, c.title, c.outcome, c.detail]),
    ['', 'Level', 'Check', 'Result', 'Details'],
  );
  runtime.out.line();
  runtime.out.line(report.disclaimer);
}

const binaryOption = ['--binary <id>', 'binary id (required if the project has several)'] as const;
const forceOption = ['--force', 're-run even if the step is up to date'] as const;

export function registerStepCommands(program: Command, runtime: Runtime): void {
  program
    .command('analyze')
    .description(
      'Analyze the binary with Ghidra (functions, references, symbols, types, decompiler output)',
    )
    .option(...binaryOption)
    .option(...forceOption)
    .action(async (options: { binary?: string; force?: boolean }) => {
      const deps = await pipelineDeps(runtime);
      const binary = deps.project.resolveBinary(options.binary);
      const result = await deps.project.withLock(() =>
        analyzeStep(deps, binary, { force: options.force === true }),
      );
      runtime.out.success(result.summary ?? 'analysis complete');
    });

  program
    .command('reconstruct')
    .description('Reconstruct C code with Claude Code agents; resumes interrupted runs')
    .option(...binaryOption)
    .option(...forceOption)
    .option(
      '--repair',
      'send functions with compiler errors from the last build back to the agents',
    )
    .option('--retry-failed', 'give permanently failed tasks new attempts')
    .option('--no-cache', 'do not reuse results from the persistent cache in this run')
    .option('--parallel <n>', 'maximum number of concurrent subagents (default from config: 2)')
    .option('--batch-size <n>', 'functions per lead-agent session (default from config: 6)')
    .option(
      '--sessions <n>',
      'maximum number of concurrent Claude Code sessions (default from config: 4)',
    )
    .option(
      '--dependencies <mode>',
      'how calls order the work: adaptive (default), complete, signatures, legacy',
    )
    .option('--legacy', 'original behaviour: one session at a time, one model, no routing or cache')
    .action(
      async (
        options: {
          binary?: string;
          force?: boolean;
          repair?: boolean;
          retryFailed?: boolean;
          cache?: boolean;
        } & TuningOptions,
      ) => {
        const deps = await pipelineDeps(runtime, options);
        const binary = deps.project.resolveBinary(options.binary);
        const result = await deps.project.withLock(() =>
          reconstructStep(deps, binary, {
            force: options.force === true,
            repair: options.repair === true,
            retryFailed: options.retryFailed === true,
            noCache: options.cache === false,
          }),
        );
        runtime.out.success(result.summary ?? 'reconstruction complete');
        if (result.details) {
          const d = result.details;
          runtime.out.line(
            `Sessions: ${d.sessions}, reported cost: $${d.totalCostUsd.toFixed(4)} (covered by your subscription if applicable)`,
          );
          runtime.out.line(`Source: ${d.generation.directory}`);
          const r = d.routing;
          runtime.out.line(
            `Tiers: ${
              Object.entries(r.tiers)
                .map(([t, n]) => `${t} ${n}`)
                .join(', ') || '-'
            }; escalations ${r.escalations}, ` +
              `retries ${r.retries}, cache hits ${r.cacheHits}, max concurrent sessions ${r.maxConcurrentSessions}`,
          );
          if (d.metricsFile) runtime.out.line(`Metrics: ${d.metricsFile} (see "recode perf")`);
          for (const issue of d.openIssues.slice(0, 10))
            runtime.out.warn(
              `${issue.id} accepted with open findings: ${issue.issues.slice(0, 2).join(' | ')}`,
            );
          for (const failed of d.failedTasks) runtime.out.warn(`${failed.id}: ${failed.error}`);
          if (d.failedTasks.length > 0)
            runtime.out.hint('Retry with: recode reconstruct --retry-failed');
        }
      },
    );

  program
    .command('build')
    .description('Configure with CMake and build the reconstructed C project with Ninja')
    .option(...binaryOption)
    .option(...forceOption)
    .action(async (options: { binary?: string; force?: boolean }) => {
      const deps = await pipelineDeps(runtime);
      const binary = deps.project.resolveBinary(options.binary);
      const result = await deps.project.withLock(() =>
        buildStep(deps, binary, { force: options.force === true }),
      );
      runtime.out.success(result.summary ?? 'build complete');
    });

  program
    .command('validate')
    .description(
      'Evaluate build and reconstruction quality; states clearly what could not be verified',
    )
    .option(...binaryOption)
    .option(...forceOption)
    .option(
      '--ai-review',
      'let the validation agent review each function against the original (uses Claude Code)',
    )
    .action(async (options: { binary?: string; force?: boolean; aiReview?: boolean }) => {
      const deps = await pipelineDeps(runtime);
      const binary = deps.project.resolveBinary(options.binary);
      const result = await deps.project.withLock(() =>
        validateStep(deps, binary, {
          force: options.force === true,
          aiReview: options.aiReview === true,
        }),
      );
      const report =
        result.report ??
        (await readJson(validationReportPath(deps.project, binary.id), ValidationReportSchema));
      printValidation(runtime, report);
      if (report.checks.some((c) => c.outcome === 'failed')) process.exitCode = ExitCode.Failure;
    });

  program
    .command('run')
    .description(
      'Run the whole workflow: analyze, reconstruct, build, validate (resumes where it stopped)',
    )
    .option(...binaryOption)
    .option('--parallel <n>', 'maximum number of concurrent subagents')
    .option('--batch-size <n>', 'functions per lead-agent session')
    .option('--ai-review', 'include the AI review in the validation step')
    .option(
      '--sessions <n>',
      'maximum number of concurrent Claude Code sessions (default from config: 4)',
    )
    .option(
      '--dependencies <mode>',
      'how calls order the work: adaptive (default), complete, signatures, legacy',
    )
    .option('--legacy', 'original behaviour: one session at a time, one model, no routing or cache')
    .action(async (options: { binary?: string; aiReview?: boolean } & TuningOptions) => {
      const deps = await pipelineDeps(runtime, options);
      const binary = deps.project.resolveBinary(options.binary);
      await deps.project.withLock(async () => {
        await analyzeStep(deps, binary);
        await reconstructStep(deps, binary);
        await buildWithRepairs(deps, binary);
        await validateStep(deps, binary, { aiReview: options.aiReview === true });
      });
      const report = await readJson(
        validationReportPath(deps.project, binary.id),
        ValidationReportSchema,
      );
      printValidation(runtime, report);
    });
}
