import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/infrastructure/config/config.js';
import { extractZip } from '../../src/input/extractors/zip.js';
import { buildZip } from '../helpers/binaries.js';
import { makeTempDir, registerTempCleanup } from '../helpers/tmp.js';

registerTempCleanup();
const limits = defaultConfig().archive;

async function extract(
  entries: Parameters<typeof buildZip>[0],
  overrides: Partial<typeof limits> = {},
) {
  const dir = await makeTempDir();
  const zip = path.join(dir, 'test.zip');
  await fs.writeFile(zip, buildZip(entries));
  const target = path.join(dir, 'out');
  return { dir, target, run: () => extractZip(zip, target, { ...limits, ...overrides }) };
}

describe('safe ZIP extraction', () => {
  it('extracts stored and deflated entries and nested directories', async () => {
    const { target, run } = await extract([
      { name: 'a.txt', data: Buffer.from('hello'), method: 0 },
      { name: 'dir/b.txt', data: Buffer.from('world'.repeat(100)) },
    ]);
    const result = await run();
    expect(result.extracted).toHaveLength(2);
    expect(await fs.readFile(path.join(target, 'dir', 'b.txt'), 'utf8')).toBe('world'.repeat(100));
  });

  it.each(['../evil.txt', 'a/../../evil.txt', '/etc/evil.txt', 'C:\\evil.txt', '..\\evil.txt'])(
    'rejects path traversal entry %s and writes nothing outside the target',
    async (name) => {
      const { dir, run } = await extract([{ name, data: Buffer.from('x') }]);
      await expect(run()).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
      expect(await fs.readdir(dir)).not.toContain('evil.txt');
    },
  );

  it('skips symbolic links instead of creating them', async () => {
    const { target, run } = await extract([
      { name: 'link', data: Buffer.from('/etc/passwd'), unixMode: 0o120777 },
      { name: 'ok.txt', data: Buffer.from('ok') },
    ]);
    const result = await run();
    expect(result.skipped).toEqual([{ name: 'link', reason: 'symbolic link' }]);
    expect(await fs.readdir(target)).toEqual(['ok.txt']);
  });

  it('skips encrypted entries', async () => {
    const { run } = await extract([{ name: 'secret', data: Buffer.from('x'), encrypted: true }]);
    expect((await run()).skipped[0]?.reason).toBe('encrypted entry');
  });

  it('enforces the maximum number of files', async () => {
    const { run } = await extract(
      [
        { name: 'a', data: Buffer.from('1') },
        { name: 'b', data: Buffer.from('2') },
      ],
      { maxFiles: 1 },
    );
    await expect(run()).rejects.toMatchObject({ code: 'ARCHIVE' });
  });

  it('enforces the per-file and total size limits', async () => {
    const big = Buffer.alloc(5000, 1);
    await expect(
      (await extract([{ name: 'big', data: big, method: 0 }], { maxFileBytes: 1000 })).run(),
    ).rejects.toThrow(/per-file/);
    await expect(
      (
        await extract(
          [
            { name: 'a', data: big, method: 0 },
            { name: 'b', data: big, method: 0 },
          ],
          { maxTotalBytes: 6000 },
        )
      ).run(),
    ).rejects.toThrow(/total/);
  });

  it('detects ZIP bombs through the compression ratio', async () => {
    const { run } = await extract([{ name: 'bomb', data: Buffer.alloc(2_000_000, 0) }], {
      maxCompressionRatio: 50,
    });
    await expect(run()).rejects.toThrow(/compression ratio/);
  });

  it('does not trust headers that understate the real size', async () => {
    const { run } = await extract([
      { name: 'liar', data: Buffer.alloc(10_000, 7), fakeUncompressedSize: 10 },
    ]);
    await expect(run()).rejects.toMatchObject({ code: 'ARCHIVE' });
  });

  it('rejects corrupt archives with a clear error', async () => {
    const dir = await makeTempDir();
    const zip = path.join(dir, 'broken.zip');
    await fs.writeFile(zip, Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(100, 1)]));
    await expect(extractZip(zip, path.join(dir, 'out'), limits)).rejects.toMatchObject({
      code: 'ARCHIVE',
    });
  });

  it('never overwrites existing files in the target directory', async () => {
    const { target, run } = await extract([{ name: 'a.txt', data: Buffer.from('new') }]);
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'a.txt'), 'old');
    await expect(run()).rejects.toThrow(/Duplicate or conflicting/);
    expect(await fs.readFile(path.join(target, 'a.txt'), 'utf8')).toBe('old');
  });

  it('refuses to write through a pre-existing symlinked directory', async () => {
    const { dir, target, run } = await extract([{ name: 'sub/file.txt', data: Buffer.from('x') }]);
    const outside = path.join(dir, 'outside');
    await fs.mkdir(outside);
    await fs.mkdir(target);
    await fs.symlink(outside, path.join(target, 'sub'));
    await expect(run()).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(await fs.readdir(outside)).toEqual([]);
  });
});
