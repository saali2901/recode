import type { Command } from 'commander';
import { Project } from '../../core/project/project.js';
import {
  loadConfig,
  setUserConfigValue,
  userConfigPath,
} from '../../infrastructure/config/config.js';
import { runProcess } from '../../infrastructure/process/process-manager.js';
import { which } from '../../infrastructure/process/which.js';
import { runChecks } from '../../infrastructure/tools/doctor.js';
import { defaultDataDir, detectPackageManager, runSetup } from '../../setup/setup.js';
import type { Runtime } from '../runtime.js';

export function registerSetup(program: Command, runtime: Runtime): void {
  program
    .command('setup')
    .description('Install missing tools (JDK, C compiler, CMake, Ninja, Ghidra, Claude Code)')
    .option('-y, --yes', 'do not ask for confirmation')
    .option('--dry-run', 'only show what would be installed')
    .option('--only <steps>', 'comma-separated subset of: packages, ghidra, claude')
    .action(async (options: { yes?: boolean; dryRun?: boolean; only?: string }) => {
      const project = await Project.resolve(undefined, runtime.cwd).catch(() => undefined);
      const config = await loadConfig({ projectLayer: project?.configLayer ?? {} });
      const platform = process.platform;
      await runSetup({
        platform,
        config,
        out: runtime.out,
        dataDir: defaultDataDir(),
        checks: () => runChecks(config),
        run: (spec) =>
          runProcess({
            command: spec.command,
            args: spec.args,
            onStdoutLine: (line) => runtime.out.line(`  ${line}`),
            onStderrLine: (line) => runtime.out.line(`  ${line}`),
            signal: runtime.signal,
          }),
        detectPackageManager: () => detectPackageManager(platform),
        isRoot: typeof process.getuid === 'function' && process.getuid() === 0,
        hasSudo: (await which('sudo')) !== undefined,
        confirm: async (question) => {
          const answer = await runtime.prompt(question);
          return answer === undefined ? undefined : /^y(es)?$/i.test(answer);
        },
        setConfig: (key, value) => setUserConfigValue(userConfigPath(), key, JSON.stringify(value)),
        dryRun: options.dryRun === true,
        yes: options.yes === true,
        ...(options.only ? { only: options.only.split(',').map((s) => s.trim()) } : {}),
      });
    });
}
