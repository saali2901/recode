import type { Command } from 'commander';
import { ExitCode } from '../../core/errors/index.js';
import { Project } from '../../core/project/project.js';
import { loadConfig } from '../../infrastructure/config/config.js';
import { runChecks } from '../../infrastructure/tools/doctor.js';
import type { Runtime } from '../runtime.js';

export function registerDoctor(program: Command, runtime: Runtime): void {
  program
    .command('doctor')
    .description(
      'Check Node.js, Claude Code (and login), Ghidra, Java, C compiler, CMake and Ninja',
    )
    .option('--json', 'machine-readable output')
    .action(async (options: { json?: boolean }) => {
      const project = await Project.resolve(undefined, runtime.cwd).catch(() => undefined);
      const config = await loadConfig({ projectLayer: project?.configLayer ?? {} });
      const results = await runChecks(config);
      if (options.json) {
        runtime.out.json(results);
      } else {
        const symbol = { ok: '✓', warn: '!', fail: '✗' } as const;
        runtime.out.table(results.map((r) => [symbol[r.status], r.label, r.detail]));
        for (const r of results.filter((x) => x.status !== 'ok' && x.hint)) {
          runtime.out.hint(`${r.label}: ${r.hint}`);
        }
      }
      if (results.some((r) => r.status === 'fail')) process.exitCode = ExitCode.Prerequisite;
    });
}
