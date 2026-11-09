import type { Command } from 'commander';
import type { Project } from '../../core/project/project.js';
import {
  getConfigValue,
  loadConfig,
  setUserConfigValue,
  userConfigPath,
  withConfigValue,
} from '../../infrastructure/config/config.js';
import type { Runtime } from '../runtime.js';

export function registerConfig(program: Command, runtime: Runtime): void {
  const config = program
    .command('config')
    .description('Show or change configuration (project > user > defaults)');

  const resolveProject = (): Promise<Project | undefined> =>
    runtime
      .context()
      .then((c) => c.project)
      .catch(() => undefined);

  config
    .command('list')
    .description('Show the effective configuration')
    .action(async () => {
      const project = await resolveProject();
      runtime.out.json(await loadConfig({ projectLayer: project?.configLayer ?? {} }));
    });

  config
    .command('get <key>')
    .description('Show one value, e.g. claude.maxParallelAgents')
    .action(async (key: string) => {
      const project = await resolveProject();
      const value = getConfigValue(
        await loadConfig({ projectLayer: project?.configLayer ?? {} }),
        key,
      );
      runtime.out.line(typeof value === 'string' ? value : JSON.stringify(value));
    });

  config
    .command('set <key> <value>')
    .description('Set a value for the current project (or with --global for all projects)')
    .option('--global', `write to ${userConfigPath()} instead of the project`)
    .action(async (key: string, value: string, options: { global?: boolean }) => {
      if (options.global) {
        await setUserConfigValue(userConfigPath(), key, value);
        runtime.out.success(`Set ${key} globally.`);
        return;
      }
      const { project } = await runtime.context();
      await project.updateConfigLayer(withConfigValue(project.configLayer, key, value));
      runtime.out.success(`Set ${key} for project ${project.name}.`);
    });
}
