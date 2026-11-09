import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { RecodeError } from '../../core/errors/index.js';
import { Project } from '../../core/project/project.js';
import { assetPath } from '../../infrastructure/filesystem/assets.js';
import type { Runtime } from '../runtime.js';

const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function registerInit(program: Command, runtime: Runtime): void {
  program
    .command('init <project-name>')
    .description('Create a new ReCode project directory')
    .option('--dir <path>', 'parent directory (default: current directory)')
    .action(async (name: string, options: { dir?: string }) => {
      if (!PROJECT_NAME.test(name)) {
        throw new RecodeError('INVALID_INPUT', `Invalid project name "${name}".`, {
          hint: 'Use letters, digits, ".", "_" and "-" (max. 64 characters, starting with a letter or digit).',
        });
      }
      const parent = path.resolve(runtime.cwd, options.dir ?? '.');
      const project = await Project.create(path.join(parent, name), name);

      const claudeTemplates = assetPath('templates', 'claude');
      await fs.cp(
        path.join(claudeTemplates, 'agents'),
        path.join(project.root, '.claude', 'agents'),
        { recursive: true },
      );
      await fs.copyFile(
        path.join(claudeTemplates, 'settings.json'),
        path.join(project.root, '.claude', 'settings.json'),
      );
      await fs.copyFile(
        path.join(claudeTemplates, 'CLAUDE.md'),
        path.join(project.root, 'CLAUDE.md'),
      );
      await fs.writeFile(path.join(project.root, '.gitignore'), '.recode/\nbuild/\n');

      runtime.out.success(`Created project "${name}" at ${project.root}`);
      runtime.out.line('Next steps:');
      runtime.out.line(`  cd ${path.relative(runtime.cwd, project.root) || '.'}`);
      runtime.out.line('  recode doctor            # check required tools');
      runtime.out.line('  recode import <file>     # add a binary');
      runtime.out.line('  recode run               # analyze, reconstruct, build, validate');
    });
}
