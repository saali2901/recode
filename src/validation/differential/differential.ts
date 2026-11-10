import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { RecodeError } from '../../core/errors/index.js';
import { readJson, sha256Text, writeFileAtomic } from '../../infrastructure/filesystem/files.js';
import { runProcess, succeeded } from '../../infrastructure/process/process-manager.js';

/**
 * Stage 3 of the validation: differential testing of reconstructed functions against REFERENCE SOURCE that the user
 * supplies (for example the original source of a benchmark, or a clean-room implementation). ReCode never executes
 * the analyzed binary. It compiles the reference source and the reconstructed static library into one test runner and
 * executes only that runner, locally, with a timeout, when - and only when - a spec file is configured
 * (`validation.differentialSpec`). Use it in an environment where running the code under test is authorized.
 */

const SCALARS = {
  int: { c: 'int', kind: 'int', bits: 32, signed: true },
  'unsigned int': { c: 'unsigned int', kind: 'int', bits: 32, signed: false },
  short: { c: 'short', kind: 'int', bits: 16, signed: true },
  'unsigned short': { c: 'unsigned short', kind: 'int', bits: 16, signed: false },
  char: { c: 'char', kind: 'int', bits: 8, signed: true },
  'unsigned char': { c: 'unsigned char', kind: 'int', bits: 8, signed: false },
  long: { c: 'long', kind: 'int', bits: 64, signed: true },
  'unsigned long': { c: 'unsigned long', kind: 'int', bits: 64, signed: false },
  'long long': { c: 'long long', kind: 'int', bits: 64, signed: true },
  'unsigned long long': { c: 'unsigned long long', kind: 'int', bits: 64, signed: false },
  int8_t: { c: 'int8_t', kind: 'int', bits: 8, signed: true },
  uint8_t: { c: 'uint8_t', kind: 'int', bits: 8, signed: false },
  int16_t: { c: 'int16_t', kind: 'int', bits: 16, signed: true },
  uint16_t: { c: 'uint16_t', kind: 'int', bits: 16, signed: false },
  int32_t: { c: 'int32_t', kind: 'int', bits: 32, signed: true },
  uint32_t: { c: 'uint32_t', kind: 'int', bits: 32, signed: false },
  int64_t: { c: 'int64_t', kind: 'int', bits: 64, signed: true },
  uint64_t: { c: 'uint64_t', kind: 'int', bits: 64, signed: false },
  size_t: { c: 'size_t', kind: 'int', bits: 64, signed: false },
  float: { c: 'float', kind: 'float', bits: 32, signed: true },
  double: { c: 'double', kind: 'float', bits: 64, signed: true },
} as const;
type ScalarName = keyof typeof SCALARS;
const SCALAR_NAMES = Object.keys(SCALARS) as [ScalarName, ...ScalarName[]];

const ParamSchema = z.union([
  z.object({ type: z.enum(SCALAR_NAMES) }),
  /** A pointer to a byte buffer the function may read and write; both implementations get an identical copy. */
  z.object({ type: z.literal('buffer'), size: z.number().int().min(1).max(4096) }),
]);

const CaseSchema = z.object({
  /** Reconstructed function name (as it appears in the generated project). */
  function: z.string().regex(/^[A-Za-z_]\w*$/),
  /** Name in the reference source; defaults to `function`. */
  reference: z
    .string()
    .regex(/^[A-Za-z_]\w*$/)
    .optional(),
  returns: z.union([z.enum(SCALAR_NAMES), z.literal('void')]),
  params: z.array(ParamSchema).max(8),
  /** Explicit argument vectors (numbers as JSON numbers or strings for 64-bit values). Buffers are generated. */
  vectors: z
    .array(z.array(z.union([z.number(), z.string()])))
    .max(1000)
    .default([]),
  /** Additional pseudo-random vectors (deterministic for a given seed). Edge values are always included. */
  random: z
    .object({ count: z.number().int().min(0).max(1000), seed: z.number().int().default(1) })
    .default({ count: 32, seed: 1 }),
});

export const DifferentialSpecSchema = z.object({
  /** C file with the original/reference implementations, relative to the project root. */
  referenceSource: z.string().min(1),
  /** Extra compiler flags for the reference source (e.g. "-DNDEBUG"); not split by a shell. */
  referenceFlags: z.array(z.string()).default([]),
  cases: z.array(CaseSchema).min(1).max(200),
});
export type DifferentialSpec = z.infer<typeof DifferentialSpecSchema>;

export type CaseOutcome =
  | { function: string; outcome: 'passed'; vectors: number }
  | { function: string; outcome: 'failed'; vectors: number; failures: string[] }
  | { function: string; outcome: 'not-assessed'; reason: string };

