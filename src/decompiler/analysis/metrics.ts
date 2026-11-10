import type { FunctionFacts, FunctionInfo } from '../interfaces/schemas.js';

/** Bump when the counting rules change; cached dossiers with another version are recomputed. */
export const METRICS_VERSION = 2;

export interface FunctionMetrics {
  /** Non-blank, non-comment lines of decompiler output. */
  codeLines: number;
  asmInstructions: number;
  /** From Ghidra's block model when available, otherwise estimated from the assembly. */
  basicBlocks: number;
  basicBlocksSource: 'ghidra' | 'estimated';
  branches: number;
  loops: number;
  switchCases: number;
  gotos: number;
  maxNesting: number;
  /** 1 + decision points (branches, loops, cases, && and ||). */
  cyclomatic: number;
  /** `*(type *)(base + offset)` style accesses and `->`/`[]` dereferences. */
  memoryAccesses: number;
  /** Pointer casts combined with arithmetic, typical for unrecovered structures. */
  pointerArithmetic: number;
  /** Distinct constant offsets applied to base pointers: a hint at struct size/complexity. */
  distinctOffsets: number;
  directCalls: number;
  indirectCalls: number;
  computedJumps: number;
  selfRecursive: boolean;
  floatingPoint: number;
  bitOperations: number;
  /** Ghidra's `undefined`, `undefined4`, ... placeholder types. */
  undefinedTypes: number;
  /** Variables the decompiler could not name or resolve: `param_N`, `unaff_*`, `in_*`, `extraout_*`. */
  unresolvedVariables: number;
  /** Low-level pieces the decompiler could not lift: CONCAT/SUB/ZEXT/SEXT/FLOAT intrinsics. */
  intrinsics: number;
  /** `WARNING:` banners, `halt_baddata`, unrecovered jump tables, bad instruction data. */
  decompilerWarnings: number;
  decompileFailed: boolean;
}

const COMMENT = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
const STRING = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;

/** Removes comments and string/char literals so counting is not fooled by them. */
export function stripNoise(code: string): string {
  return code.replace(COMMENT, ' ').replace(STRING, '""');
}

const count = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0;

/** Counts `WARNING:` style notes in the raw text (they live in comments). */
function decompilerWarningCount(raw: string): number {
  return (
    count(raw, /\bWARNING:/g) +
    count(raw, /halt_baddata|halt_unimplemented|Bad instruction|Unable to decompile/g) +
    count(raw, /Could not recover jumptable|Control flow encountered bad instruction data/g)
  );
}

function nestingDepth(code: string): number {
  let depth = 0;
  let max = 0;
  for (const ch of code) {
    if (ch === '{') max = Math.max(max, ++depth);
    else if (ch === '}') depth = Math.max(0, depth - 1);
  }
  // The function body itself is level 1.
  return Math.max(0, max - 1);
}

function estimateBlocks(asm: string): number {
  // A new block starts after every branch/jump/return and at each branch target; counting terminators is a
  // conservative lower bound that is stable across architectures (mnemonics are matched loosely).
  const terminators = count(
    asm,
    /:\s*(?:j[a-z]{1,4}|b(?:eq|ne|lt|le|gt|ge|cs|cc|mi|pl|hi|ls|l|r|x|ctr|lr|ne\.|eq\.)?\w*|cb\w*|tb\w*|ret\w*|jmp|bx|blr|bctr)\b/gim,
  );
  return Math.max(1, terminators + 1);
}

export interface MetricsInput {
  info: Pick<FunctionInfo, 'address' | 'calls' | 'decompiledFile' | 'decompileError'>;
  decompiled: string | null;
  assembly: string | null;
  facts?: FunctionFacts | undefined;
}

export function computeMetrics(input: MetricsInput): FunctionMetrics {
  const raw = input.decompiled ?? '';
  const code = stripNoise(raw);
  const asm = input.assembly ?? '';
  const lines = code.split('\n').filter((l) => l.trim() !== '');
  const branches = count(code, /\bif\s*\(/g);
  const loops = count(code, /\b(?:while|for)\s*\(|\bdo\s*\{/g);
  const switchCases = count(code, /\bcase\s+[^:]+:/g) + count(code, /\bdefault\s*:/g);
  const logical = count(code, /&&|\|\|/g);
  const offsets = new Set<string>();
  for (const m of code.matchAll(/\)\s*\(\s*\w+\s*\+\s*(-?(?:0x[0-9a-f]+|\d+))\s*\)/gi))
    if (m[1]) offsets.add(m[1]);
  for (const m of code.matchAll(/\w+\s*\+\s*(0x[0-9a-f]+|\d+)\s*\)/gi))
    if (m[1] && offsets.size < 2000) offsets.add(m[1]);

  const indirectText = count(code, /\(\s*\*+\s*\w+\s*\)\s*\(|\(\s*\*+\s*\(\s*code\s*\*+\s*\)/g);
  const asmIndirect = count(
    asm,
    /:\s*(?:call|bl?r?|jmp|blr|bctrl?)\s+(?:\*|\[|r\d|e?[abcd]x|ctr|lr|x\d+)/gim,
  );
  const facts = input.facts;
  return {
    codeLines: lines.length,
    asmInstructions: facts?.instructionCount ?? asm.split('\n').filter((l) => l.trim()).length,
    basicBlocks: facts ? facts.basicBlocks : estimateBlocks(asm),
    basicBlocksSource: facts ? 'ghidra' : 'estimated',
    branches,
    loops,
    switchCases,
    gotos: count(code, /\bgoto\b/g),
    maxNesting: nestingDepth(code),
    cyclomatic: 1 + branches + loops + switchCases + logical,
    memoryAccesses:
      count(code, /\*\s*\(\s*[\w\s]+\*+\s*\)|\*\s*\(\w+\s*\*\)/g) +
      count(code, /->|\[\s*[^\]]+\s*\]/g),
    pointerArithmetic: count(code, /\(\s*[\w\s]+\*+\s*\)\s*\(\s*\w+\s*[+-]/g),
    distinctOffsets: offsets.size,
    directCalls: new Set(input.info.calls).size,
    indirectCalls: facts
      ? Math.max(facts.indirectCalls, indirectText)
      : Math.max(indirectText, asmIndirect),
    computedJumps: facts?.computedJumps ?? 0,
    selfRecursive: input.info.calls.includes(input.info.address),
    floatingPoint: count(code, /\b(?:float|double|longdouble|FLOAT\w*|NAN|fabs|sqrt)\b/g),
    bitOperations: count(code, /<<|>>|\^|~|(?<![&])&(?![&])|(?<![|])\|(?![|])/g),
    undefinedTypes: count(code, /\bundefined\d*\b/g),
    unresolvedVariables: count(
      code,
      /\b(?:param_\d+|unaff_\w+|in_\w+|extraout_\w+|uStack_\w+|puStack_\w+)\b/g,
    ),
    intrinsics: count(
      code,
      /\b(?:CONCAT\d+|SUB\d+|ZEXT\d+|SEXT\d+|SBORROW\d+|SCARRY\d+|CARRY\d+|POPCOUNT|LZCOUNT|FLOAT2INT|INT2FLOAT|PIECE)\b/g,
    ),
    decompilerWarnings: decompilerWarningCount(raw),
    decompileFailed: input.decompiled === null || Boolean(input.info.decompileError),
  };
}
