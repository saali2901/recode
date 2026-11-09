import type { FileView } from './binary-reader.js';
import type {
  Architecture,
  BinaryKind,
  BinaryMetadata,
  BinarySymbol,
} from '../interfaces/types.js';
import { Cursor, MAX_SYMBOLS, TruncatedError, hex } from './binary-reader.js';

const FAT_MAGIC = 0xcafebabe;
const MACHO_MAGICS = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe]);

const CPU_TYPES: Record<number, Architecture> = {
  7: 'x86',
  0x01000007: 'x86_64',
  12: 'arm',
  0x0100000c: 'aarch64',
  18: 'ppc',
  0x01000012: 'ppc64',
};

const FILE_TYPES: Record<number, BinaryKind> = {
  1: 'object',
  2: 'executable',
  6: 'shared-library',
  8: 'shared-library',
};

export function isMachOMagic(head: Buffer): boolean {
  return head.length >= 4 && MACHO_MAGICS.has(head.readUInt32BE(0));
}

/** Detects a fat (universal) container; guards against Java class files sharing the magic. */
export function isFatMagic(head: Buffer, fileSize: number): boolean {
  if (head.length < 8 || head.readUInt32BE(0) !== FAT_MAGIC) return false;
  const count = head.readUInt32BE(4);
  return count >= 1 && count <= 16 && 8 + count * 20 <= fileSize;
}

export interface FatSlice {
  architecture: Architecture;
  offset: number;
  size: number;
}

/** Lists the slices of a universal binary. */
export function readFatSlices(view: FileView): FatSlice[] {
  const header = new Cursor(view.read(0, 8), false);
  const count = header.u32(4);
  const table = new Cursor(view.read(8, count * 20), false);
  return Array.from({ length: count }, (_, i) => {
    const o = i * 20;
    const offset = table.u32(o + 8);
    const size = table.u32(o + 12);
    if (offset + size > view.size) throw new TruncatedError('Fat slice exceeds file size');
    return { architecture: CPU_TYPES[table.u32(o)] ?? 'unknown', offset, size };
  });
}

