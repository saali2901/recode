import type { FileView } from './binary-reader.js';
import type { Architecture, BinaryMetadata, BinarySymbol } from '../interfaces/types.js';
import { Cursor, MAX_SYMBOLS, TruncatedError, hex } from './binary-reader.js';

const COFF_MACHINES: Record<number, Architecture> = {
  0x14c: 'x86',
  0x8664: 'x86_64',
  0x1c0: 'arm',
  0x1c4: 'arm',
  0xaa64: 'aarch64',
};

/**
 * Cheap structural check for a COFF object file (".obj"); there is no magic number,
 * so machine type, section count and symbol table bounds are validated instead.
 */
export function looksLikeCoffObject(view: FileView): boolean {
  if (view.size < 20) return false;
  const h = new Cursor(view.read(0, 20), true);
  const machine = h.u16(0);
  const sections = h.u16(2);
  const symPtr = h.u32(8);
  const symCount = h.u32(12);
  const optional = h.u16(16);
  if (!(machine in COFF_MACHINES) || sections === 0 || sections > 96 || optional !== 0)
    return false;
  if (20 + sections * 40 > view.size) return false;
  if (symCount > 0 && symPtr + symCount * 18 > view.size) return false;
  return symCount === 0 || symPtr >= 20 + sections * 40;
}

/** Parses a COFF object file (sections and defined symbols). */
export function parseCoff(view: FileView): BinaryMetadata {
  if (!looksLikeCoffObject(view)) throw new TruncatedError('Not a COFF object');
  const h = new Cursor(view.read(0, 20), true);
  const machine = h.u16(0);
  const sectionCount = h.u16(2);
  const symPtr = h.u32(8);
  const symCount = h.u32(12);
  const table = new Cursor(view.read(20, sectionCount * 40), true);

  const sections = Array.from({ length: sectionCount }, (_, i) => {
    const o = i * 40;
    const flags = table.u32(o + 36);
    return {
      name: table.fixedString(o, 8),
      address: hex(0),
      size: hex(table.u32(o + 16)),
      fileOffset: hex(table.u32(o + 20)),
      permissions: `${flags & 0x40000000 ? 'r' : '-'}${flags & 0x80000000 ? 'w' : '-'}${flags & 0x20000000 ? 'x' : '-'}`,
    };
  });

  const symbols: BinarySymbol[] = [];
  let truncated = false;
  if (symCount > 0) {
    const symbolData = new Cursor(view.read(symPtr, symCount * 18), true);
    const stringTableOffset = symPtr + symCount * 18;
    const stringTable =
      stringTableOffset + 4 <= view.size
        ? new Cursor(view.read(stringTableOffset, view.size - stringTableOffset), true)
        : undefined;
    for (let i = 0; i < symCount;) {
      if (symbols.length >= MAX_SYMBOLS) {
        truncated = true;
        break;
      }
      const o = i * 18;
      const aux = symbolData.u8(o + 17);
      const section = symbolData.u16(o + 12);
      const storage = symbolData.u8(o + 16);
      let name: string;
      if (symbolData.u32(o) === 0 && stringTable) {
        name = stringTable.cString(symbolData.u32(o + 4));
      } else {
        name = symbolData.fixedString(o, 8);
      }
      if (section > 0 && section < 0xfff0 && (storage === 2 || storage === 3) && name !== '') {
        symbols.push({
          name,
          address: hex(symbolData.u32(o + 8)),
          type: symbolData.u16(o + 14) === 0x20 ? 'function' : 'object',
          binding: storage === 2 ? 'global' : 'local',
        });
      }
      i += 1 + aux;
    }
  }

  return {
    format: 'coff',
    kind: 'object',
    architecture: COFF_MACHINES[machine] ?? 'unknown',
    bits: machine === 0x14c || machine === 0x1c0 || machine === 0x1c4 ? 32 : 64,
    endianness: 'little',
    sections,
    segments: [],
    symbols,
    symbolsTruncated: truncated,
    source: 'headers',
    warnings: ['COFF object files have no load addresses; section addresses are relative (0x0).'],
  };
}
