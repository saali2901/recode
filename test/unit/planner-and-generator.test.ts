import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { planTasks } from '../../src/ai/orchestration/planner.js';
import { Project } from '../../src/core/project/project.js';
import type { FunctionInfo } from '../../src/decompiler/interfaces/schemas.js';
import type { BinaryMetadata } from '../../src/input/interfaces/types.js';
import { CTargetLanguage, functionTaskId } from '../../src/reconstruction/c/c-generator.js';
import type { FunctionResult } from '../../src/reconstruction/interfaces/results.js';
import { parseDiagnostics } from '../../src/validation/build/diagnostics.js';
import { VALIDATION_CHECKS } from '../../src/validation/comparison/checks.js';
import { makeTempDir, registerTempCleanup } from '../helpers/tmp.js';

registerTempCleanup();

const fn = (
  address: string,
  name: string,
  calls: string[] = [],
  extra: Partial<FunctionInfo> = {},
): FunctionInfo => ({
  address,
  name,
  signature: `int ${name}(void)`,
  size: 10,
  isThunk: false,
  isExternal: false,
  calls,
  calledBy: [],
  decompiledFile: `decompiled/${name}.c`,
  disassemblyFile: `asm/${name}.asm`,
  ...extra,
});

describe('task planner', () => {
  it('orders callees before callers and puts overview and types first', () => {
    const plan = planTasks(
      [fn('0x30', 'top', ['0x20']), fn('0x20', 'mid', ['0x10']), fn('0x10', 'leaf')],
      { mode: 'complete' },
    );
    expect(plan.tasks.map((t) => t.id)).toEqual([
      'overview',
      'types',
      'fn_00000010',
      'fn_00000020',
      'fn_00000030',
    ]);
    expect(plan.tasks.find((t) => t.id === 'fn_00000030')?.dependsOn).toEqual([
      'types',
      'fn_00000020',
    ]);
  });

  it('groups mutual recursion into one component and keeps the graph acyclic', () => {
    const plan = planTasks(
      [fn('0x10', 'a', ['0x20', '0x10']), fn('0x20', 'b', ['0x10']), fn('0x30', 'c', ['0x10'])],
      { mode: 'complete' },
    );
    const byId = new Map(plan.tasks.map((t) => [t.id, t]));
    expect(byId.get('fn_00000010')?.group).toBeDefined();
    expect(byId.get('fn_00000010')?.group).toBe(byId.get('fn_00000020')?.group);
    expect(byId.get('fn_00000030')?.group).toBeUndefined();
    // members of a group do not wait for each other; the outside caller waits for the whole group
    expect(byId.get('fn_00000010')?.dependsOn).toEqual(['types']);
    expect(byId.get('fn_00000020')?.dependsOn).toEqual(['types']);
    expect(byId.get('fn_00000030')?.dependsOn).toEqual(['types', 'fn_00000010']);
    expect(plan.stats.largestComponent).toBe(2);
  });

  it('adaptive mode only needs the types: callee order is a soft dependency', () => {
    const plan = planTasks([fn('0x20', 'mid', ['0x10']), fn('0x10', 'leaf')]);
    const mid = plan.tasks.find((t) => t.id === 'fn_00000020');
    expect(mid?.dependsOn).toEqual(['types']);
    expect(mid?.softDependsOn).toEqual(['fn_00000010']);
    expect(mid?.priority).toBeLessThan(
      plan.tasks.find((t) => t.id === 'fn_00000010')?.priority ?? -1,
    );
  });

  it('signatures mode has no call dependencies at all', () => {
    const plan = planTasks([fn('0x20', 'mid', ['0x10']), fn('0x10', 'leaf')], {
      mode: 'signatures',
    });
    for (const t of plan.tasks.filter((x) => x.kind === 'function')) {
      expect(t.dependsOn).toEqual(['types']);
      expect(t.softDependsOn).toEqual([]);
    }
  });

  it('survives a call chain far deeper than the JavaScript stack', () => {
    const n = 50_000;
    const functions = Array.from({ length: n }, (_, i) =>
      fn(
        `0x${(0x1000 + i * 4).toString(16)}`,
        `f${i}`,
        i + 1 < n ? [`0x${(0x1000 + (i + 1) * 4).toString(16)}`] : [],
      ),
    );
    const plan = planTasks(functions);
    expect(plan.stats.criticalPath).toBe(n);
    expect(plan.stats.leaves).toBe(1);
  });

  it('the legacy planner keeps the original behaviour (back edges dropped, hard callee dependencies)', () => {
    const plan = planTasks([fn('0x10', 'a', ['0x20', '0x10']), fn('0x20', 'b', ['0x10'])], {
      mode: 'legacy',
    });
    const edges = plan.tasks.flatMap((t) => t.dependsOn.filter((d) => d.startsWith('fn_')));
    expect(edges).toHaveLength(1);
  });

  it('excludes external functions, thunks and functions without output', () => {
    const plan = planTasks([
      fn('0x10', 'ok'),
      fn('0x20', 'puts', [], { isExternal: true }),
      fn('0x30', 'thunk', [], { isThunk: true }),
      fn('0x40', 'empty', [], { decompiledFile: null, disassemblyFile: null }),
    ]);
    expect(plan.excluded.map((e) => [e.name, e.reason])).toEqual([
      ['puts', 'external'],
      ['thunk', 'thunk'],
      ['empty', 'no analysis output'],
    ]);
    expect(plan.tasks.filter((t) => t.kind === 'function')).toHaveLength(1);
  });

  it('ignores calls into excluded functions', () => {
    const plan = planTasks([fn('0x10', 'a', ['0x20']), fn('0x20', 'thunk', [], { isThunk: true })]);
    expect(plan.tasks.find((t) => t.id === 'fn_00000010')?.dependsOn).toEqual(['types']);
  });
});

