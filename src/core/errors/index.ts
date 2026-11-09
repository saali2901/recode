/** Stable machine-readable error categories. */
export type ErrorCode =
  | 'USAGE'
  | 'INVALID_INPUT'
  | 'UNSAFE_PATH'
  | 'ARCHIVE'
  | 'PROJECT'
  | 'PREREQUISITE'
  | 'TOOL_FAILED'
  | 'PARSE'
  | 'WORKFLOW'
  | 'CANCELLED'
  | 'INTERNAL';

/** Process exit codes used by the CLI. */
export const ExitCode = {
  Ok: 0,
  Failure: 1,
  Usage: 2,
  Prerequisite: 3,
  Project: 4,
  ToolFailed: 5,
  Cancelled: 130,
} as const;

const EXIT_CODE_BY_ERROR: Record<ErrorCode, number> = {
  USAGE: ExitCode.Usage,
  INVALID_INPUT: ExitCode.Usage,
  UNSAFE_PATH: ExitCode.Usage,
  ARCHIVE: ExitCode.Usage,
  PROJECT: ExitCode.Project,
  PREREQUISITE: ExitCode.Prerequisite,
  TOOL_FAILED: ExitCode.ToolFailed,
  PARSE: ExitCode.ToolFailed,
  WORKFLOW: ExitCode.Failure,
  CANCELLED: ExitCode.Cancelled,
  INTERNAL: ExitCode.Failure,
};

/** Base class for all expected, user-presentable failures. */
export class RecodeError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;

  constructor(code: ErrorCode, message: string, options?: { hint?: string; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RecodeError';
    this.code = code;
    this.hint = options?.hint;
  }

  get exitCode(): number {
    return EXIT_CODE_BY_ERROR[this.code];
  }
}

/** Converts any thrown value into a RecodeError without losing the original message. */
export function toRecodeError(error: unknown): RecodeError {
  if (error instanceof RecodeError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new RecodeError('INTERNAL', message, { cause: error });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
