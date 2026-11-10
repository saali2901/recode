import fs from 'node:fs/promises';
import path from 'node:path';
import type { FunctionInfo } from '../../decompiler/interfaces/schemas.js';
import {
  renderFunctionFile,
  renderTypesHeader,
  terminated,
} from '../../reconstruction/c/c-generator.js';
import type { FunctionResult } from '../../reconstruction/interfaces/results.js';
import { writeFileAtomic } from '../../infrastructure/filesystem/files.js';
import { runProcess } from '../../infrastructure/process/process-manager.js';
import { which } from '../../infrastructure/process/which.js';
import { parseDiagnostics } from '../build/diagnostics.js';
import type { Finding } from './function-validator.js';

/** Finds the C compiler the way `recode doctor` does; undefined when none is installed. */
export async function findCCompiler(configured: string | undefined): Promise<string | undefined> {
  const candidates = configured
    ? [configured]
    : process.platform === 'win32'
      ? ['gcc', 'clang', 'cl']
      : ['cc', 'gcc', 'clang'];
  for (const candidate of candidates) {
    const found = await which(candidate);
    if (found) return found;
  }
  return undefined;
}

const IMPLICIT = /implicit declaration of function\s+[‘'`"]?([A-Za-z_]\w*)/;

export interface CompileCheckOutcome {
  /** False when no compiler was available or the compiler is not gcc/clang compatible (not assessed). */
  ran: boolean;
  findings: Finding[];
  /** Functions the code calls that no header declares (decompiler names of not yet reconstructed callees). */
  unresolvedCalls: string[];
}

/**
 * Stage 2a: compiles ONE reconstructed function with `-fsyntax-only` against the shared types and the prototypes of
 * all other accepted functions. Takes seconds instead of a whole-project build and attributes every error to the
 * function directly. Calls to functions without a declaration are not errors here (their callee may not be
 * reconstructed yet); they are reported separately. Never executes anything it compiled.
 */
export async function compileCheckFunction(options: {
  compiler: string | undefined;
  workDirectory: string;
  info: FunctionInfo;
  result: FunctionResult;
  typesHeader: string | undefined;
  /** Prototypes of the other accepted functions. */
  otherPrototypes: readonly string[];
  timeoutMs?: number;
  signal?: AbortSignal | undefined;
}): Promise<CompileCheckOutcome> {
  const { compiler, result } = options;
  if (!compiler || result.status !== 'reconstructed') {
    return { ran: false, findings: [], unresolvedCalls: [] };
  }
  const dir = path.join(options.workDirectory, result.name.replace(/\W/g, '_'));
  await fs.mkdir(path.join(dir, 'include'), { recursive: true });
  await writeFileAtomic(
    path.join(dir, 'include', 'recode_types.h'),
    renderTypesHeader(options.typesHeader),
  );
  await writeFileAtomic(
    path.join(dir, 'include', 'recode_functions.h'),
    [
      '#ifndef RECODE_FUNCTIONS_H',
      '#define RECODE_FUNCTIONS_H',
      '#include "recode_types.h"',
      ...options.otherPrototypes.map(terminated),
      terminated(result.prototype),
      '#endif',
      '',
    ].join('\n'),
  );
  const source = path.join(dir, 'function.c');
  await writeFileAtomic(source, renderFunctionFile(options.info, result));
  const run = await runProcess({
    command: compiler,
    args: [
      '-fsyntax-only',
      '-std=gnu11',
      '-Wall',
      '-fno-diagnostics-color',
      '-I',
      path.join(dir, 'include'),
      source,
    ],
    cwd: dir,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    timeoutMs: options.timeoutMs ?? 60_000,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (run.aborted) return { ran: false, findings: [], unresolvedCalls: [] };
  if (run.timedOut) {
    return {
      ran: true,
      findings: [
        { severity: 'warning', code: 'compile-timeout', message: 'The compile check timed out.' },
      ],
      unresolvedCalls: [],
    };
  }
  const findings: Finding[] = [];
  const unresolved = new Set<string>();
  for (const d of parseDiagnostics(`${run.stdout}\n${run.stderr}`)) {
    if (d.severity === 'note') continue;
    const implicit = IMPLICIT.exec(d.message);
    if (implicit?.[1]) {
      unresolved.add(implicit[1]);
      continue;
    }
    // Clang/GCC follow-ups of an implicit declaration are noise for the same reason.
    if (
      /conflicting types for '([^']+)'/.test(d.message) &&
      unresolved.has(/'([^']+)'/.exec(d.message)?.[1] ?? '')
    )
      continue;
    // Line numbers refer to the generated file (header comment + includes precede the code).
    findings.push({
      severity: d.severity === 'error' ? 'error' : 'warning',
      code: d.severity === 'error' ? 'compile-error' : 'compile-warning',
      message: `line ${d.line}: ${d.message}`,
    });
  }
  // A compiler that failed without a parsable diagnostic (e.g. unknown flags) must not pass silently.
  if (
    run.exitCode !== 0 &&
    !findings.some((f) => f.severity === 'error') &&
    unresolved.size === 0
  ) {
    findings.push({
      severity: 'warning',
      code: 'compile-unassessed',
      message: `The compiler exited with ${run.exitCode} without a diagnostic: ${run.stderr.trim().slice(-200)}`,
    });
  }
  return { ran: true, findings: findings.slice(0, 20), unresolvedCalls: [...unresolved].sort() };
}

/** Compiles the shared types header alone: a broken header would otherwise break every function that uses it. */
export async function compileCheckTypes(options: {
  compiler: string | undefined;
  workDirectory: string;
  typesHeader: string;
  signal?: AbortSignal | undefined;
}): Promise<CompileCheckOutcome> {
  if (!options.compiler) return { ran: false, findings: [], unresolvedCalls: [] };
  const dir = path.join(options.workDirectory, '_types');
  await fs.mkdir(path.join(dir, 'include'), { recursive: true });
  await writeFileAtomic(
    path.join(dir, 'include', 'recode_types.h'),
    renderTypesHeader(options.typesHeader),
  );
  const source = path.join(dir, 'types.c');
  await writeFileAtomic(source, '#include "recode_types.h"\n');
  const run = await runProcess({
    command: options.compiler,
    args: [
      '-fsyntax-only',
      '-std=gnu11',
      '-fno-diagnostics-color',
      '-I',
      path.join(dir, 'include'),
      source,
    ],
    cwd: dir,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    timeoutMs: 60_000,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const findings: Finding[] = parseDiagnostics(`${run.stdout}\n${run.stderr}`)
    .filter((d) => d.severity === 'error')
    .slice(0, 20)
    .map((d) => ({
      severity: 'error' as const,
      code: 'compile-error',
      message: `types header, line ${d.line - 8 > 0 ? d.line - 8 : d.line}: ${d.message}`,
    }));
  return { ran: true, findings, unresolvedCalls: [] };
}
