import type { Command } from 'commander';
import { trustProject } from '../../ai/claude/trust.js';
import type { Runtime } from '../runtime.js';

export function registerTrust(program: Command, runtime: Runtime): void {
  program
    .command('trust')
    .description('Mark the project folder as trusted for Claude Code (needed once per project)')
    .action(async () => {
      const { project } = await runtime.context();
      const result = await trustProject(project.root);
      if (result.alreadyTrusted) runtime.out.success('The project folder is already trusted.');
      else runtime.out.success(`Marked ${project.root} as trusted in ${result.file}.`);
    });
}
