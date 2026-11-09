import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  readJson,
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