/** Parses a thin Mach-O image starting at `base` within the file. */
export function parseMachO(view: FileView, base = 0, length = view.size - base): BinaryMetadata {
  const magicBytes = view.read(base, 4);
  const magic = magicBytes.readUInt32BE(0);
  if (!MACHO_MAGICS.has(magic)) throw new TruncatedError('Not a Mach-O image');
  const bits: 32 | 64 = magic === 0xfeedfacf || magic === 0xcffaedfe ? 64 : 32;
  const little = magic === 0xcefaedfe || magic === 0xcffaedfe;
  const headerSize = bits === 64 ? 32 : 28;
  const header = new Cursor(view.read(base, headerSize), little);
  const cpuType = header.u32(4);
  const fileType = header.u32(12);
  const commandCount = header.u32(16);
  const commandsSize = header.u32(20);
  if (commandsSize > length) throw new TruncatedError('Load commands exceed image size');

  const warnings: string[] = [];
  const architecture = CPU_TYPES[cpuType] ?? 'unknown';
  if (architecture === 'unknown')
    warnings.push(`Unknown Mach-O cpu type 0x${cpuType.toString(16)}`);

  const commands = new Cursor(view.read(base + headerSize, commandsSize), little);
  const sections: BinaryMetadata['sections'] = [];
  const segments: BinaryMetadata['segments'] = [];
  const symbols: BinarySymbol[] = [];
  let truncated = false;
  let textVmaddr: bigint | undefined;
  let entryOffset: bigint | undefined;
  let lowestVmaddr: bigint | undefined;

  let offset = 0;
  for (let i = 0; i < commandCount; i++) {
    const cmd = commands.u32(offset) & 0x7fffffff;
    const cmdSize = commands.u32(offset + 4);
    if (cmdSize < 8 || offset + cmdSize > commandsSize)
      throw new TruncatedError('Bad load command');
    if (cmd === 0x1 || cmd === 0x19) {
      const wide = cmd === 0x19;
      const wb = wide ? 8 : 4;
      const name = commands.fixedString(offset + 8, 16);
      const vmaddr = commands.word(offset + 24, wb);
      const vmsize = commands.word(offset + 24 + wb, wb);
      const fileoff = commands.word(offset + 24 + 2 * wb, wb);
      const filesize = commands.word(offset + 24 + 3 * wb, wb);
      const initprot = commands.u32(offset + 24 + 4 * wb + 4);
      const nsects = commands.u32(offset + 24 + 4 * wb + 8);
      if (name === '__TEXT') textVmaddr = vmaddr;
      if (name !== '__PAGEZERO' && (lowestVmaddr === undefined || vmaddr < lowestVmaddr)) {
        lowestVmaddr = vmaddr;
      }
      segments.push({
        name,
        address: hex(vmaddr),
        size: hex(vmsize),
        fileOffset: hex(fileoff),
        fileSize: hex(filesize),
        permissions: `${initprot & 1 ? 'r' : '-'}${initprot & 2 ? 'w' : '-'}${initprot & 4 ? 'x' : '-'}`,
      });
      const sectSize = wide ? 80 : 68;
      let sectOffset = offset + 24 + 4 * wb + 16;
      for (let s = 0; s < nsects && sectOffset + sectSize <= offset + cmdSize; s++) {
        sections.push({
          name: `${commands.fixedString(sectOffset + 16, 16)},${commands.fixedString(sectOffset, 16)}`,
          address: hex(commands.word(sectOffset + 32, wb)),
          size: hex(commands.word(sectOffset + 32 + wb, wb)),
          fileOffset: hex(commands.u32(sectOffset + 32 + 2 * wb)),
        });
        sectOffset += sectSize;
      }
    } else if (cmd === 0x28) {
      entryOffset = commands.u64(offset + 8);
    } else if (cmd === 0x2) {
      const symoff = commands.u32(offset + 8);
      const nsyms = commands.u32(offset + 12);
      const stroff = commands.u32(offset + 16);
      const strsize = commands.u32(offset + 20);
      const result = readSymbols(view, {
        base,
        length,
        symoff,
        nsyms,
        stroff,
        strsize,
        bits,
        little,
      });
      symbols.push(...result.symbols);
      truncated = result.truncated;
    }
    offset += cmdSize;
  }

  return {
    format: 'macho',
    kind: FILE_TYPES[fileType] ?? 'other',
    architecture,
    bits,
    endianness: little ? 'little' : 'big',
    entryPoint:
      entryOffset !== undefined && textVmaddr !== undefined
        ? hex(textVmaddr + entryOffset)
        : undefined,
    baseAddress: lowestVmaddr === undefined ? undefined : hex(lowestVmaddr),
    sections,
    segments,
    symbols,
    symbolsTruncated: truncated,
    source: 'headers',
    warnings,
  };
}

function readSymbols(
  view: FileView,
  p: {
    base: number;
    length: number;
    symoff: number;
    nsyms: number;
    stroff: number;
    strsize: number;
    bits: 32 | 64;
    little: boolean;
  },
): { symbols: BinarySymbol[]; truncated: boolean } {
  const entry = p.bits === 64 ? 16 : 12;
  const count = Math.min(p.nsyms, MAX_SYMBOLS);
  if (p.symoff + p.nsyms * entry > p.length || p.stroff + p.strsize > p.length) {
    throw new TruncatedError('Symbol table exceeds image');
  }
  const names = new Cursor(view.read(p.base + p.stroff, p.strsize), p.little);
  const table = new Cursor(view.read(p.base + p.symoff, count * entry), p.little);
  const symbols: BinarySymbol[] = [];
  for (let i = 0; i < count; i++) {
    const o = i * entry;
    const type = table.u8(o + 4);
    if (type & 0xe0 || (type & 0x0e) !== 0x0e) continue; // debug or non-section symbols
    const name = names.cString(table.u32(o));
    if (name === '') continue;
    symbols.push({
      name,
      address: hex(p.bits === 64 ? table.u64(o + 8) : BigInt(table.u32(o + 8))),
      type: 'other',
      binding: type & 1 ? 'global' : 'local',
    });
  }
  return { symbols, truncated: p.nsyms > count };
}
