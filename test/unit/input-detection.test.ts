import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../../src/input/adapters/registry.js';
import { RawBinaryAdapter } from '../../src/input/adapters/raw-adapter.js';
import { defaultConfig } from '../../src/infrastructure/config/config.js';
import {
  buildCoffObject,
  buildFatMachO,
  buildMachO,
  buildPe,
  buildZip,
} from '../helpers/binaries.js';
import { makeTempDir, registerTempCleanup } from '../helpers/tmp.js';

registerTempCleanup();
const registry = createDefaultRegistry(defaultConfig().archive);

async function write(name: string, data: Buffer | string): Promise<string> {
  const dir = await makeTempDir();
  const file = path.join(dir, name);
  await fs.writeFile(file, data);
  return file;
}

describe('format detection', () => {
  it('detects a real ELF executable from magic bytes, not from the extension', async () => {
    const elf = await fs.readFile(path.resolve('test/fixtures/build/sample-x86_64'));
    const file = await write('program.txt', elf);
    const detection = await registry.detect(file);
    expect(detection).toMatchObject({
      adapterId: 'elf',
      kind: 'binary',
      format: 'elf',
      confidence: 1,
    });
  });

  it('detects PE, Mach-O, fat Mach-O, COFF and ZIP', async () => {
    expect((await registry.detect(await write('a.bin', buildPe({})))).format).toBe('pe');
    expect((await registry.detect(await write('b.dat', buildMachO()))).format).toBe('macho');
    const fat = buildFatMachO(
      [buildMachO(), buildMachO({ cpu: 0x0100000c })],
      [0x01000007, 0x0100000c],
    );
    expect((await registry.detect(await write('c.dat', fat))).format).toBe('macho');
    expect((await registry.detect(await write('d.obj', buildCoffObject()))).format).toBe('coff');
    expect(
      (
        await registry.detect(
          await write('e.dat', buildZip([{ name: 'x', data: Buffer.from('y') }])),
        )
      ).kind,
    ).toBe('archive');
  });

  it('classifies text files with reference extensions as reference material', async () => {
    const detection = await registry.detect(await write('notes.h', '#define X 1\n'));
    expect(detection).toMatchObject({ kind: 'reference', adapterId: 'reference' });
  });

  it('does not treat a binary file with a .c extension as reference material', async () => {
    const detection = await registry.detect(
      await write('fake.c', Buffer.from([0, 1, 2, 3, 0, 0, 0, 5])),
    );
    expect(detection.kind).not.toBe('reference');
  });

  it('reports unknown content with confidence 0', async () => {
    const detection = await registry.detect(
      await write('mystery', Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01])),
    );
    expect(detection).toMatchObject({ kind: 'unknown', confidence: 0 });
  });

  it('marks an ELF-magic file with broken headers as low-confidence, not valid', async () => {
    const detection = await registry.detect(
      await write('broken', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0])),
    );
    expect(detection.confidence).toBeLessThan(0.5);
  });

  it('does not mistake a Java class file for a universal Mach-O binary', async () => {
    const klass = Buffer.alloc(64);
    klass.writeUInt32BE(0xcafebabe, 0);
    klass.writeUInt32BE(52, 4);
    expect((await registry.detect(await write('A.class', klass))).format).not.toBe('macho');
  });

  it('only suggests raw for files with raw-binary extensions', async () => {
    const raw = new RawBinaryAdapter();
    expect((await raw.detect(await write('fw.bin', Buffer.from([1, 2, 3])))).format).toBe('raw');
    expect((await raw.detect(await write('fw.xyz', Buffer.from([1, 2, 3])))).confidence).toBe(0);
  });
});
