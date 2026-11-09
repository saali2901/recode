import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RawBinaryAdapter } from '../../src/input/adapters/raw-adapter.js';
import { createDefaultRegistry } from '../../src/input/adapters/registry.js';
import { defaultConfig } from '../../src/infrastructure/config/config.js';
import { BinaryMetadataSchema } from '../../src/input/interfaces/types.js';
import { buildCoffObject, buildFatMachO, buildMachO, buildPe } from '../helpers/binaries.js';
import { makeTempDir, registerTempCleanup } from '../helpers/tmp.js';

registerTempCleanup();
const registry = createDefaultRegistry(defaultConfig().archive);

async function metadataOf(adapterId: string, data: Buffer) {
  const dir = await makeTempDir();
  const file = path.join(dir, 'input.bin');
  await fs.writeFile(file, data);
  const metadata = await registry.get(adapterId)!.getMetadata(file);
  expect(BinaryMetadataSchema.safeParse(metadata).success).toBe(true);
  return metadata;
}

describe('ELF metadata (real gcc output)', () => {
  it('extracts architecture, entry point, sections and symbols from a compiled executable', async () => {
    const data = await fs.readFile(path.resolve('test/fixtures/build/sample-x86_64'));
    const m = await metadataOf('elf', data);
    expect(m).toMatchObject({
      format: 'elf',
      kind: 'executable',
      architecture: 'x86_64',
      bits: 64,
      endianness: 'little',
    });
    expect(m.entryPoint).toMatch(/^0x4/);
    expect(m.sections.map((s) => s.name)).toContain('.text');
    expect(m.segments.length).toBeGreaterThan(0);
    const names = m.symbols.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining(['add_ints', 'multiply', 'square', 'shape_area', 'sum_areas', 'main']),
    );
    expect(m.symbols.find((s) => s.name === 'add_ints')?.type).toBe('function');
  });

  it('classifies relocatable objects as "object" without entry point', async () => {
    const data = await fs.readFile(path.resolve('test/fixtures/build/sample.o'));
    const m = await metadataOf('elf', data);
    expect(m.kind).toBe('object');
    expect(m.entryPoint).toBeUndefined();
  });
});

describe('PE metadata', () => {
  it('reads PE32+ executables', async () => {
    const m = await metadataOf('pe', buildPe({ bits: 64 }));
    expect(m).toMatchObject({
      format: 'pe',
      kind: 'executable',
      architecture: 'x86_64',
      bits: 64,
      endianness: 'little',
    });
    expect(m.entryPoint).toBe('0x140001000');
    expect(m.baseAddress).toBe('0x140000000');
    expect(m.sections[0]).toMatchObject({
      name: '.text',
      address: '0x140001000',
      permissions: 'r-x',
    });
  });

  it('reads 32-bit DLLs including the export table', async () => {
    const m = await metadataOf('pe', buildPe({ bits: 32, dll: true, exportName: 'my_export' }));
    expect(m).toMatchObject({ kind: 'shared-library', architecture: 'x86', bits: 32 });
    expect(m.symbols).toEqual([
      expect.objectContaining({ name: 'my_export', address: '0x401010', type: 'function' }),
    ]);
  });

  it('warns about unknown machine types instead of guessing', async () => {
    const m = await metadataOf('pe', buildPe({ machine: 0x1234 }));
    expect(m.architecture).toBe('unknown');
    expect(m.warnings.join()).toContain('Unknown PE machine');
  });
});

describe('Mach-O metadata', () => {
  it('reads a thin 64-bit image with entry point and symbols', async () => {
    const m = await metadataOf('macho', buildMachO());
    expect(m).toMatchObject({
      format: 'macho',
      kind: 'executable',
      architecture: 'x86_64',
      bits: 64,
      endianness: 'little',
    });
    expect(m.entryPoint).toBe('0x100000f00');
    expect(m.sections[0]?.name).toBe('__TEXT,__text');
    expect(m.symbols.map((s) => s.name)).toEqual(['_main']);
  });

  it('reads big-endian images', async () => {
    const m = await metadataOf('macho', buildMachO({ little: false, cpu: 0x01000012 }));
    expect(m).toMatchObject({ architecture: 'ppc64', endianness: 'big' });
  });

  it('splits universal binaries into one prepared file per slice', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'universal');
    await fs.writeFile(
      file,
      buildFatMachO([buildMachO(), buildMachO({ cpu: 0x0100000c })], [0x01000007, 0x0100000c]),
    );
    const prepared = await registry.get('macho')!.prepare(file, path.join(dir, 'out'));
    expect(prepared.map((p) => p.metadata.architecture).sort()).toEqual(['aarch64', 'x86_64']);
    for (const item of prepared) {
      expect((await fs.stat(item.path)).isFile()).toBe(true);
    }
  });
});

describe('COFF object metadata', () => {
  it('reads sections and defined function symbols', async () => {
    const m = await metadataOf('coff', buildCoffObject());
    expect(m).toMatchObject({ format: 'coff', kind: 'object', architecture: 'x86_64' });
    expect(m.sections[0]?.name).toBe('.text');
    expect(m.symbols[0]).toMatchObject({ name: 'func', type: 'function' });
  });
});

describe('raw binary adapter', () => {
  const raw = new RawBinaryAdapter();

  it('refuses to guess metadata and explains what is missing', async () => {
    await expect(raw.getMetadata('x.bin')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      hint: expect.stringContaining('--arch'),
    });
  });

  it('uses exactly the user-supplied facts and marks them as user-provided', async () => {
    const m = await raw.getMetadata('x.bin', {
      raw: {
        architecture: 'arm',
        bits: 32,
        endianness: 'little',
        baseAddress: '0x8000',
        entryPoint: '0x8000',
      },
    });
    expect(m).toMatchObject({
      format: 'raw',
      source: 'user',
      architecture: 'arm',
      baseAddress: '0x8000',
      sections: [],
      symbols: [],
    });
  });

  it('rejects malformed addresses', async () => {
    await expect(
      raw.getMetadata('x.bin', {
        raw: { architecture: 'arm', bits: 32, endianness: 'little', baseAddress: '8000' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