describe('compiler diagnostics parser', () => {
  it('parses gcc, clang and MSVC style messages and ignores noise', () => {
    const output = [
      '[1/3] Building C object CMakeFiles/x.dir/src/multiply.c.o',
      "/p/source/b/src/multiply.c:4:20: error: expected ';' before '}' token",
      '/p/source/b/src/multiply.c:4:20: note: something',
      "src/a.c:9:3: warning: unused variable 'x' [-Wunused-variable]",
      "C:\\p\\src\\w.c(12,5) : error C2065: 'y': undeclared identifier",
      'FAILED: CMakeFiles/x.dir/src/multiply.c.o',
      "/p/source/b/src/multiply.c:4:20: error: expected ';' before '}' token",
    ].join('\n');
    const diagnostics = parseDiagnostics(output);
    expect(diagnostics.map((d) => [d.severity, d.line])).toEqual([
      ['error', 4],
      ['note', 4],
      ['warning', 9],
      ['error', 12],
    ]);
    expect(diagnostics[0]).toMatchObject({ file: '/p/source/b/src/multiply.c', column: 20 });
  });
});

describe('C project generator', () => {
  const result = (
    taskId: string,
    address: string,
    name: string,
    extra: Partial<FunctionResult> = {},
  ): FunctionResult => ({
    taskId,
    address,
    status: 'reconstructed',
    name,
    prototype: `int ${name}(int a);`,
    code: `int ${name}(int a) { return a; }`,
    includes: [],
    confidence: 'probable',
    assumptions: [{ text: 'guess */ injected', confidence: 'speculative' }],
    ...extra,
  });

  async function generate(results: FunctionResult[], functions: FunctionInfo[]) {
    const dir = await makeTempDir();
    const project = await Project.create(path.join(dir, 'p'), 'p');
    const file = path.join(project.paths.input, 'x.bin');
    await fs.writeFile(file, 'x');
    const metadata: BinaryMetadata = {
      format: 'elf',
      kind: 'executable',
      architecture: 'x86_64',
      bits: 64,
      endianness: 'little',
      sections: [],
      segments: [],
      symbols: [],
      symbolsTruncated: false,
      source: 'headers',
      warnings: [],
    };
    const { record } = await project.registerBinary(file, 'test', metadata);
    const report = await new CTargetLanguage().generateProject({
      project,
      binary: record,
      functions,
      functionResults: new Map(results.map((r) => [r.taskId, r])),
      typesResult: undefined,
    });
    return { project, record, report, root: project.sourceDir(record.id) };
  }

  it('writes sources, headers, CMake project and report; marks unreconstructed functions', async () => {
    const functions = [fn('0x10', 'FUN_10'), fn('0x20', 'FUN_20')];
    const { root, report } = await generate(
      [result(functionTaskId('0x10'), '0x10', 'helper')],
      functions,
    );
    expect(report).toMatchObject({ reconstructed: 1, unreconstructed: 0, notAttempted: 1 });
    const functionsHeader = await fs.readFile(
      path.join(root, 'include', 'recode_functions.h'),
      'utf8',
    );
    expect(functionsHeader).toContain('int helper(int a);');
    expect(functionsHeader).toContain('NOT RECONSTRUCTED 0x20 FUN_20: not attempted');
    const source = await fs.readFile(path.join(root, 'src', 'helper.c'), 'utf8');
    expect(source).toContain('FUN_10 @ 0x10');
    expect(source).toContain('[speculative] guess * / injected'); // comment terminator neutralized
    expect(source).toContain('#include "recode_types.h"');
    const cmake = await fs.readFile(path.join(root, 'CMakeLists.txt'), 'utf8');
    expect(cmake).toContain('src/helper.c');
    expect(cmake).toContain('set(RECODE_HAS_MAIN OFF)');
    const doc = await fs.readFile(path.join(root, 'RECONSTRUCTION.md'), 'utf8');
    expect(doc).toContain('| 0x10 | FUN_10 | helper | probable |');
    expect(doc).toContain('`FUN_20`');
  });

  it("records unreconstructable functions with the agent's reason", async () => {
    const r = result('fn_00000010', '0x10', 'FUN_10', {
      status: 'unreconstructable',
      reason: 'indirect jump table',
      code: '',
      prototype: '',
    });
    const { root, report } = await generate([r], [fn('0x10', 'FUN_10')]);
    expect(report.unreconstructed).toBe(1);
    expect(await fs.readFile(path.join(root, 'include', 'recode_functions.h'), 'utf8')).toContain(
      'indirect jump table',
    );
  });

  it('removes stale generated files but never touches foreign files', async () => {
    const functions = [fn('0x10', 'a'), fn('0x20', 'b')];
    const first = await generate(
      [result('fn_00000010', '0x10', 'alpha'), result('fn_00000020', '0x20', 'beta')],
      functions,
    );
    await fs.writeFile(path.join(first.root, 'src', 'user_notes.c'), '// mine');
    await new CTargetLanguage().generateProject({
      project: first.project,
      binary: first.record,
      functions,
      functionResults: new Map([['fn_00000010', result('fn_00000010', '0x10', 'alpha')]]),
      typesResult: undefined,
    });
    const files = await fs.readdir(path.join(first.root, 'src'));
    expect(files).toContain('alpha.c');
    expect(files).not.toContain('beta.c');
    expect(files).toContain('user_notes.c');
  });

  it('maps header lines to tasks for diagnostics attribution', async () => {
    const { report } = await generate([result('fn_00000010', '0x10', 'alpha')], [fn('0x10', 'a')]);
    expect(Object.values(report.fileMap.headerLines)).toEqual(['fn_00000010']);
    expect(Object.values(report.fileMap.files)).toEqual(
      expect.arrayContaining(['types', 'fn_00000010']),
    );
  });
});

