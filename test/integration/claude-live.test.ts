import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Project } from '../../src/core/project/project.js';
import { SAMPLE_ELF } from '../helpers/tools.js';
import { createWorld } from '../helpers/world.js';
import { registerTempCleanup } from '../helpers/tmp.js';

registerTempCleanup();
afterEach(() => vi.unstubAllEnvs());

/**
 * Optional test with the REAL Claude Code CLI (uses your subscription, takes several minutes).
 * Enable with: RECODE_TEST_CLAUDE=1 npm run test:claude
 * Ghidra is still the fake; its decompiler output is replaced by hand-written Ghidra-style text.
 */
const enabled = process.env['RECODE_TEST_CLAUDE'] === '1';

const SIMULATED_GHIDRA_OUTPUT: Record<string, string> = {
  add_ints: 'int add_ints(int param_1,int param_2)\n\n{\n  return param_1 + param_2;\n}\n',
  multiply: 'int multiply(int param_1,int param_2)\n\n{\n  return param_1 * param_2;\n}\n',
  square:
    'int square(int param_1)\n\n{\n  int iVar1;\n  \n  iVar1 = multiply(param_1,param_1);\n  return iVar1;\n}\n',
  shape_area:
    'int shape_area(int *param_1)\n\n{\n  int iVar1;\n  \n  if (*param_1 == 0) {\n    iVar1 = multiply(param_1[1],param_1[2]);\n  }\n  else if (*param_1 == 1) {\n    iVar1 = square(param_1[1]);\n  }\n  else if (*param_1 == 2) {\n    iVar1 = multiply(param_1[1],param_1[2]);\n    iVar1 = iVar1 / 2;\n  }\n  else {\n    iVar1 = -1;\n  }\n  return iVar1;\n}\n',
  sum_areas:
    'int sum_areas(long param_1,int param_2)\n\n{\n  int iVar1;\n  int local_c;\n  int local_8;\n  \n  local_c = 0;\n  for (local_8 = 0; local_8 < param_2; local_8 = local_8 + 1) {\n    iVar1 = shape_area(param_1 + (long)local_8 * 0xc);\n    local_c = add_ints(local_c,iVar1);\n  }\n  return local_c;\n}\n',
  main: 'int main(void)\n\n{\n  int iVar1;\n  undefined4 local_30 [9];\n  \n  local_30[0] = 0;\n  local_30[1] = 3;\n  local_30[2] = 4;\n  local_30[3] = 1;\n  local_30[4] = 5;\n  local_30[5] = 5;\n  local_30[6] = 2;\n  local_30[7] = 6;\n  local_30[8] = 4;\n  iVar1 = sum_areas(local_30,3);\n  printf("total area: %d\\n",iVar1);\n  return 0;\n}\n',
};

describe.skipIf(!enabled)('live Claude Code session (optional)', () => {
  it(
    'reconstructs the sample with the real CLI, agents and subagents',
    { timeout: 45 * 60_000 },
    async () => {
      const world = await createWorld();
      vi.stubEnv('RECODE_CLAUDE_COMMAND', 'claude');
      expect((await world.run(['import', SAMPLE_ELF])).code).toBe(0);
      expect((await world.run(['analyze'], { overrides: { skipPrerequisites: true } })).code).toBe(
        0,
      );

      const project = await Project.open(world.projectDir);
      const id = project.binaries[0]!.id;
      const analysis = project.analysisDir(id);
      const functions = JSON.parse(await fs.readFile(path.join(analysis, 'functions.json'), 'utf8'))
        .functions as Array<{ name: string; decompiledFile: string }>;
      for (const fn of functions) {
        await fs.writeFile(
          path.join(analysis, fn.decompiledFile),
          SIMULATED_GHIDRA_OUTPUT[fn.name] ?? '',
        );
      }

      const result = await world.run(['reconstruct', '--parallel', '2']);
      process.stdout.write(`${result.stdout}\n${result.stderr}\n`);
      expect(result.code, result.stderr).toBe(0);

      const sessions = (
        await fs.readFile(path.join(project.paths.state, 'sessions', `${id}.jsonl`), 'utf8')
      )
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      const delegated = sessions.flatMap((s) => s.subagentsStarted as string[]);
      process.stdout.write(`subagents started: ${JSON.stringify(delegated)}\n`);
      expect(delegated.length).toBeGreaterThan(0);

      const build = await world.run(['build']);
      process.stdout.write(`${build.stdout}\n${build.stderr}\n`);
      const validate = await world.run(['validate']);
      process.stdout.write(`${validate.stdout}\n${validate.stderr}\n`);

      const keep = process.env['RECODE_LIVE_KEEP'];
      if (keep) await fs.cp(world.projectDir, keep, { recursive: true });
    },
  );
});
