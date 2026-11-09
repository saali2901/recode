import { z } from 'zod';
import { HexSchema } from '../../input/interfaces/types.js';

/** How sure the reconstruction is. Agents must label every claim with one of these levels. */
export const ConfidenceSchema = z.enum(['certain', 'probable', 'speculative']);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const AssumptionSchema = z.object({
  text: z.string().min(1),
  confidence: ConfidenceSchema,
});
export type Assumption = z.infer<typeof AssumptionSchema>;

const C_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Result file written by the function reconstruction agents for one function. */
export const FunctionResultSchema = z.object({
  taskId: z.string(),
  address: HexSchema,
  status: z.enum(['reconstructed', 'unreconstructable']),
  name: z.string().regex(C_IDENTIFIER, 'name must be a C identifier'),
  /** Declaration ending with ';' as it appears in the generated header. */
  prototype: z.string().default(''),
  /** The complete C function definition (no #include lines). */
  code: z.string().default(''),
  /** Standard headers the function needs, e.g. "string.h". */
  includes: z.array(z.string().regex(/^[A-Za-z0-9_./]+\.h$/)).default([]),
  confidence: ConfidenceSchema,
  assumptions: z.array(AssumptionSchema).default([]),
  /** Why the function could not be reconstructed (status "unreconstructable"). */
  reason: z.string().optional(),
});
export type FunctionResult = z.infer<typeof FunctionResultSchema>;

/** Result file of the structure analyst: C type declarations shared by all functions. */
export const TypesResultSchema = z.object({
  taskId: z.literal('types'),
  /** C declarations only (typedefs, structs, enums, #defines); no includes, no include guard. */
  header: z.string(),
  items: z
    .array(
      z.object({
        name: z.string(),
        kind: z.enum(['struct', 'union', 'enum', 'typedef', 'define']),
        confidence: ConfidenceSchema,
        note: z.string().optional(),
      }),
    )
    .default([]),
  assumptions: z.array(AssumptionSchema).default([]),
});
export type TypesResult = z.infer<typeof TypesResultSchema>;

/** Result of the optional review by the validation agent. */
export const ReviewResultSchema = z.object({
  taskId: z.string(),
  verdict: z.enum(['consistent', 'concerns', 'inconsistent']),
  findings: z
    .array(
      z.object({
        severity: z.enum(['info', 'warning', 'error']),
        message: z.string(),
      }),
    )
    .default([]),
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;
