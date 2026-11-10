import type { FunctionResult } from '../../reconstruction/interfaces/results.js';
import type { FunctionMetrics } from '../../decompiler/analysis/metrics.js';
import { stripNoise } from '../../decompiler/analysis/metrics.js';

export type FindingSeverity = 'error' | 'warning' | 'info';

/** One deterministic observation about a reconstructed function. Errors block acceptance of the result. */
export interface Finding {
  severity: FindingSeverity;
  code: string;
  message: string;
}

const C_KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'return',
  'sizeof',
  'do',
  'else',
  'case',
  'goto',
  'defined',
  'typeof',
  '_Alignof',
  'alignof',
  '_Static_assert',
  'static_assert',
  '__attribute__',
  'asm',
]);

/** Returns the first delimiter problem in C code (comments and literals ignored), or undefined. */
export function findDelimiterProblem(code: string): string | undefined {
  const text = stripNoise(code);
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const stack: Array<{ ch: string; line: number }> = [];
  let line = 1;
  for (const ch of text) {
    if (ch === '\n') line++;
    else if (ch === '(' || ch === '[' || ch === '{') stack.push({ ch, line });
    else if (ch in pairs) {
      const top = stack.pop();
      if (!top || top.ch !== pairs[ch]) return `unbalanced "${ch}" on line ${line}`;
    }
  }
  const open = stack.pop();
  return open ? `"${open.ch}" opened on line ${open.line} is never closed` : undefined;
}

interface ParsedSignature {
  returnType: string;
  name: string;
  params: string[];
}

const norm = (s: string): string =>
  s
    .replace(/\s+/g, ' ')
    .replace(/\s*\*\s*/g, '*')
    .trim();

/** Splits `ret name(params)` at the first top-level "name(" occurrence of `name`. */
function parseSignature(text: string, name: string): ParsedSignature | undefined {
  const match = new RegExp(`(^|[^\\w])${name}\\s*\\(`).exec(text);
  if (!match) return undefined;
  const start = match.index + match[0].length - 1;
  let depth = 0;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end < 0) return undefined;
  const returnType = norm(text.slice(0, match.index + (match[1] ?? '').length));
  const inside = text.slice(start + 1, end);
  const params: string[] = [];
  let level = 0;
  let current = '';
  for (const ch of inside) {
    if (ch === '(' || ch === '[') level++;
    if (ch === ')' || ch === ']') level--;
    if (ch === ',' && level === 0) {
      params.push(current);
      current = '';
    } else current += ch;
  }
  if (current.trim() !== '') params.push(current);
  const cleaned = params.map(norm).filter((p) => p !== '');
  return {
    returnType,
    name,
    params: cleaned.length === 1 && cleaned[0] === 'void' ? [] : cleaned,
  };
}

const TYPE_WORDS = new Set([
  'int',
  'char',
  'short',
  'long',
  'unsigned',
  'signed',
  'float',
  'double',
  'void',
  'bool',
  '_Bool',
  'size_t',
  'ssize_t',
  'ptrdiff_t',
  'wchar_t',
  'const',
  'volatile',
]);

/** Parameter text without its name, so that `int a`, `int count` and `int` compare equal. */
function paramType(param: string): string {
  if (param === '...') return param;
  const text = norm(param.replace(/\[[^\]]*\]\s*$/, '*'));
  const match = /^(.*?)([A-Za-z_]\w*)$/.exec(text);
  if (!match) return text;
  const head = match[1] ?? '';
  const last = match[2] ?? '';
  const previous = /(\w+)\s*$/.exec(head)?.[1];
  const isTypeWord =
    TYPE_WORDS.has(last) ||
    /_t$/.test(last) ||
    previous === 'struct' ||
    previous === 'union' ||
    previous === 'enum';
  const lone = !/[\s*]/.test(head);
  return norm(isTypeWord || lone ? text : head);
}

/** Finds the signature of the top-level definition (the `name(...)` that is followed by `{`). */
function parseDefinition(code: string, name: string): ParsedSignature | undefined {
  const text = stripNoise(code);
  const re = new RegExp(`(^|[^\\w])${name}\\s*\\(`, 'g');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    // Depth of braces before the match must be zero for a definition.
    let depth = 0;
    for (let i = 0; i < m.index; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
    }
    if (depth !== 0) continue;
    const sliceStart = text.lastIndexOf(';', m.index) + 1;
    const sliceStartBrace = text.lastIndexOf('}', m.index) + 1;
    const from = Math.max(sliceStart, sliceStartBrace);
    const signature = parseSignature(text.slice(from), name);
    if (!signature) continue;
    // What follows the closing parenthesis must open a body.
    const afterParams = text.indexOf(')', m.index + m[0].length);
    const rest = text.slice(afterParams === -1 ? m.index : afterParams).trimStart();
    if (/^\)[^;{]*\{/.test(rest) || /^\)\s*\{/.test(rest)) return signature;
  }
  return undefined;
}

