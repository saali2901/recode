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
import { VALIDATION_CHECKS } from './checks.js';

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
  const input = {
    build,
    functionResults,
    totalFunctions: analyzable.length,
    reviews,
    hasExecutableComparator: false,
  };
  const report: ValidationReport = {
    generatedAt: new Date().toISOString(),
    checks: VALIDATION_CHECKS.flatMap((check) => check(input)),
    disclaimer: DISCLAIMER,
  };
  await writeJsonAtomic(validationReportPath(project, binary.id), report);
  return report;
}

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
