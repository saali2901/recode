import type { Command } from 'commander';
import { ExitCode } from '../../core/errors/index.js';
import { Project } from '../../core/project/project.js';
import {
  loadConfig,
  setUserConfigValue,
  userConfigPath,
} from '../../infrastructure/config/config.js';
import { runProcess } from '../../infrastructure/process/process-manager.js';
import { which } from '../../infrastructure/process/which.js';
import { runChecks } from '../../infrastructure/tools/doctor.js';
import {
  mergeWindowsPath,
  parseRegistryPaths,
  READ_PATH_SCRIPT,
} from '../../setup/windows-path.js';
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
      const result = await runSetup({
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
        refreshPath: async () => {
          if (platform !== 'win32') return;
          const result = await runProcess({
            command: 'powershell.exe',
            args: ['-NoProfile', '-NonInteractive', '-Command', READ_PATH_SCRIPT],
            timeoutMs: 20_000,
          });
          const { machine, user } = parseRegistryPaths(result.stdout);
          if (machine || user)
            process.env['PATH'] = mergeWindowsPath(machine, user, process.env['PATH'] ?? '');
        },
        confirm: async (question) => {
          const answer = await runtime.prompt(question);
          return answer === undefined ? undefined : /^y(es)?$/i.test(answer);
        },
        setConfig: (key, value) => setUserConfigValue(userConfigPath(), key, JSON.stringify(value)),
        dryRun: options.dryRun === true,
        yes: options.yes === true,
        ...(options.only ? { only: options.only.split(',').map((s) => s.trim()) } : {}),
      });
      if (result.incomplete) process.exitCode = ExitCode.Prerequisite;
    });
}
