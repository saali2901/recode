import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RecodeError } from '../../core/errors/index.js';

/**
 * Resolves a file shipped with the package (templates, Ghidra scripts). Works both when running
 * from src/ (tests) and from dist/ because it walks up until the asset is found.
 */
export function assetPath(...segments: string[]): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, ...segments);
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new RecodeError('INTERNAL', `Bundled asset not found: ${segments.join('/')}`);
}
