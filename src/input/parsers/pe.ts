import type { FileView } from './binary-reader.js';
import type { Architecture, BinaryMetadata, BinarySymbol } from '../interfaces/types.js';
import { Cursor, MAX_SYMBOLS, TruncatedError, hex } from './binary-reader.js';

const PE_MACHINES: Record<number, Architecture> = {
  0x14c: 'x86',
  0x8664: 'x86_64',
  0x1c0: 'arm',
  0x1c4: 'arm',
  0xaa64: 'aarch64',
  0x166: 'mips',
  0x1f1: 'ppc',
  0x5032: 'riscv32',
  0x5064: 'riscv64',
};

export function isMzMagic(head: Buffer): boolean {
  return head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a;
}

function sectionPermissions(characteristics: number): string {
  return `${characteristics & 0x40000000 ? 'r' : '-'}${characteristics & 0x80000000 ? 'w' : '-'}${characteristics & 0x20000000 ? 'x' : '-'}`;
}

interface PeSection {
  name: string;
  virtualSize: number;
  virtualAddress: number;
  rawSize: number;
  rawPointer: number;
  characteristics: number;
}

/** Parses a PE (EXE/DLL) file: headers, sections and the export table. */
export function parsePe(view: FileView): BinaryMetadata {
  const dos = new Cursor(view.read(0, 64), true);
  if (!isMzMagic(dos.buffer)) throw new TruncatedError('Missing MZ signature');
  const peOffset = dos.u32(0x3c);
  const coff = new Cursor(view.read(peOffset, 24), true);
  if (coff.u32(0) !== 0x00004550) throw new TruncatedError('Missing PE signature');

  const machine = coff.u16(4);
  const sectionCount = coff.u16(6);
  const optionalSize = coff.u16(20);
  const characteristics = coff.u16(22);
  if (optionalSize < 96) throw new TruncatedError('Optional header too small');

  const optional = new Cursor(view.read(peOffset + 24, optionalSize), true);
  const magic = optional.u16(0);
  if (magic !== 0x10b && magic !== 0x20b) throw new TruncatedError('Unknown optional header magic');
  const bits: 32 | 64 = magic === 0x20b ? 64 : 32;
  const entryRva = optional.u32(16);
  const imageBase = bits === 64 ? optional.u64(24) : BigInt(optional.u32(28));
  const dirBase = bits === 64 ? 112 : 96;
  const dirCount = optional.u32(dirBase - 4);

  const sectionTable = new Cursor(view.read(peOffset + 24 + optionalSize, sectionCount * 40), true);
  const sections: PeSection[] = Array.from({ length: sectionCount }, (_, i) => {
    const o = i * 40;
    return {
      name: sectionTable.fixedString(o, 8),
      virtualSize: sectionTable.u32(o + 8),
      virtualAddress: sectionTable.u32(o + 12),
      rawSize: sectionTable.u32(o + 16),
      rawPointer: sectionTable.u32(o + 20),
      characteristics: sectionTable.u32(o + 36),
    };
  });

  const warnings: string[] = [];
  const architecture = PE_MACHINES[machine] ?? 'unknown';
  if (architecture === 'unknown') warnings.push(`Unknown PE machine 0x${machine.toString(16)}`);

  const rvaToOffset = (rva: number): number | undefined => {
    for (const s of sections) {
      const span = Math.max(s.virtualSize, s.rawSize);
      if (rva >= s.virtualAddress && rva < s.virtualAddress + span) {
        return s.rawPointer + (rva - s.virtualAddress);
      }
    }
    return undefined;
  };

  let symbols: BinarySymbol[] = [];
  let truncated = false;
  if (dirCount > 0 && optionalSize >= dirBase + 8) {
    try {
      const result = readExports(
        view,
        optional.u32(dirBase),
        optional.u32(dirBase + 4),
        rvaToOffset,
        imageBase,
      );
      symbols = result.symbols;
      truncated = result.truncated;
    } catch (error) {
      if (!(error instanceof TruncatedError)) throw error;
      warnings.push('Export table is malformed and was ignored.');
    }
  }

  return {
    format: 'pe',
    kind: characteristics & 0x2000 ? 'shared-library' : 'executable',
    architecture,
    bits,
    endianness: 'little',
    entryPoint: entryRva === 0 ? undefined : hex(imageBase + BigInt(entryRva)),
    baseAddress: hex(imageBase),
    sections: sections.map((s) => ({
      name: s.name,
      address: hex(imageBase + BigInt(s.virtualAddress)),
      size: hex(s.virtualSize),
      fileOffset: hex(s.rawPointer),
      permissions: sectionPermissions(s.characteristics),
    })),
    segments: [],
    symbols,
    symbolsTruncated: truncated,
    source: 'headers',
    warnings,
  };
}

function readExports(
  view: FileView,
  rva: number,
  size: number,
  rvaToOffset: (rva: number) => number | undefined,
  imageBase: bigint,
): { symbols: BinarySymbol[]; truncated: boolean } {
  if (rva === 0 || size === 0) return { symbols: [], truncated: false };
  const dirOffset = rvaToOffset(rva);
  if (dirOffset === undefined) throw new TruncatedError('Export directory outside sections');
  const dir = new Cursor(view.read(dirOffset, 40), true);
  const nameCount = dir.u32(24);
  const functionsRva = dir.u32(28);
  const namesRva = dir.u32(32);
  const ordinalsRva = dir.u32(36);
  const functionsOffset = rvaToOffset(functionsRva);
  const namesOffset = rvaToOffset(namesRva);
  const ordinalsOffset = rvaToOffset(ordinalsRva);
  if (functionsOffset === undefined || namesOffset === undefined || ordinalsOffset === undefined) {
    throw new TruncatedError('Export arrays outside sections');
  }
  const count = Math.min(nameCount, MAX_SYMBOLS);
  const names = new Cursor(view.read(namesOffset, count * 4), true);
  const ordinals = new Cursor(view.read(ordinalsOffset, count * 2), true);
  const symbols: BinarySymbol[] = [];
  for (let i = 0; i < count; i++) {
    const nameOffset = rvaToOffset(names.u32(i * 4));
    if (nameOffset === undefined) continue;
    const name = readCString(view, nameOffset);
    const ordinal = ordinals.u16(i * 2);
    const fnRva = new Cursor(view.read(functionsOffset + ordinal * 4, 4), true).u32(0);
    symbols.push({
      name,
      address: hex(imageBase + BigInt(fnRva)),
      type: 'function',
      binding: 'global',
    });
  }
  return { symbols, truncated: nameCount > count };
}

function readCString(view: FileView, offset: number): string {
  const chunk = view.read(offset, Math.min(256, view.size - offset));
  const end = chunk.indexOf(0);
  return chunk.toString('utf8', 0, end < 0 ? chunk.length : end);
}
