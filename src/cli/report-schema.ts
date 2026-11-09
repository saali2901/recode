import { z } from 'zod';
import type { ValidationReport } from '../validation/interfaces.js';

export const ValidationReportSchema: z.ZodType<ValidationReport> = z.object({
  generatedAt: z.string(),
  disclaimer: z.string(),
  checks: z.array(
    z.object({
      id: z.string(),
      level: z.enum(['syntactic', 'compiled', 'coverage', 'functional', 'fidelity', 'ai-review']),
      title: z.string(),
      outcome: z.enum(['passed', 'failed', 'not-assessed']),
      detail: z.string(),
    }),
  ),
});
