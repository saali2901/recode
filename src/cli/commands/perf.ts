import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { z } from 'zod';
import { metricsDir } from '../../ai/orchestration/reconstruct.js';
import { RecodeError } from '../../core/errors/index.js';
import { pathExists, readJsonIfExists } from '../../infrastructure/filesystem/files.js';
import {
  compareRuns,
  loadRun,
  summarize,
  type RunMetrics,
} from '../../infrastructure/monitoring/run-metrics.js';
import type { Runtime } from '../runtime.js';

const AnalysisTimingSchema = z.object({
  ghidraMs: z.number(),
  decompilerThreads: z.number(),
  functions: z.number(),
  decompiled: z.number(),
  failedFunctions: z.number(),
  toolVersion: z.string(),
});

async function listRuns(directory: string): Promise<string[]> {
  if (!(await pathExists(directory))) return [];
  return (await fs.readdir(directory))
    .filter((n) => n.endsWith('.json') && n !== 'latest.json' && n !== 'analysis.json')
    .map((n) => n.slice(0, -'.json'.length))
    .sort();
}

async function resolveRun(directory: string, name: string): Promise<RunMetrics> {
  const run = await loadRun(directory, name);
  if (!run) {
    throw new RecodeError('INVALID_INPUT', `No metrics found for run "${name}".`, {
      hint: `Available runs: ${(await listRuns(directory)).join(', ') || 'none yet - run "recode reconstruct"'}.`,
    });
  }
  return run;
}

export function registerPerf(program: Command, runtime: Runtime): void {
  program
    .command('perf')
    .description('Show performance metrics of reconstruction runs and compare two runs')
    .option('--binary <id>', 'binary id (required if the project has several)')
    .option('--run <name>', 'run to show (default: the latest)')
    .option('--list', 'list the recorded runs')
    .option(
      '--compare <runs>',
      'compare two runs, written as "<runA>,<runB>" (e.g. legacy vs optimized)',
    )
    .option('--json', 'machine-readable output')
    .action(
      async (options: {
        binary?: string;
        run?: string;
        list?: boolean;
        compare?: string;
        json?: boolean;
      }) => {
        const { project } = await runtime.context();
        const binary = project.resolveBinary(options.binary);
        const dir = metricsDir(project, binary.id);
        const out = runtime.out;
        if (options.list) {
          const runs = await listRuns(dir);
          if (options.json) out.json(runs);
          else for (const name of runs) out.line(name);
          return;
        }
        if (options.compare) {
          const [a, b] = options.compare.split(',').map((n) => n.trim());
          if (!a || !b) {
            throw new RecodeError('INVALID_INPUT', 'Use: recode perf --compare <runA>,<runB>');
          }
          for (const line of compareRuns(await resolveRun(dir, a), await resolveRun(dir, b)))
            out.line(line);
          return;
        }
        const run = await resolveRun(dir, options.run ?? 'latest');
        const analysis = await readJsonIfExists(
          path.join(dir, 'analysis.json'),
          AnalysisTimingSchema,
        ).catch(() => undefined);
        const s = summarize(run);
        if (options.json) {
          out.json({ run, summary: s, analysis });
          return;
        }
        out.line(`Run ${run.runId}  [${run.mode}]  ${run.binaryId}`);
        if (analysis) {
          out.line(
            `Ghidra: ${(analysis.ghidraMs / 1000).toFixed(1)} s (${analysis.functions} functions, ${analysis.decompiled} decompiled, ` +
              `${analysis.failedFunctions} failed, ${analysis.decompilerThreads} decompiler thread(s), ${analysis.toolVersion})`,
          );
        }
        out.line(
          `Reconstruction: ${s.wallSeconds.toFixed(1)} s wall, ${s.modelCalls} model sessions, ` +
            `${s.inputTokens} input / ${s.outputTokens} output tokens, cost reported by Claude Code $${s.costUsd.toFixed(4)}`,
        );
        out.line(
          `Concurrency: max ${s.workersMax}, average ${s.workersAverage}; mean queue wait ${s.meanQueueWaitSeconds.toFixed(1)} s; ` +
            `mean ${s.meanSecondsPerFunctionTask.toFixed(1)} s per task`,
        );
        out.line(
          `Results: ${s.accepted} accepted, ${s.failed} failed permanently, ${s.escalations} escalations, ${s.retries} retries, ` +
            `cache hit rate ${(s.cacheHitRate * 100).toFixed(0)} %, ${run.counters.compileErrors} compile errors in ${run.counters.compileChecks} checks`,
        );
        out.line();
        out.table(
          s.perModel.map((m) => [
            m.tier,
            m.model,
            String(m.calls),
            m.seconds.toFixed(1),
            String(m.inputTokens),
            String(m.outputTokens),
            String(m.failures),
          ]),
          ['Tier', 'Model', 'Sessions', 'Seconds', 'Input tokens', 'Output tokens', 'Failed'],
        );
        out.line();
        out.table(
          Object.entries(run.phases).map(([k, v]) => [k, (v / 1000).toFixed(2)]),
          ['Phase', 'Seconds'],
        );
        out.line();
        out.line(
          'Token counts and cost are reported by the Claude Code CLI; they are empty when the installed version does not report them.',
        );
      },
    );
}
