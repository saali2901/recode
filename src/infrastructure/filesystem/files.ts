import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ZodType } from 'zod';
import { RecodeError } from '../../core/errors/index.js';

const TRANSIENT_RENAME_ERRORS = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_ATTEMPTS = 8;

/**
 * Renames over an existing file. On Windows this fails transiently (EPERM/EBUSY/EACCES) while another process
 * (virus scanner, indexer) or a concurrent reader briefly holds the target open, so it is retried with a short
 * backoff before the error is reported.
 */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!TRANSIENT_RENAME_ERRORS.has(code) || attempt >= RENAME_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** (attempt - 1)));
    }
  }
}

export interface AtomicWriteOptions {
  /**
   * Flush to disk before the rename (default). Disable only for derived data that is rebuilt or treated as a miss
   * when found torn after a power loss (cache entries, per-task context files); the rename stays atomic.
   */
  durable?: boolean;
}

/** Writes a file atomically: temp file in the same directory, fsync, rename. */
export async function writeFileAtomic(
  filePath: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(data);
    if (options.durable !== false) await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await renameWithRetry(tmp, filePath);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

/** Reads and validates a JSON file. Throws RecodeError(PARSE) with the file name on failure. */
export async function readJson<T>(filePath: string, schema: ZodType<T>): Promise<T> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    throw new RecodeError('PARSE', `Cannot read ${filePath}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new RecodeError('PARSE', `${filePath} is not valid JSON: ${(error as Error).message}`, {
      cause: error,
    });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new RecodeError(
      'PARSE',
      `${filePath} has an unexpected structure: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/** Like readJson but returns undefined if the file does not exist. */
export async function readJsonIfExists<T>(
  filePath: string,
  schema: ZodType<T>,
): Promise<T | undefined> {
  if (!(await pathExists(filePath))) return undefined;
  return readJson(filePath, schema);
}

export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Reads at most `length` bytes from the start of a file. */
export async function readHead(filePath: string, length: number): Promise<Buffer> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Copies a file without overwriting an existing one; returns the final path. */
export async function copyUnique(
  source: string,
  directory: string,
  fileName: string,
): Promise<string> {
  await fs.mkdir(directory, { recursive: true });
  const ext = path.extname(fileName);
  const stem = path.basename(fileName, ext);
  for (let i = 0; i < 1000; i++) {
    const name = i === 0 ? fileName : `${stem}-${i}${ext}`;
    const target = path.join(directory, name);
    try {
      await fs.copyFile(source, target, 1 /* COPYFILE_EXCL */);
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new RecodeError('INVALID_INPUT', `Cannot find a free file name for ${fileName}`);
}
