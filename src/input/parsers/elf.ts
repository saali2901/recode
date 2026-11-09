import type { FileView } from './binary-reader.js';
import type {
  Architecture,
  BinaryKind,
  BinaryMetadata,
  BinarySymbol,
} from '../interfaces/types.js';
import { Cursor, MAX_SYMBOLS, TruncatedError, hex, toSafeNumber } from './binary-reader.js';

const ELF_MACHINES: Record<number, (bits: 32 | 64) => Architecture> = {
  3: () => 'x86',
  62: () => 'x86_64',
  40: () => 'arm',
  183: () => 'aarch64',
  8: (bits) => (bits === 64 ? 'mips64' : 'mips'),
  20: () => 'ppc',
  21: () => 'ppc64',
  243: (bits) => (bits === 64 ? 'riscv64' : 'riscv32'),
};

export function isElfMagic(head: Buffer): boolean {
  return head.length >= 4 && head.readUInt32BE(0) === 0x7f454c46;
}

function permissions(flags: number, bits: { r: number; w: number; x: number }): string {
  return `${flags & bits.r ? 'r' : '-'}${flags & bits.w ? 'w' : '-'}${flags & bits.x ? 'x' : '-'}`;
}

/** Parses an ELF file's headers, sections, segments and symbol tables. */
export function parseElf(view: FileView): BinaryMetadata {
  const ident = view.read(0, 16);
  if (!isElfMagic(ident)) throw new TruncatedError('Not an ELF file');
  const bits: 32 | 64 = ident[4] === 2 ? 64 : 32;
  if (ident[4] !== 1 && ident[4] !== 2) throw new TruncatedError('Invalid ELF class');
  if (ident[5] !== 1 && ident[5] !== 2) throw new TruncatedError('Invalid ELF data encoding');
  const little = ident[5] === 1;
  const wordBytes = bits === 64 ? 8 : 4;
  const headerSize = bits === 64 ? 64 : 52;
  const header = new Cursor(view.read(0, headerSize), little);

  const type = header.u16(16);
  const machine = header.u16(18);
  const entry = header.word(24, wordBytes);
  const phoff = toSafeNumber(header.word(24 + wordBytes, wordBytes));
  const shoff = toSafeNumber(header.word(24 + 2 * wordBytes, wordBytes));
  const base = 24 + 3 * wordBytes + 4 + 2; // after flags and ehsize
  const phentsize = header.u16(base);
  const phnum = header.u16(base + 2);
  const shentsize = header.u16(base + 4);
  const shnum = header.u16(base + 6);
  const shstrndx = header.u16(base + 8);

  const warnings: string[] = [];
  const architecture = ELF_MACHINES[machine]?.(bits) ?? 'unknown';
  if (architecture === 'unknown') warnings.push(`Unknown ELF machine ${machine}`);

  const segments = readProgramHeaders(view, { phoff, phentsize, phnum, bits, little });
  const hasInterp = segments.hasInterp;
  const sectionsInfo = readSectionHeaders(view, {
    shoff,
    shentsize,
    shnum,
    shstrndx,
    bits,
    little,
  });

  const symbols: BinarySymbol[] = [];
  let truncated = false;
  for (const table of sectionsInfo.headers.filter((s) => s.type === 2 || s.type === 11)) {
    const strtab = sectionsInfo.headers[table.link];
    if (!strtab || table.entsize === 0) continue;
    const count = Math.floor(table.size / table.entsize);
    const names = new Cursor(view.read(strtab.offset, strtab.size), little);
    const data = new Cursor(view.read(table.offset, count * table.entsize), little);
    for (let i = 1; i < count; i++) {
      if (symbols.length >= MAX_SYMBOLS) {
        truncated = true;
        break;
      }
      const symbol = readElfSymbol(data, i * table.entsize, bits, names);
      if (symbol) symbols.push(symbol);
    }
  }

  let kind: BinaryKind = 'other';
  if (type === 1) kind = 'object';
  else if (type === 2) kind = 'executable';
  else if (type === 3) kind = hasInterp ? 'executable' : 'shared-library';

  const loadSegments = segments.list.filter((s) => s.loadable);
  const lowest = loadSegments.reduce<bigint | undefined>(
    (min, s) => (min === undefined || s.vaddr < min ? s.vaddr : min),
    undefined,
  );

  return {
    format: 'elf',
    kind,
    architecture,
    bits,
    endianness: little ? 'little' : 'big',
    entryPoint: type === 1 ? undefined : hex(entry),
    baseAddress: lowest === undefined ? undefined : hex(lowest),
    sections: sectionsInfo.headers
      .filter((s) => s.name !== '' && s.type !== 0)
      .map((s) => ({
        name: s.name,
        address: hex(s.addr),
        size: hex(s.size),
        fileOffset: hex(s.offset),
        permissions: s.flags & 2 ? permissions(s.flags, { r: 2, w: 1, x: 4 }) : undefined,
      })),
    segments: segments.list.map((s) => ({
      address: hex(s.vaddr),
      size: hex(s.memsz),
      fileOffset: hex(s.offset),
      fileSize: hex(s.filesz),
      permissions: permissions(s.flags, { r: 4, w: 2, x: 1 }),
    })),
    symbols,
    symbolsTruncated: truncated,
    source: 'headers',
    warnings,
  };
}

