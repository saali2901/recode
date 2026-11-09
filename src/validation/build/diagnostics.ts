export interface Diagnostic {
  file: string;
  line: number;
  column?: number | undefined;
  severity: 'error' | 'warning' | 'note';
  message: string;
  /** Task responsible for the file/line, if it could be determined. */
  taskId?: string | undefined;
}

const GCC_STYLE = /^(.+?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note):\s*(.*)$/;
const MSVC_STYLE =
  /^(.+?)\((\d+)(?:,(\d+))?\)\s*:\s*(fatal error|error|warning)\s+[A-Z]+\d+:\s*(.*)$/;

/** Parses gcc/clang/MSVC diagnostics from compiler output. Unrecognized lines are ignored. */
export function parseDiagnostics(output: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const match = GCC_STYLE.exec(line) ?? MSVC_STYLE.exec(line);
    if (!match) continue;
    const [, file, lineNo, column, kind, message] = match;
    if (!file || !lineNo || !kind || message === undefined) continue;
    const severity = kind.includes('error') ? 'error' : kind === 'warning' ? 'warning' : 'note';
    const key = `${file}:${lineNo}:${kind}:${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    diagnostics.push({
      file,
      line: Number.parseInt(lineNo, 10),
      ...(column ? { column: Number.parseInt(column, 10) } : {}),
      severity,
      message: message.trim(),
    });
  }
  return diagnostics;
}