function countCallsAndControl(code: string): { calls: number; loops: number; branches: number } {
  const text = stripNoise(code);
  let calls = 0;
  for (const m of text.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
    if (m[1] && !C_KEYWORDS.has(m[1])) calls++;
  }
  return {
    calls,
    loops: (text.match(/\b(?:while|for)\s*\(|\bdo\s*\{/g) ?? []).length,
    branches: (text.match(/\bif\s*\(|\bswitch\s*\(|\?/g) ?? []).length,
  };
}

export interface FunctionValidationContext {
  /** Metrics of the original (decompiler) function; enables the "too simple" heuristics. */
  originalMetrics?: FunctionMetrics | undefined;
  /** Typedef names visible to the function (from the shared types header), to excuse e.g. `uint`. */
  knownTypes?: ReadonlySet<string> | undefined;
}

/**
 * Stage 1 of the validation: purely textual checks that need no compiler. They catch structurally broken results
 * early (so a stronger model can fix them with a precise report) and flag results that look suspiciously simpler
 * than the original. Heuristics are reported as warnings, never as proof.
 */
export function validateFunctionResult(
  result: FunctionResult,
  context: FunctionValidationContext = {},
): Finding[] {
  if (result.status !== 'reconstructed') return [];
  const findings: Finding[] = [];
  const add = (severity: FindingSeverity, code: string, message: string): void => {
    findings.push({ severity, code, message });
  };
  if (result.code.trim() === '') {
    add('error', 'empty-code', 'The function has no code.');
    return findings;
  }
  const delimiter = findDelimiterProblem(result.code);
  if (delimiter) add('error', 'delimiters', `Syntax: ${delimiter}.`);
  const definition = parseDefinition(result.code, result.name);
  if (!definition) {
    add(
      'error',
      'no-definition',
      `No top-level definition of ${result.name}() with a body was found.`,
    );
  }
  const declared = parseSignature(result.prototype, result.name);
  if (!declared) {
    add('error', 'prototype-name', `The prototype does not declare ${result.name}().`);
  } else if (definition) {
    if (declared.returnType !== definition.returnType) {
      add(
        'error',
        'prototype-mismatch',
        `Return type differs: prototype "${declared.returnType}" vs definition "${definition.returnType}".`,
      );
    }
    if (declared.params.length !== definition.params.length) {
      add(
        'error',
        'prototype-mismatch',
        `Parameter count differs: prototype ${declared.params.length}, definition ${definition.params.length}.`,
      );
    } else {
      declared.params.forEach((p, i) => {
        const a = paramType(p);
        const b = paramType(definition.params[i] ?? '');
        if (a !== b)
          add('error', 'prototype-mismatch', `Parameter ${i + 1} type differs: "${a}" vs "${b}".`);
      });
    }
  }
  const stripped = stripNoise(result.code);
  if (/^\s*#\s*include/m.test(stripped))
    add('error', 'include', 'The code contains #include lines.');
  const known = context.knownTypes ?? new Set<string>();
  const ghidraTypes = new Set(
    [...stripped.matchAll(/\bundefined\d*\b/g)].map((m) => m[0]).filter((t) => !known.has(t)),
  );
  if (ghidraTypes.size > 0) {
    add(
      'error',
      'ghidra-types',
      `Decompiler placeholder types are not C: ${[...ghidraTypes].join(', ')}.`,
    );
  }
  if (/\b(?:TODO|FIXME|not implemented|unimplemented)\b/i.test(result.code)) {
    add('warning', 'placeholder', 'The code contains a TODO/unimplemented marker.');
  }
  const original = context.originalMetrics;
  if (original && !original.decompileFailed) {
    const own = countCallsAndControl(result.code);
    if (original.loops > 0 && own.loops === 0) {
      add(
        'warning',
        'loops-dropped',
        `The original has ${original.loops} loop(s); the reconstruction has none.`,
      );
    }
    if (original.cyclomatic >= 8 && own.branches === 0) {
      add(
        'warning',
        'branches-dropped',
        `The original has cyclomatic complexity ${original.cyclomatic}; the reconstruction has no branches.`,
      );
    }
    if (original.directCalls >= 3 && own.calls < original.directCalls / 2) {
      add(
        'warning',
        'calls-dropped',
        `The original calls ${original.directCalls} functions; the reconstruction makes ${own.calls} call(s).`,
      );
    }
  }
  if (result.confidence === 'speculative') {
    add('info', 'speculative', 'The agent rated the whole reconstruction as speculative.');
  }
  const speculative = result.assumptions.filter((a) => a.confidence === 'speculative').length;
  if (speculative >= 3)
    add('info', 'many-speculative-assumptions', `${speculative} speculative assumptions.`);
  return findings;
}

export const hasErrors = (findings: readonly Finding[]): boolean =>
  findings.some((f) => f.severity === 'error');

export const formatFindings = (findings: readonly Finding[]): string[] =>
  findings.map((f) => `[${f.severity}] ${f.code}: ${f.message}`);
