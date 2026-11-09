import type { BinaryRecord, Project } from '../../core/project/project.js';
import type { FunctionInfo } from '../../decompiler/interfaces/schemas.js';
import type { FunctionResult, TypesResult } from './results.js';

export interface GenerationInput {
  project: Project;
  binary: BinaryRecord;
  functions: FunctionInfo[];
  /** Accepted results keyed by task id. */
  functionResults: Map<string, FunctionResult>;
  typesResult: TypesResult | undefined;
}

export interface GeneratedFileMap {
  /** Project-relative generated source file -> task id (or "types"). */
  files: Record<string, string>;
  /** Line number in the functions header -> task id of the declaration on that line. */
  headerLines: Record<string, string>;
}

export interface GenerationReport {
  directory: string;
  fileMap: GeneratedFileMap;
  reconstructed: number;
  unreconstructed: number;
  notAttempted: number;
}

/** A reconstruction target. The MVP ships only C; other languages implement this interface. */
export interface TargetLanguage {
  readonly id: string;
  generateProject(input: GenerationInput): Promise<GenerationReport>;
}
