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

/**
 * Optional structured facts exported by the Ghidra script next to the classic files (older analyses and other
 * backends may not have it). Everything here comes from Ghidra's program database, not from text matching.
 */
export const FunctionFactsSchema = z.object({
  address: HexSchema,
  basicBlocks: z.number().int().nonnegative(),
  instructionCount: z.number().int().nonnegative(),
  /** Calls whose target is computed at run time (function pointers, vtables, import thunks excluded). */
  indirectCalls: z.number().int().nonnegative().default(0),
  /** Computed jumps (jump tables, tail calls through registers). */
  computedJumps: z.number().int().nonnegative().default(0),
  hasNoReturn: z.boolean().default(false),
  stackFrameSize: z.number().int().nonnegative().optional(),
  /** Addresses of data (non-function) locations this function references. */
  dataRefs: z.array(HexSchema).default([]),
});
export type FunctionFacts = z.infer<typeof FunctionFactsSchema>;

export const FactsFileSchema = z.object({
  functions: z.array(FunctionFactsSchema),
  strings: z.array(z.object({ address: HexSchema, value: z.string(), length: z.number().int() })),
  imports: z.array(
    z.object({ library: z.string(), name: z.string(), address: z.string().nullable() }),
  ),
  exports: z.array(z.object({ name: z.string(), address: HexSchema })),
  /** Non-fatal problems while collecting facts (a section may be partial). */
  warnings: z.array(z.string()).default([]),
});
export type FactsFile = z.infer<typeof FactsFileSchema>;
