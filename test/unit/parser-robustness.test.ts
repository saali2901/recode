import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RecodeError } from '../../src/core/errors/index.js';
import { createDefaultRegistry } from '../../src/input/adapters/registry.js';
import { defaultConfig } from '../../src/infrastructure/config/config.js';
import { BinaryMetadataSchema } from '../../src/input/interfaces/types.js';
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

/** Deterministic pseudo-random generator so failures are reproducible. */
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

async function samples(): Promise<Array<[string, Buffer]>> {
  return [
    ['elf', await fs.readFile(path.resolve('test/fixtures/build/sample-x86_64'))],
    ['elf-object', await fs.readFile(path.resolve('test/fixtures/build/sample.o'))],
    ['pe', buildPe({ bits: 64, exportName: 'f' })],
    ['pe32', buildPe({ bits: 32 })],
    ['macho', buildMachO()],
    [
      'fat',
      buildFatMachO([buildMachO(), buildMachO({ cpu: 0x0100000c })], [0x01000007, 0x0100000c]),
    ],
    ['coff', buildCoffObject()],
    ['zip', buildZip([{ name: 'a', data: Buffer.from('hello') }])],
  ];
}

/** Detection and metadata extraction must never crash on damaged input: only valid metadata or a RecodeError. */
async function exercise(data: Buffer, dir: string, index: number): Promise<void> {
  const file = path.join(dir, `f${index}.bin`);
  await fs.writeFile(file, data);
  const detection = await registry.detect(file);
  expect(detection.confidence).toBeGreaterThanOrEqual(0);
  for (const adapter of registry.list()) {
    if (adapter.id === 'zip' || adapter.id === 'raw') continue;
    try {
      const metadata = await adapter.getMetadata(file);
      expect(BinaryMetadataSchema.safeParse(metadata).success).toBe(true);
    } catch (error) {
      expect(
        error,
        `${adapter.id} threw a non-RecodeError for ${data.length} bytes`,
      ).toBeInstanceOf(RecodeError);
    }
  }
}

describe('parser robustness on damaged input', () => {
  it('survives truncation at many offsets', async () => {
    const dir = await makeTempDir();
    let index = 0;
    for (const [, data] of await samples()) {
      const step = Math.max(1, Math.floor(data.length / 40));
      for (let length = 0; length < data.length; length += step) {
        await exercise(data.subarray(0, length), dir, index++);
      }
    }
  });

  it('survives random byte corruption in the header area', async () => {
    const dir = await makeTempDir();
    const random = lcg(42);
    let index = 0;
    for (const [, data] of await samples()) {
      for (let round = 0; round < 60; round++) {
        const copy = Buffer.from(data);
        const flips = 1 + Math.floor(random() * 8);
        for (let i = 0; i < flips; i++) {
          const position = Math.floor(random() * Math.min(copy.length, 600));
          copy[position] = Math.floor(random() * 256);
        }
        await exercise(copy, dir, index++);
      }
    }
  });

  it('survives hostile huge counts and offsets', async () => {
    const dir = await makeTempDir();
    const elf = await fs.readFile(path.resolve('test/fixtures/build/sample-x86_64'));
    const hostile = Buffer.from(elf);
    hostile.writeUInt16LE(0xffff, 0x3c); // e_shnum
    hostile.writeBigUInt64LE(0xffffffffffffffffn, 0x28); // e_shoff
    await exercise(hostile, dir, 0);
    const pe = buildPe({ bits: 64 });
    pe.writeUInt16LE(0xffff, 0x46); // number of sections
    await exercise(pe, dir, 1);
  });
});
