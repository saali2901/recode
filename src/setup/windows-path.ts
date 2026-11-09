/**
 * Combines the PATH values stored in the Windows registry (machine, then user) with the entries of the
 * running process, keeping order and dropping duplicates (compared case-insensitively, as Windows does).
 */
export function mergeWindowsPath(machine: string, user: string, current: string): string {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of [machine, user, current].flatMap((value) => value.split(';'))) {
    const trimmed = entry.trim();
    if (trimmed === '' || seen.has(trimmed.toLowerCase())) continue;
    seen.add(trimmed.toLowerCase());
    result.push(trimmed);
  }
  return result.join(';');
}

/** Reads the machine and user PATH from the registry through PowerShell (no shell interpolation). */
export const READ_PATH_SCRIPT =
  "[Environment]::GetEnvironmentVariable('Path','Machine') + [char]10 + [Environment]::GetEnvironmentVariable('Path','User')";

export function parseRegistryPaths(output: string): { machine: string; user: string } {
  const [machine = '', user = ''] = output.split(/\r?\n/);
  return { machine: machine.trim(), user: user.trim() };
}
