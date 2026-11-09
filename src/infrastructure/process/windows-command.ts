import path from 'node:path';
import { RecodeError } from '../../core/errors/index.js';
import { which } from './which.js';

export interface SpawnTarget {
  command: string;
  args: string[];
  /** True when the argument string was built by hand for cmd.exe and must not be re-quoted by Node. */
  windowsVerbatimArguments: boolean;
}

const BATCH_FILE = /\.(cmd|bat)$/i;

/** Quotes one argument for cmd.exe. Characters that cannot be quoted safely are rejected. */
export function quoteForCmd(arg: string): string {
  if (/["%\r\n\0]/.test(arg)) {
    throw new RecodeError(
      'UNSAFE_PATH',
      `Argument contains characters that cannot be passed safely to a batch file: ${JSON.stringify(arg)}`,
    );
  }
  return /^[A-Za-z0-9_./:\\=,+@-]+$/.test(arg) ? arg : `"${arg}"`;
}

/**
 * Node refuses to start .cmd/.bat files without a shell (and with one, arguments would be interpolated).
 * Batch files are therefore run through `cmd.exe /d /s /c` with every argument quoted by `quoteForCmd`;
 * double quotes and percent signs are rejected outright.
 */
export function buildCmdInvocation(
  file: string,
  args: readonly string[],
  comSpec = 'cmd.exe',
): SpawnTarget {
  const line = [`"${file}"`, ...args.map(quoteForCmd)].join(' ');
  if (/["\r\n\0%]/.test(file)) {
    throw new RecodeError(
      'UNSAFE_PATH',
      `Unsafe file name for a batch file: ${JSON.stringify(file)}`,
    );
  }
  return {
    command: comSpec,
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * Resolves what to actually spawn. On Windows a bare command such as `claude` is looked up in PATH
 * (honouring PATHEXT), and batch files are wrapped; on other systems nothing changes.
 */
export async function prepareSpawn(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<SpawnTarget> {
  if (platform !== 'win32') return { command, args: [...args], windowsVerbatimArguments: false };
  const resolved = path.extname(command) ? command : ((await which(command, env)) ?? command);
  const file = BATCH_FILE.test(resolved) ? resolved : ((await which(resolved, env)) ?? resolved);
  if (BATCH_FILE.test(file)) return buildCmdInvocation(file, args, env['ComSpec'] ?? 'cmd.exe');
  return { command: file, args: [...args], windowsVerbatimArguments: false };
}