describe('validation checks', () => {
  const baseInput = {
    functionResults: [],
    totalFunctions: 2,
    reviews: undefined,
    hasExecutableComparator: false,
    build: undefined,
  };
  const evaluate = (input: Partial<Parameters<(typeof VALIDATION_CHECKS)[number]>[0]> = {}) =>
    VALIDATION_CHECKS.flatMap((check) => check({ ...baseInput, ...input }));

  it('never claims functional correctness or fidelity', () => {
    const checks = evaluate();
    expect(checks.find((c) => c.id === 'functional')?.outcome).toBe('not-assessed');
    expect(checks.find((c) => c.id === 'fidelity')?.outcome).toBe('not-assessed');
  });

  it('does not invent compile results without a build', () => {
    const checks = evaluate();
    expect(
      checks.filter((c) => c.level === 'syntactic' || c.level === 'compiled').map((c) => c.outcome),
    ).toEqual(['not-assessed', 'not-assessed']);
  });

  it('separates syntax errors from successful compilation', () => {
    const checks = evaluate({
      build: {
        status: 'build-failed',
        builtAt: '',
        errorCount: 1,
        warningCount: 0,
        outputTail: '',
        diagnostics: [{ file: 'a.c', line: 1, severity: 'error', message: 'x' }],
      },
    });
    expect(checks.find((c) => c.id === 'syntax')?.outcome).toBe('failed');
    expect(checks.find((c) => c.id === 'compile')?.outcome).toBe('failed');
  });
});
