/** Heuristic: true if the buffer looks like UTF-8/ASCII text rather than binary data. */
export function looksLikeText(sample: Buffer): boolean {
  if (sample.length === 0) return true;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious++;
  }
  return suspicious / sample.length < 0.02;
}

export const REFERENCE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cxx',
  '.h',
  '.hh',
  '.hpp',
  '.json',
  '.yaml',
  '.yml',
  '.txt',
  '.md',
  '.map',
  '.sym',
]);
