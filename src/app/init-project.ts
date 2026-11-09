import fs from 'node:fs/promises';
import path from 'node:path';
import { RecodeError } from '../core/errors/index.js';
import { Project } from '../core/project/project.js';
import { assetPath } from '../infrastructure/filesystem/assets.js';

export const PROJECT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Creates a project directory with agent definitions, settings and rules from the templates. */
export async function initProject(parentDirectory: string, name: string): Promise<Project> {
  if (!PROJECT_NAME_PATTERN.test(name)) {
    throw new RecodeError('INVALID_INPUT', `Invalid project name "${name}".`, {
      hint: 'Use letters, digits, ".", "_" and "-" (max. 64 characters, starting with a letter or digit).',
    });
  }
  const project = await Project.create(path.join(path.resolve(parentDirectory), name), name);
  const templates = assetPath('templates', 'claude');
  await fs.cp(path.join(templates, 'agents'), path.join(project.root, '.claude', 'agents'), {
    recursive: true,
  });
  await fs.copyFile(
    path.join(templates, 'settings.json'),
    path.join(project.root, '.claude', 'settings.json'),
  );
  await fs.copyFile(path.join(templates, 'CLAUDE.md'), path.join(project.root, 'CLAUDE.md'));
  await fs.writeFile(path.join(project.root, '.gitignore'), '.recode/\nbuild/\n');
  return project;
}
