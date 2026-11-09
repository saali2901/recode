import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { RecodeError } from '../../core/errors/index.js';
import { pathExists, readJson, writeJsonAtomic } from '../../infrastructure/filesystem/files.js';

const ClaudeConfigSchema = z.record(z.string(), z.unknown());

/** Location of Claude Code's global state file (honours CLAUDE_CONFIG_DIR). */
export function claudeConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env['CLAUDE_CONFIG_DIR'];
  return dir ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

/** Claude Code keys projects by absolute path with forward slashes, also on Windows. */
export function projectKey(root: string): string {
  return path.resolve(root).replace(/\\/g, '/');
}

/**
 * Marks a project folder as trusted in Claude Code's own configuration — the same flag the interactive trust
 * dialog sets. Without it, headless sessions ignore the folder's `.claude/settings.json`. Only call this on
 * an explicit user request; it changes a file that belongs to Claude Code.
 */
export async function trustProject(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ file: string; alreadyTrusted: boolean }> {
  const file = claudeConfigFile(env);
  const config = (await pathExists(file)) ? await readJson(file, ClaudeConfigSchema) : {};
  const projects = z
    .record(z.string(), z.record(z.string(), z.unknown()))
    .safeParse(config['projects']);
  if (config['projects'] !== undefined && !projects.success) {
    throw new RecodeError(
      'PARSE',
      `${file} has an unexpected "projects" structure; not touching it.`,
    );
  }
  const all = projects.success ? projects.data : {};
  const key = projectKey(root);
  const existing = all[key] ?? {};
  if (existing['hasTrustDialogAccepted'] === true) return { file, alreadyTrusted: true };
  await writeJsonAtomic(file, {
    ...config,
    projects: { ...all, [key]: { ...existing, hasTrustDialogAccepted: true } },
  });
  return { file, alreadyTrusted: false };
}
