import path from 'node:path';
import { pathExists, readJson } from '../../infrastructure/filesystem/files.js';
import {
  CallGraphFileSchema,
  FactsFileSchema,
  FunctionsFileSchema,
  ProgramInfoSchema,
  ReferencesFileSchema,
  SymbolsFileSchema,
  TypesFileSchema,
  type FunctionInfo,
  type ProgramInfo,
  type TypeInfo,
} from '../interfaces/schemas.js';

export const ANALYSIS_FILES = {
  program: 'program.json',
  functions: 'functions.json',
  references: 'references.json',
  symbols: 'symbols.json',
  types: 'types.json',
  callGraph: 'call-graph.json',
} as const;

/** Validates every machine-readable file of an analysis directory. */
export async function validateAnalysisDirectory(dir: string): Promise<{
  program: ProgramInfo;
  functions: FunctionInfo[];
}> {
  const program = await readJson(path.join(dir, ANALYSIS_FILES.program), ProgramInfoSchema);
  const { functions } = await readJson(
    path.join(dir, ANALYSIS_FILES.functions),
    FunctionsFileSchema,
  );
  await readJson(path.join(dir, ANALYSIS_FILES.references), ReferencesFileSchema);
  await readJson(path.join(dir, ANALYSIS_FILES.symbols), SymbolsFileSchema);
  await readJson(path.join(dir, ANALYSIS_FILES.types), TypesFileSchema);
  await readJson(path.join(dir, ANALYSIS_FILES.callGraph), CallGraphFileSchema);
  // Optional: absent for older exports and other backends, but if present it must be valid.
  const factsFile = path.join(dir, 'facts.json');
  if (await pathExists(factsFile)) await readJson(factsFile, FactsFileSchema);
  return { program, functions };
}

export async function loadFunctions(dir: string): Promise<FunctionInfo[]> {
  return (await readJson(path.join(dir, ANALYSIS_FILES.functions), FunctionsFileSchema)).functions;
}

export async function loadTypes(dir: string): Promise<TypeInfo[]> {
  return (await readJson(path.join(dir, ANALYSIS_FILES.types), TypesFileSchema)).types;
}
