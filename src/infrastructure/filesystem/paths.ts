import path from 'node:path';
import { RecodeError } from '../../core/errors/index.js';

/** True if `candidate` is `root` itself or located below it (lexical check). */
export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Joins untrusted relative segments onto a root and guarantees the result stays below it.
 * @throws RecodeError(UNSAFE_PATH) on traversal, absolute paths or NUL bytes.
 */
export function safeJoin(root: string, ...segments: string[]): string {
  for (const segment of segments) {
    if (segment.includes('\0')) {
      throw new RecodeError('UNSAFE_PATH', 'Path contains a NUL byte.');
    }
    if (path.isAbsolute(segment) || /^[a-zA-Z]:/.test(segment) || segment.startsWith('\\')) {
      throw new RecodeError('UNSAFE_PATH', `Absolute path not allowed: ${segment}`);
    }
  }
  const resolved = path.resolve(root, ...segments);
  if (!isInside(root, resolved)) {
    throw new RecodeError('UNSAFE_PATH', `Path escapes its root directory: ${segments.join('/')}`);
  }
  return resolved;
}

/** Reduces an arbitrary name to a conservative file-name component. */
export function sanitizeFileName(name: string, fallback = 'file'): string {
  const base = name
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 100);
  return base.length > 0 ? base : fallback;
}

/** Makes a valid C identifier out of an arbitrary name. */
export function sanitizeIdentifier(name: string, fallback = 'unnamed'): string {
  let id = name.replace(/[^A-Za-z0-9_]/g, '_');
  if (id.length === 0) return fallback;
  if (/^[0-9]/.test(id)) id = `_${id}`;
  return id.slice(0, 120);
}
