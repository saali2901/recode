import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Project } from '../../src/core/project/project.js';
import {
  buildVectors,
  generateRunner,
  DifferentialSpecSchema,
} from '../../src/validation/differential/differential.js';
import { SAMPLE_ELF } from '../helpers/tools.js';
import { createWorld, type World } from '../helpers/world.js';
import { registerTempCleanup } from '../helpers/tmp.js';

registerTempCleanup();
afterEach(() => vi.unstubAllEnvs());
const HERMETIC = { skipPrerequisites: true } as const;

const REFERENCE = `
int add_ints(int a, int b) { return a + b; }
int multiply(int a, int b) { return a * b; }
int main(void) { return 0; }
`;

const SPEC = {
  referenceSource: 'reference/ref.c',
  cases: [
    { function: 'add_ints', returns: 'int', params: [{ type: 'int' }, { type: 'int' }] },
    { function: 'multiply', returns: 'int', params: [{ type: 'int' }, { type: 'int' }] },
  ],
};

async function built(): Promise<{ world: World; id: string }> {
  const world = await createWorld();
  expect((await world.run(['import', SAMPLE_ELF])).code).toBe(0);
  const id = (await Project.open(world.projectDir)).binaries[0]!.id;
  expect((await world.run(['analyze'], { overrides: HERMETIC })).code).toBe(0);
  expect((await world.run(['reconstruct'], { overrides: HERMETIC })).code).toBe(0);
  expect((await world.run(['build'], { overrides: HERMETIC })).code).toBe(0);
  return { world, id };
}

async function configure(world: World, reference: string, spec: object = SPEC): Promise<void> {
  await fs.mkdir(path.join(world.projectDir, 'reference'), { recursive: true });
  await fs.writeFile(path.join(world.projectDir, 'reference', 'ref.c'), reference);
  await fs.writeFile(path.join(world.projectDir, 'reference', 'diff.json'), JSON.stringify(spec));
  await world.run(['config', 'set', 'validation.differentialSpec', 'reference/diff.json']);
}

async function functional(world: World, id: string) {
  const result = await world.run(['validate', '--force'], { overrides: HERMETIC });
  const report = JSON.parse(
    await fs.readFile(path.join(world.projectDir, 'reconstruction', id, 'validation.json'), 'utf8'),
  ) as { checks: Array<{ id: string; outcome: string; detail: string }> };
  return { result, check: report.checks.find((c) => c.id === 'functional')! };
}

describe('differential testing against reference source', () => {
  it('passes when the reconstruction behaves like the reference, and says what that proves', async () => {
    const { world, id } = await built();
    await configure(world, REFERENCE);
    const { check } = await functional(world, id);
    expect(check.outcome).toBe('passed');
    expect(check.detail).toMatch(/2 function\(s\) matched the reference on \d+ vector/);
    expect(check.detail).toContain('does not prove equivalence');
  });

  it('fails and names the function when behaviour differs', async () => {
    const { world, id } = await built();
    await configure(world, REFERENCE.replace('a * b', 'a * b + 1'));
    const { result, check } = await functional(world, id);
    expect(check.outcome).toBe('failed');
    expect(check.detail).toContain('multiply');
    expect(check.detail).not.toMatch(/add_ints[^.]*differ/);
    expect(result.code).toBe(1);
  });

  it('reports functions that were not reconstructed as not assessed instead of passing them', async () => {
    const { world, id } = await built();
    await configure(world, REFERENCE, {
      ...SPEC,
      cases: [...SPEC.cases, { function: 'no_such_function', returns: 'int', params: [] }],
    });
    const { check } = await functional(world, id);
    expect(check.outcome).toBe('passed');
    expect(check.detail).toContain('1 not assessed');
  });

  it('is not assessed (never silently passed) when the reference does not compile', async () => {
    const { world, id } = await built();
    await configure(world, 'int add_ints( {');
    const { check } = await functional(world, id);
    expect(check.outcome).toBe('not-assessed');
    expect(check.detail).toContain('does not compile');
  });

  it('stays not assessed without a spec', async () => {
    const { world, id } = await built();
    const { check } = await functional(world, id);
    expect(check.outcome).toBe('not-assessed');
  });
});

describe('differential test generator', () => {
  const spec = DifferentialSpecSchema.parse({
    referenceSource: 'ref.c',
    cases: [
      {
        function: 'f',
        returns: 'int',
        params: [{ type: 'int' }, { type: 'unsigned char' }, { type: 'buffer', size: 8 }],
      },
    ],
  });

  it('includes edge values and a deterministic random sample', () => {
    const vectors = buildVectors(spec.cases[0]!);
    expect(vectors.length).toBeGreaterThan(30);
    expect(vectors.some((v) => v[0] === '2147483647')).toBe(true);
    expect(vectors.some((v) => v[0] === '-2147483648')).toBe(true);
    expect(vectors.some((v) => v[1] === '255')).toBe(true);
    expect(buildVectors(spec.cases[0]!)).toEqual(vectors);
  });

  it('compares return values and buffer contents', () => {
    const source = generateRunner(spec);
    expect(source).toContain('extern int f(int, unsigned char, unsigned char *);');
    expect(source).toContain('recode_ref_0');
    expect(source).toContain('memcmp');
  });
});
