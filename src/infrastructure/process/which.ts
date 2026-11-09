import fs from 'node:fs/promises';
import path from 'node:path';

/** Resolves an executable like `which`, without invoking a shell. */
export async function which(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const candidates = await candidatePaths(command, env);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

async function candidatePaths(command: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const extensions =
    process.platform === 'win32' ? (env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';') : [''];
  if (command.includes('/') || command.includes('\\')) {
    return extensions.map((ext) => command + ext);
  }
  const dirs = (env['PATH'] ?? '').split(path.delimiter).filter(Boolean);
  return dirs.flatMap((dir) => extensions.map((ext) => path.join(dir, command + ext)));
}