export interface DifferentialOutcome {
  /** passed: every case passed; failed: at least one mismatch; not-assessed: nothing could be compared. */
  outcome: 'passed' | 'failed' | 'not-assessed';
  detail: string;
  cases: CaseOutcome[];
}

const EDGE_INTS = (bits: number, signed: boolean): string[] => {
  const max = signed ? (1n << BigInt(bits - 1)) - 1n : (1n << BigInt(bits)) - 1n;
  const min = signed ? -(1n << BigInt(bits - 1)) : 0n;
  const values = new Set<bigint>([0n, 1n, 2n, max, min, max - 1n, min + 1n, 7n, 8n, 255n, 256n]);
  if (signed) values.add(-1n).add(-2n);
  return [...values].filter((v) => v >= min && v <= max).map((v) => v.toString());
};
const EDGE_FLOATS = ['0.0', '1.0', '-1.0', '0.5', '-0.5', '3.5', '1e10', '-1e10', '1e-10'];

function mulberry(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInt(bits: number, signed: boolean, rnd: () => number): string {
  const range = 1n << BigInt(bits);
  let value = 0n;
  for (let i = 0; i < Math.ceil(bits / 32); i++)
    value = (value << 32n) | BigInt(Math.floor(rnd() * 4294967296));
  value %= range;
  if (signed && value >= range / 2n) value -= range;
  return value.toString();
}

type TestCase = z.infer<typeof CaseSchema>;

/** Argument vectors (as C literals) for one case: explicit ones, edge-value combinations, then random ones. */
export function buildVectors(c: TestCase): string[][] {
  const scalars = c.params.map((p) => (p.type === 'buffer' ? undefined : SCALARS[p.type]));
  const literal = (type: (typeof SCALARS)[ScalarName], value: string | number): string => {
    if (type.kind === 'float') return String(value);
    const text = String(value);
    if (type.signed && type.bits === 64 && text === '-9223372036854775808')
      return '(-9223372036854775807LL-1)';
    return type.bits === 64 ? (type.signed ? `${text}LL` : `${text}ULL`) : text;
  };
  const vectors: string[][] = [];
  const add = (values: Array<string | number | undefined>): void => {
    vectors.push(
      values.map((v, i) => (v === undefined || !scalars[i] ? '0' : literal(scalars[i], v))),
    );
  };
  for (const v of c.vectors)
    add(c.params.map((p, i) => (p.type === 'buffer' ? undefined : (v[i] ?? 0))));
  const edges = scalars.map((s) =>
    s === undefined
      ? ['0']
      : s.kind === 'float'
        ? EDGE_FLOATS
        : EDGE_INTS(s.bits, s.signed).slice(0, c.params.length > 2 ? 5 : 11),
  );
  // Cartesian product of edge values, capped; larger signatures only get single-parameter variation.
  const total = edges.reduce((n, e) => n * e.length, 1);
  if (total <= 400) {
    let combos: string[][] = [[]];
    for (const e of edges) combos = combos.flatMap((prefix) => e.map((v) => [...prefix, v]));
    for (const combo of combos) add(combo);
  } else {
    const base = edges.map((e) => e[0] ?? '0');
    add(base);
    edges.forEach((e, i) => {
      for (const v of e) add(base.map((b, j) => (j === i ? v : b)));
    });
  }
  const rnd = mulberry(c.random.seed);
  for (let n = 0; n < c.random.count; n++) {
    add(
      scalars.map((s) =>
        s === undefined
          ? '0'
          : s.kind === 'float'
            ? (rnd() * 2000 - 1000).toFixed(6)
            : randomInt(s.bits, s.signed, rnd),
      ),
    );
  }
  return vectors.slice(0, 2000);
}

function paramList(c: TestCase): string {
  if (c.params.length === 0) return 'void';
  return c.params
    .map((p) => (p.type === 'buffer' ? 'unsigned char *' : SCALARS[p.type].c))
    .join(', ');
}

/** Generates the C source of the test runner. Exported for tests. */
export function generateRunner(spec: DifferentialSpec): string {
  const lines: string[] = [
    '#include <stdint.h>',
    '#include <stddef.h>',
    '#include <stdio.h>',
    '#include <string.h>',
    '#include <math.h>',
    '',
    'static unsigned long long fills_state = 88172645463325252ULL;',
    'static unsigned char next_byte(void) { fills_state ^= fills_state << 13; fills_state ^= fills_state >> 7; fills_state ^= fills_state << 17; return (unsigned char)(fills_state >> 24); }',
    'static int same_double(double a, double b) { return (isnan(a) && isnan(b)) || a == b; }',
    '',
  ];
  spec.cases.forEach((c, index) => {
    const ret = c.returns === 'void' ? 'void' : SCALARS[c.returns].c;
    lines.push(`extern ${ret} ${c.function}(${paramList(c)});`);
    lines.push(`extern ${ret} recode_ref_${index}(${paramList(c)});`);
  });
  lines.push('', 'int main(void) {', '  int failed_cases = 0;');
  spec.cases.forEach((c, index) => {
    const vectors = buildVectors(c);
    const buffers = c.params.flatMap((p, i) => (p.type === 'buffer' ? [{ i, size: p.size }] : []));
    lines.push(`  { /* ${c.function} */`);
    lines.push(`    int fails = 0; int count = 0;`);
    lines.push(`    static const char *const names = "${c.function}";`);
    const types = c.params.map((p) => (p.type === 'buffer' ? 'int' : SCALARS[p.type].c));
    lines.push(
      `    static const struct { ${types.map((t, i) => `${t === 'int' && c.params[i]?.type === 'buffer' ? 'int' : t} a${i};`).join(' ')} int pad; } vec[] = {`,
    );
    for (const v of vectors)
      lines.push(`      { ${v.map((x) => x).join(', ')}${v.length ? ', ' : ''}0 },`);
    lines.push('    };');
    lines.push('    for (size_t n = 0; n < sizeof vec / sizeof vec[0]; n++) {');
    for (const b of buffers) {
      lines.push(`      unsigned char ref_b${b.i}[${b.size}], rec_b${b.i}[${b.size}];`);
      lines.push(
        `      for (size_t k = 0; k < ${b.size}; k++) { ref_b${b.i}[k] = next_byte(); rec_b${b.i}[k] = ref_b${b.i}[k]; }`,
      );
    }
    const args = (which: 'ref' | 'rec') =>
      c.params.map((p, i) => (p.type === 'buffer' ? `${which}_b${i}` : `vec[n].a${i}`)).join(', ');
    if (c.returns === 'void') {
      lines.push(`      recode_ref_${index}(${args('ref')}); ${c.function}(${args('rec')});`);
      lines.push('      int ok = 1;');
    } else {
      const t = SCALARS[c.returns].c;
      lines.push(
        `      ${t} want = recode_ref_${index}(${args('ref')}); ${t} got = ${c.function}(${args('rec')});`,
      );
      lines.push(
        SCALARS[c.returns].kind === 'float'
          ? '      int ok = same_double((double)want, (double)got);'
          : '      int ok = want == got;',
      );
    }
    for (const b of buffers)
      lines.push(`      if (memcmp(ref_b${b.i}, rec_b${b.i}, ${b.size}) != 0) ok = 0;`);
    lines.push('      count++;');
    lines.push(
      `      if (!ok) { if (fails < 3) printf("MISMATCH ${c.function} vector %zu\\n", n); fails++; }`,
    );
    lines.push('    }');
    lines.push(`    printf("CASE %d %s %d %d\\n", ${index}, names, count, fails);`);
    lines.push('    if (fails) failed_cases++;');
    lines.push('  }');
  });
  lines.push('  return failed_cases ? 1 : 0;', '}', '');
  return lines.join('\n');
}

async function findLibrary(buildDir: string): Promise<string | undefined> {
  const entries = await fs.readdir(buildDir).catch(() => [] as string[]);
  const name = entries.find((n) => /^lib.*\.a$/.test(n));
  return name ? path.join(buildDir, name) : undefined;
}

/** Runs the differential test described by `specFile` (JSON, relative paths resolve against `projectRoot`). */
export async function runDifferentialTest(options: {
  projectRoot: string;
  specFile: string;
  buildDir: string;
  workDirectory: string;
  compiler: string | undefined;
  /** Names of functions that were actually reconstructed (others are reported as not assessed). */
  reconstructedNames: ReadonlySet<string>;
  timeoutMs?: number;
  signal?: AbortSignal | undefined;
}): Promise<DifferentialOutcome> {
  const specPath = path.resolve(options.projectRoot, options.specFile);
  const spec = await readJson(specPath, DifferentialSpecSchema);
  const referencePath = path.resolve(options.projectRoot, spec.referenceSource);
  if (path.relative(options.projectRoot, referencePath).startsWith('..')) {
    throw new RecodeError('INVALID_INPUT', 'referenceSource must be inside the project directory.');
  }
  const unassessed: CaseOutcome[] = [];
  const runnable = spec.cases.filter((c) => {
    if (!options.reconstructedNames.has(c.function)) {
      unassessed.push({
        function: c.function,
        outcome: 'not-assessed',
        reason: 'function was not reconstructed',
      });
      return false;
    }
    return true;
  });
  const fail = (detail: string): DifferentialOutcome => ({
    outcome: 'not-assessed',
    detail,
    cases: unassessed,
  });
  if (!options.compiler) return fail('No C compiler found; differential testing needs one.');
  const library = await findLibrary(options.buildDir);
  if (!library) return fail('No built library found; run "recode build" first.');
  if (runnable.length === 0) return fail('None of the functions in the spec was reconstructed.');

  const dir = options.workDirectory;
  await fs.mkdir(dir, { recursive: true });
  const runnerSpec: DifferentialSpec = { ...spec, cases: runnable };
  await writeFileAtomic(path.join(dir, 'runner.c'), generateRunner(runnerSpec));
  const env = { ...process.env, LC_ALL: 'C' };
  const timeoutMs = options.timeoutMs ?? 60_000;

  // The reference is compiled with its functions renamed (recode_ref_<n>), so both versions live in one program.
  const renames = runnable.map(
    (c) => `-D${c.reference ?? c.function}=recode_ref_${spec.cases.indexOf(c)}`,
  );
  const refObject = path.join(dir, 'reference.o');
  const compileRef = await runProcess({
    command: options.compiler,
    args: [
      '-c',
      '-std=gnu11',
      '-w',
      '-Dmain=recode_reference_main',
      ...renames,
      ...spec.referenceFlags,
      referencePath,
      '-o',
      refObject,
    ],
    cwd: dir,
    env,
    timeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!succeeded(compileRef)) {
    return fail(
      `The reference source does not compile: ${compileRef.stderr.trim().split('\n')[0] ?? ''}`,
    );
  }
  const runnerExe = path.join(dir, process.platform === 'win32' ? 'runner.exe' : 'runner');
  const link = await runProcess({
    command: options.compiler,
    args: [
      '-std=gnu11',
      '-w',
      path.join(dir, 'runner.c'),
      refObject,
      library,
      '-lm',
      '-o',
      runnerExe,
    ],
    cwd: dir,
    env,
    timeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!succeeded(link)) {
    return fail(
      `The test runner does not link against the reconstruction: ${link.stderr.trim().split('\n')[0] ?? ''}`,
    );
  }
  const run = await runProcess({
    command: runnerExe,
    args: [],
    cwd: dir,
    env,
    timeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (run.timedOut)
    return fail('The test runner timed out (possible endless loop in the code under test).');
  const cases: CaseOutcome[] = [...unassessed];
  const mismatches = new Map<string, string[]>();
  for (const line of run.stdout.split('\n')) {
    const m = /^MISMATCH (\w+) vector (\d+)/.exec(line);
    if (m?.[1]) mismatches.set(m[1], [...(mismatches.get(m[1]) ?? []), `vector ${m[2]}`]);
    const c = /^CASE \d+ (\w+) (\d+) (\d+)$/.exec(line);
    if (c?.[1] && c[2] && c[3]) {
      const failures = Number.parseInt(c[3], 10);
      cases.push(
        failures === 0
          ? { function: c[1], outcome: 'passed', vectors: Number.parseInt(c[2], 10) }
          : {
              function: c[1],
              outcome: 'failed',
              vectors: Number.parseInt(c[2], 10),
              failures: mismatches.get(c[1]) ?? [`${failures} vector(s)`],
            },
      );
    }
  }
  const finished = cases.filter((c) => c.outcome !== 'not-assessed').length;
  if (finished < runnable.length) {
    // The runner died (crash, signal): the code under test misbehaved before all cases finished.
    cases.push({
      function: '(runner)',
      outcome: 'failed',
      vectors: 0,
      failures: [`runner ended early (exit ${run.exitCode}${run.signal ? `, ${run.signal}` : ''})`],
    });
  }
  const failed = cases.filter((c) => c.outcome === 'failed');
  const passed = cases.filter((c) => c.outcome === 'passed');
  const vectors = passed.reduce((n, c) => n + (c.outcome === 'passed' ? c.vectors : 0), 0);
  return {
    outcome: failed.length > 0 ? 'failed' : passed.length > 0 ? 'passed' : 'not-assessed',
    detail:
      `${passed.length} function(s) matched the reference on ${vectors} vector(s) (return values and buffer contents)` +
      (failed.length > 0
        ? `; ${failed.length} differ: ${failed.map((f) => f.function).join(', ')}`
        : '') +
      (unassessed.length > 0 ? `; ${unassessed.length} not assessed` : '') +
      `. Agreement on these vectors does not prove equivalence for all inputs. Spec ${sha256Text(JSON.stringify(spec)).slice(0, 8)}.`,
    cases,
  };
}
