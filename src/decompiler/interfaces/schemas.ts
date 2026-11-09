import { z } from 'zod';
import { HexSchema } from '../../input/interfaces/types.js';

export const FunctionInfoSchema = z.object({
  address: HexSchema,
  name: z.string(),
  signature: z.string(),
  returnType: z.string().optional(),
  callingConvention: z.string().nullish(),
  parameterCount: z.number().int().nonnegative().optional(),
  size: z.number().int().nonnegative(),
  isThunk: z.boolean(),
  isExternal: z.boolean(),
  hasUserDefinedName: z.boolean().optional(),
  calls: z.array(HexSchema),
  calledBy: z.array(HexSchema),
  /** Path relative to the analysis directory; null if decompilation failed or was skipped. */
  decompiledFile: z.string().nullable(),
  decompileError: z.string().nullable().optional(),
  disassemblyFile: z.string().nullable(),
});
export type FunctionInfo = z.infer<typeof FunctionInfoSchema>;
export const FunctionsFileSchema = z.object({ functions: z.array(FunctionInfoSchema) });

export const ReferenceSchema = z.object({
  from: HexSchema,
  to: HexSchema,
  type: z.string(),
  fromFunction: HexSchema.optional(),
  external: z.boolean().optional(),
});
export const ReferencesFileSchema = z.object({ references: z.array(ReferenceSchema) });

export const SymbolSchema = z.object({
  name: z.string(),
  address: HexSchema,
  type: z.string(),
  source: z.string(),
  namespace: z.string().optional(),
  isExternal: z.boolean().optional(),
});
export const SymbolsFileSchema = z.object({ symbols: z.array(SymbolSchema) });

export const TypeInfoSchema = z.object({
  name: z.string(),
  kind: z.enum(['struct', 'union', 'enum', 'typedef']),
  category: z.string().optional(),
  size: z.number().int(),
  fields: z
    .array(
      z.object({
        name: z.string(),
        type: z.string(),
        offset: z.number().int(),
        size: z.number().int(),
      }),
    )
    .optional(),
  values: z.array(z.object({ name: z.string(), value: z.number() })).optional(),
  baseType: z.string().optional(),
});
export type TypeInfo = z.infer<typeof TypeInfoSchema>;
export const TypesFileSchema = z.object({ types: z.array(TypeInfoSchema) });

export const CallGraphFileSchema = z.object({
  edges: z.array(z.object({ from: HexSchema, to: HexSchema })),
});

export const ProgramInfoSchema = z.object({
  ghidraVersion: z.string(),
  language: z.string(),
  compiler: z.string(),
  imageBase: z.string(),
  executableFormat: z.string(),
  functionCount: z.number().int(),
  symbolCount: z.number().int(),
  typeCount: z.number().int(),
});
export type ProgramInfo = z.infer<typeof ProgramInfoSchema>;
