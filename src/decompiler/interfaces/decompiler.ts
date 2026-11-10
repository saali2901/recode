import type { BinaryMetadata } from '../../input/interfaces/types.js';
import type { ProgramInfo } from './schemas.js';

export interface DecompileRequest {
  binaryPath: string;
  metadata: BinaryMetadata;
  /** Final analysis directory; written atomically (staging + rename). */
  outputDirectory: string;
  /** Scratch directory for tool-internal projects. */
  workDirectory: string;
  logFile: string;
  timeoutSeconds: number;
  maxFunctions: number;
  /** Decompiler threads inside the backend (1 = sequential); backends may ignore it. */
  decompilerThreads?: number;
  signal?: AbortSignal;
}

export interface DecompileSummary {
  tool: string;
  toolVersion: string;
  program: ProgramInfo;
  functionCount: number;
  decompiledCount: number;
  failedFunctions: number;
  /** Non-fatal problems the user should know about, e.g. a degraded processor language. */
  warnings: string[];
}

/** A reverse-engineering backend producing the analysis files described in docs/architecture.md. */
export interface Decompiler {
  readonly id: string;
  /** Throws RecodeError(PREREQUISITE) with a hint if the backend is not usable. */
  check(): Promise<{ version: string; details: string }>;
  analyze(request: DecompileRequest): Promise<DecompileSummary>;
}