interface SegmentInfo {
  vaddr: bigint;
  memsz: bigint;
  offset: number;
  filesz: bigint;
  flags: number;
  loadable: boolean;
}

function readProgramHeaders(
  view: FileView,
  p: { phoff: number; phentsize: number; phnum: number; bits: 32 | 64; little: boolean },
): { list: SegmentInfo[]; hasInterp: boolean } {
  const list: SegmentInfo[] = [];
  let hasInterp = false;
  if (p.phoff === 0 || p.phnum === 0) return { list, hasInterp };
  const minSize = p.bits === 64 ? 56 : 32;
  if (p.phentsize < minSize) throw new TruncatedError('Invalid program header size');
  const cursor = new Cursor(view.read(p.phoff, p.phnum * p.phentsize), p.little);
  for (let i = 0; i < p.phnum; i++) {
    const o = i * p.phentsize;
    const type = cursor.u32(o);
    if (type === 3) hasInterp = true;
    if (type !== 1 && type !== 2 && type !== 3 && type !== 7) continue; // LOAD, DYNAMIC, INTERP, TLS
    if (p.bits === 64) {
      list.push({
        vaddr: cursor.u64(o + 16),
        memsz: cursor.u64(o + 40),
        offset: toSafeNumber(cursor.u64(o + 8)),
        filesz: cursor.u64(o + 32),
        flags: cursor.u32(o + 4),
        loadable: type === 1,
      });
    } else {
      list.push({
        vaddr: BigInt(cursor.u32(o + 8)),
        memsz: BigInt(cursor.u32(o + 20)),
        offset: cursor.u32(o + 4),
        filesz: BigInt(cursor.u32(o + 16)),
        flags: cursor.u32(o + 24),
        loadable: type === 1,
      });
    }
  }
  return { list, hasInterp };
}

interface SectionHeader {
  name: string;
  type: number;
  flags: number;
  addr: bigint;
  offset: number;
  size: number;
  link: number;
  entsize: number;
}

function readSectionHeaders(
  view: FileView,
  p: {
    shoff: number;
    shentsize: number;
    shnum: number;
    shstrndx: number;
    bits: 32 | 64;
    little: boolean;
  },
): { headers: SectionHeader[] } {
  if (p.shoff === 0 || p.shnum === 0) return { headers: [] };
  const minSize = p.bits === 64 ? 64 : 40;
  if (p.shentsize < minSize) throw new TruncatedError('Invalid section header size');
  const wordBytes = p.bits === 64 ? 8 : 4;
  const cursor = new Cursor(view.read(p.shoff, p.shnum * p.shentsize), p.little);
  const raw = Array.from({ length: p.shnum }, (_, i) => {
    const o = i * p.shentsize;
    return {
      nameOffset: cursor.u32(o),
      type: cursor.u32(o + 4),
      flags: Number(cursor.word(o + 8, wordBytes) & 0xffffffffn),
      addr: cursor.word(o + 8 + wordBytes, wordBytes),
      offset: toSafeNumber(cursor.word(o + 8 + 2 * wordBytes, wordBytes)),
      size: toSafeNumber(cursor.word(o + 8 + 3 * wordBytes, wordBytes)),
      link: cursor.u32(o + 8 + 4 * wordBytes),
      entsize: toSafeNumber(cursor.word(o + 8 + 4 * wordBytes + 8 + wordBytes, wordBytes)),
    };
  });
  const strSection = raw[p.shstrndx];
  const strings =
    strSection && strSection.type !== 8 /* NOBITS */
      ? new Cursor(view.read(strSection.offset, strSection.size), p.little)
      : undefined;
  return {
    headers: raw.map((s) => ({
      name: strings?.cString(s.nameOffset) ?? '',
      type: s.type,
      flags: s.flags,
      addr: s.addr,
      offset: s.offset,
      size: s.type === 8 ? 0 : s.size,
      link: s.link,
      entsize: s.entsize,
    })),
  };
}

function readElfSymbol(
  data: Cursor,
  offset: number,
  bits: 32 | 64,
  names: Cursor,
): BinarySymbol | undefined {
  const nameOffset = data.u32(offset);
  const info = bits === 64 ? data.u8(offset + 4) : data.u8(offset + 12);
  const shndx = bits === 64 ? data.u16(offset + 6) : data.u16(offset + 14);
  const value = bits === 64 ? data.u64(offset + 8) : BigInt(data.u32(offset + 4));
  const size = bits === 64 ? data.u64(offset + 16) : BigInt(data.u32(offset + 8));
  const typeCode = info & 0xf;
  if (typeCode === 3 || typeCode === 4) return undefined; // SECTION, FILE
  const name = names.cString(nameOffset);
  if (name === '' || shndx === 0) return undefined; // unnamed or undefined (imports)
  const bind = info >> 4;
  return {
    name,
    address: hex(value),
    size: hex(size),
    type: typeCode === 2 ? 'function' : typeCode === 1 ? 'object' : 'other',
    binding: bind === 0 ? 'local' : bind === 2 ? 'weak' : 'global',
  };
}
