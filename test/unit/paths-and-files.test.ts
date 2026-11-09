import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  readJson,
  renameWithRetry,
  writeFileAtomic,
  writeJsonAtomic,
  copyUnique,
} from '../../src/infrastructure/filesystem/files.js';
import {
  isInside,
  safeJoin,
  sanitizeFileName,
  sanitizeIdentifier,
} from '../../src/infrastructure/filesystem/paths.js';
import { makeTempDir, registerTempCleanup } from '../helpers/tmp.js';

registerTempCleanup();
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('renameWithRetry', () => {
  const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

  it('survives a target that is briefly locked (Windows EPERM)', async () => {
    const dir = await makeTempDir();
    const target = path.join(dir, 'state.json');
    await fs.writeFile(target, 'old');
    await writeFileAtomic(target, 'seed');
    const real = fs.rename.bind(fs);
    let failures = 2;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (failures-- > 0) throw errno('EPERM');
      return real(from, to);
    });
    await writeFileAtomic(target, 'new');
    expect(await fs.readFile(target, 'utf8')).toBe('new');
    expect(failures).toBeLessThan(0);
  });

  it('gives up after repeated failures and does not retry other errors', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(fs, 'rename').mockRejectedValue(errno('EPERM'));
    const failing = renameWithRetry('a', 'b');
    const assertion = expect(failing).rejects.toMatchObject({ code: 'EPERM' });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(spy).toHaveBeenCalledTimes(8);

    spy.mockReset().mockRejectedValue(errno('ENOENT'));
    await expect(renameWithRetry('a', 'b')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('path validation', () => {
  it('keeps joined paths inside the root', () => {
    expect(safeJoin('/root', 'a', 'b.txt')).toBe(path.resolve('/root/a/b.txt'));
  });

  it.each([['..'], ['a/../..'], ['/abs'], ['C:\\x'], ['\\\\server\\share'], ['a\0b']])(
    'rejects %s',
    (segment) => {
      expect(() => safeJoin('/root', segment)).toThrowError(
        expect.objectContaining({ code: 'UNSAFE_PATH' }),
      );
    },
  );

  it('distinguishes sibling directories with a common prefix', () => {
    expect(isInside('/root/project', '/root/project-evil/file')).toBe(false);
    expect(isInside('/root/project', '/root/project/file')).toBe(true);
  });

  it('sanitizes names', () => {
    const traversal = sanitizeFileName('../../etc/passwd');
    expect(traversal).not.toMatch(/[\\/]/);
    expect(traversal.startsWith('.')).toBe(false);
    expect(sanitizeFileName('..hidden')).toBe('hidden');
    expect(sanitizeFileName('???')).toBe('_');
    expect(sanitizeIdentifier('9lives-x')).toBe('_9lives_x');
    expect(sanitizeIdentifier('')).toBe('unnamed');
  });
});

describe('atomic file writes', () => {
  it('replaces content and leaves no temp files', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'state.json');
    await writeJsonAtomic(file, { a: 1 });
    await writeJsonAtomic(file, { a: 2 });
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ a: 2 });
    expect(await fs.readdir(dir)).toEqual(['state.json']);
  });

  it('keeps the old file intact if the write cannot complete', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'state.json');
    await writeJsonAtomic(file, { ok: true });
    await fs.mkdir(path.join(dir, 'blocked'));
    await expect(writeFileAtomic(path.join(dir, 'blocked'), 'x')).rejects.toThrow();
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ ok: true });
    expect((await fs.readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('validates JSON on read and names the file in errors', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'x.json');
    await fs.writeFile(file, '{"a": "not a number"}');
    await expect(readJson(file, z.object({ a: z.number() }))).rejects.toThrow(/x\.json/);
    await fs.writeFile(file, '{broken');
    await expect(readJson(file, z.unknown())).rejects.toThrow(/not valid JSON/);
  });

  it('copyUnique never overwrites', async () => {
    const dir = await makeTempDir();
    const source = path.join(dir, 'src.bin');
    await fs.writeFile(source, 'one');
    const first = await copyUnique(source, path.join(dir, 'out'), 'f.bin');
    await fs.writeFile(source, 'two');
    const second = await copyUnique(source, path.join(dir, 'out'), 'f.bin');
    expect(path.basename(first)).toBe('f.bin');
    expect(path.basename(second)).toBe('f-1.bin');
    expect(await fs.readFile(first, 'utf8')).toBe('one');
  });
});
