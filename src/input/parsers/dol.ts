import type { BinaryMetadata } from '../interfaces/types.js';
import { Cursor, hex, TruncatedError } from './binary-reader.js';

/**
 * Nintendo GameCube/Wii executable ("DOL"). The format has no magic number, so recognition rests on a
 * strict structural check of the 0x100-byte header (see `parseDol`).
 *
 * Layout (big-endian): 7 text + 11 data section slots; per slot a file offset (0x00), load address
 * (0x48) and size (0x90); then BSS address (0xD8), BSS size (0xDC) and entry point (0xE0).
 */
export const DOL_HEADER_SIZE = 0x100;
export const DOL_TEXT_SLOTS = 7;
export const DOL_DATA_SLOTS = 11;
const DOL_SLOTS = DOL_TEXT_SLOTS + DOL_DATA_SLOTS;

/** Main memory (MEM1) as seen through the cached mirror: 24 MiB at 0x80000000. */
export const MEM1_START = 0x8000_0000;
export const MEM1_END = 0x8180_0000;

export interface DolSection {
  name: string;
  kind: 'text' | 'data';
  slot: number;
  fileOffset: number;
  address: number;
  size: number;
}

export interface DolImage {
  sections: DolSection[];
  bss: { address: number; size: number } | undefined;
  entry: number;
  /** Total size of the file as implied by the header (end of the last section's data). */
  fileSize: number;
}

/** True if the header slot is completely unused. */
function slotUnused(offset: number, address: number, size: number): boolean {
  return offset === 0 && address === 0 && size === 0;
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Parses and strictly validates a DOL header. `available` is the number of bytes that exist from the start of
 * the DOL (the file size, or the remaining disc size for an embedded DOL).
 * Throws TruncatedError when the data cannot be a DOL.
 */
export function parseDol(header: Buffer, available: number): DolImage {
  if (header.length < DOL_HEADER_SIZE) throw new TruncatedError('DOL header is incomplete');
  const c = new Cursor(header, false);
  const sections: DolSection[] = [];

  for (let slot = 0; slot < DOL_SLOTS; slot++) {
    const fileOffset = c.u32(slot * 4);
    const address = c.u32(0x48 + slot * 4);
    const size = c.u32(0x90 + slot * 4);
    if (slotUnused(fileOffset, address, size)) continue;
    if (size === 0) throw new TruncatedError(`Section slot ${slot} has a size of zero`);
    if (fileOffset < DOL_HEADER_SIZE) {
      throw new TruncatedError(`Section slot ${slot} overlaps the header`);
    }
    if (fileOffset + size > available) {
      throw new TruncatedError(`Section slot ${slot} extends beyond the end of the file`);
    }
    if (address % 4 !== 0) throw new TruncatedError(`Section slot ${slot} is not word-aligned`);
    if (address < MEM1_START || address + size > MEM1_END) {
      throw new TruncatedError(`Section slot ${slot} lies outside of main memory`);
    }
    const kind = slot < DOL_TEXT_SLOTS ? 'text' : 'data';
    const index = kind === 'text' ? slot : slot - DOL_TEXT_SLOTS;
    sections.push({ name: `.${kind}${index}`, kind, slot, fileOffset, address, size });
  }

  if (!sections.some((s) => s.kind === 'text')) {
    throw new TruncatedError('DOL has no text section');
  }
  for (const [i, a] of sections.entries()) {
    for (const b of sections.slice(i + 1)) {
      if (overlaps(a.fileOffset, a.fileOffset + a.size, b.fileOffset, b.fileOffset + b.size)) {
        throw new TruncatedError(`Sections ${a.name} and ${b.name} overlap in the file`);
      }
      if (overlaps(a.address, a.address + a.size, b.address, b.address + b.size)) {
        throw new TruncatedError(`Sections ${a.name} and ${b.name} overlap in memory`);
      }
    }
  }

  const bssAddress = c.u32(0xd8);
  const bssSize = c.u32(0xdc);
  let bss: DolImage['bss'];
  if (bssSize > 0) {
    if (bssAddress % 4 !== 0 || bssAddress < MEM1_START || bssAddress + bssSize > MEM1_END) {
      throw new TruncatedError('BSS lies outside of main memory');
    }
    bss = { address: bssAddress, size: bssSize };
  }

  const entry = c.u32(0xe0);
  const inText = sections.some(
    (s) => s.kind === 'text' && entry >= s.address && entry < s.address + s.size,
  );
  if (entry % 4 !== 0 || !inText) {
    throw new TruncatedError('Entry point is not inside a text section');
  }

  const fileSize = Math.max(...sections.map((s) => s.fileOffset + s.size));
  return { sections, bss, entry, fileSize };
}

export function dolPermissions(kind: DolSection['kind']): string {
  return kind === 'text' ? 'r-x' : 'rw-';
}

/** Converts a validated DOL into the format-independent metadata used by the rest of ReCode. */
export function dolMetadata(
  image: DolImage,
  extra: {
    game?: BinaryMetadata['game'];
    registers?: { r2?: number; r13?: number };
  } = {},
): BinaryMetadata {
  const sections: BinaryMetadata['sections'] = image.sections.map((s) => ({
    name: s.name,
    address: hex(s.address),
    size: hex(s.size),
    fileOffset: hex(s.fileOffset),
    permissions: dolPermissions(s.kind),
  }));
  if (image.bss) {
    sections.push({
      name: '.bss',
      address: hex(image.bss.address),
      size: hex(image.bss.size),
      permissions: 'rw-',
    });
  }
  const lowest = Math.min(...image.sections.map((s) => s.address));
  return {
    format: 'dol',
    kind: 'executable',
    architecture: 'ppc',
    bits: 32,
    endianness: 'big',
    entryPoint: hex(image.entry),
    baseAddress: hex(lowest),
    sections,
    segments: image.sections.map((s) => ({
      name: s.name,
      address: hex(s.address),
      size: hex(s.size),
      fileOffset: hex(s.fileOffset),
      fileSize: hex(s.size),
      permissions: dolPermissions(s.kind),
    })),
    symbols: [],
    symbolsTruncated: false,
    platform: 'gamecube',
    ...(extra.game ? { game: extra.game } : {}),
    ...(extra.registers && Object.keys(extra.registers).length > 0
      ? {
          initialRegisters: Object.fromEntries(
            Object.entries(extra.registers).map(([name, value]) => [name, hex(value)]),
          ),
        }
      : {}),
    source: 'headers',
    warnings: [
      'DOL files carry no symbols; names come from Ghidra analysis only. Wii DOLs that use MEM2 (0x90000000) are not supported.',
    ],
  };
}
