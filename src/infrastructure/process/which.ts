import fs from 'node:fs/promises';
import path from 'node:path';

/** The parts of `fs/promises` that `which` needs; injectable for tests. */
export interface WhichFs {
  access(file: string, mode?: number): Promise<void>;
  stat(file: string): Promise<{ isFile(): boolean }>;
  lstat(file: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean }>;
}

/**
 * Resolves an executable like `which`, without invoking a shell.
 *
 * Windows "app execution aliases" (e.g. winget.exe in WindowsApps) are reparse points that Node cannot
 * `stat()`; they are accepted when `lstat()` sees the entry, since CreateProcess can run them.
 */
export async function which(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  fsApi: WhichFs = fs,
): Promise<string | undefined> {
  const candidates = candidatePaths(command, env, platform);
  for (const candidate of candidates) {
    try {
      await fsApi.access(candidate, fs.constants.X_OK);
      const stat = await fsApi.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      if (platform === 'win32' && (await isAppExecutionAlias(candidate, fsApi))) return candidate;
    }
  }
  return undefined;
}

async function isAppExecutionAlias(candidate: string, fsApi: WhichFs): Promise<boolean> {
  if (!candidate.toLowerCase().endsWith('.exe')) return false;
  try {
    const entry = await fsApi.lstat(candidate);
    return entry.isFile() || entry.isSymbolicLink();
  } catch {
    return false;
  }
}

function candidatePaths(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  const extensions = platform === 'win32' ? (env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';') : [''];
  if (command.includes('/') || command.includes('\\')) {
    return extensions.map((ext) => command + ext);
  }
  const delimiter = platform === 'win32' ? ';' : path.delimiter;
  const join = platform === 'win32' ? path.win32.join : path.join;
  const dirs = (env['PATH'] ?? env['Path'] ?? '').split(delimiter).filter(Boolean);
  return dirs.flatMap((dir) => extensions.map((ext) => join(dir, command + ext)));
}
