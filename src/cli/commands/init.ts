import path from 'node:path';
import type { Command } from 'commander';
import { initProject } from '../../app/init-project.js';
import type { Runtime } from '../runtime.js';

export function registerInit(program: Command, runtime: Runtime): void {
  program
    .command('init <project-name>')
    .description('Create a new ReCode project directory')
    .option('--dir <path>', 'parent directory (default: current directory)')
    .action(async (name: string, options: { dir?: string }) => {
      const parent = path.resolve(runtime.cwd, options.dir ?? '.');
      const project = await initProject(parent, name);

      runtime.out.success(`Created project "${name}" at ${project.root}`);
      runtime.out.line('Next steps:');
      runtime.out.line(`  cd ${path.relative(runtime.cwd, project.root) || '.'}`);
      runtime.out.line('  recode doctor            # check required tools');
      runtime.out.line('  recode import <file>     # add a binary');
      runtime.out.line('  recode run               # analyze, reconstruct, build, validate');
    });
}
