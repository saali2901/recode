import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { BinaryRecord, Project } from '../../core/project/project.js';
import { loadFunctions } from '../../decompiler/extraction/analysis-files.js';
import {
  pathExists,
  readJson,
  readJsonIfExists,
  writeJsonAtomic,
} from '../../infrastructure/filesystem/files.js';
import {
  FunctionResultSchema,
  ReviewResultSchema,
  type FunctionResult,
  type ReviewResult,
} from '../../reconstruction/interfaces/results.js';
import { functionTaskId } from '../../reconstruction/c/c-generator.js';
import type { BuildReport } from '../build/builder.js';
import type { ValidationReport } from '../interfaces.js';
import { VALIDATION_CHECKS, type QualityLedger } from './checks.js';
import type { RecodeConfig } from '../../infrastructure/config/config.js';
import { runDifferentialTest, type DifferentialOutcome } from '../differential/differential.js';
import { findCCompiler } from '../static/compile-check.js';

const DISCLAIMER =
  'ReCode cannot prove that reconstructed code is equivalent to the original binary. ' +
  'Passed checks only cover the stated level; levels marked not-assessed have no evidence either way.';

export function validationReportPath(project: Project, binaryId: string): string {
  return path.join(project.reconstructionDir(binaryId), 'validation.json');
}

/** Evaluates all registered checks against stored artifacts and writes the validation report. */
export async function validateReconstruction(options: {
  project: Project;
  binary: BinaryRecord;
  includeReviews: boolean;
  config?: RecodeConfig | undefined;
  signal?: AbortSignal | undefined;
}): Promise<ValidationReport> {
  const { project, binary } = options;
  const functions = await loadFunctions(project.analysisDir(binary.id));
  const analyzable = functions.filter((f) => !f.isExternal && !f.isThunk);

  const resultsDir = path.join(project.reconstructionDir(binary.id), 'results');
  const functionResults: FunctionResult[] = [];
  for (const fn of analyzable) {
    const file = path.join(resultsDir, `${functionTaskId(fn.address)}.json`);
    if (await pathExists(file)) functionResults.push(await readJson(file, FunctionResultSchema));
  }

  const reviewsDir = path.join(project.reconstructionDir(binary.id), 'reviews');
  let reviews: ReviewResult[] | undefined;
  if (options.includeReviews && (await pathExists(reviewsDir))) {
    reviews = [];
    for (const name of await fs.readdir(reviewsDir)) {
      if (name.endsWith('.json'))
        reviews.push(await readJson(path.join(reviewsDir, name), ReviewResultSchema));
    }
  }

  const build = await readJsonIfExists(
    path.join(project.buildDir(binary.id), 'build-report.json'),
    BuildReportShape,
  );
  const quality = await readJsonIfExists(
    path.join(project.reconstructionDir(binary.id), 'quality.json'),
    QualityShape,
  ).catch(() => undefined);
  const specFile = options.config?.validation.differentialSpec;
  let differential: DifferentialOutcome | undefined;
  if (specFile) {
    differential = await runDifferentialTest({
      projectRoot: project.root,
      specFile,
      buildDir: project.buildDir(binary.id),
      workDirectory: path.join(project.paths.state, 'work', binary.id, 'differential'),
      compiler: await findCCompiler(options.config?.tools.cCompiler),
      reconstructedNames: new Set(
        functionResults.filter((r) => r.status === 'reconstructed').map((r) => r.name),
      ),
      signal: options.signal,
    }).catch((error: unknown): DifferentialOutcome => ({
      outcome: 'not-assessed',
      detail: `The differential test could not run: ${error instanceof Error ? error.message : String(error)}`,
      cases: [],
    }));
  }
  const input = {
    build,
    functionResults,
    totalFunctions: analyzable.length,
    reviews,
    hasExecutableComparator: specFile !== undefined,
    differential,
    quality,
  };
  const report: ValidationReport = {
    generatedAt: new Date().toISOString(),
    checks: VALIDATION_CHECKS.flatMap((check) => check(input)),
    disclaimer: DISCLAIMER,
  };
  await writeJsonAtomic(validationReportPath(project, binary.id), report);
  return report;
}

const QualityShape = z.object({
  tasks: z.array(
    z.object({
      taskId: z.string(),
      status: z.string(),
      tier: z.string().optional(),
      escalations: z.number().default(0),
      fromCache: z.boolean().default(false),
      openIssues: z.array(z.string()).default([]),
    }),
  ),
});
// compile-time proof that the parsed shape is the ledger the checks expect
const _ledgerCheck: (value: z.infer<typeof QualityShape>) => QualityLedger = (value) => value;
void _ledgerCheck;

const BuildReportShape: z.ZodType<BuildReport> = z.object({
  status: z.enum(['success', 'configure-failed', 'build-failed']),
  builtAt: z.string(),
  errorCount: z.number(),
  warningCount: z.number(),
  diagnostics: z.array(
    z.object({
      file: z.string(),
      line: z.number(),
      column: z.number().optional(),
      severity: z.enum(['error', 'warning', 'note']),
      message: z.string(),
      taskId: z.string().optional(),
    }),
  ),
  outputTail: z.string(),
});
