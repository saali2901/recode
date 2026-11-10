export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** Remaining time from the rate of completed work so far; undefined until there is a basis. */
export function estimateRemaining(
  elapsedMs: number,
  completed: number,
  total: number,
): number | undefined {
  if (completed < 1 || total <= completed || elapsedMs <= 0) return undefined;
  return (elapsedMs / completed) * (total - completed);
}

export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}
