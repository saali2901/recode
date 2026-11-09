import { MEM1_END, MEM1_START, type DolImage } from './dol.js';

/** Values of the small-data anchor registers as set by the startup code. */
export interface SmallDataBases {
  /** Base of `.sdata2`/`.sbss2` (read-only small data). */
  r2?: number;
  /** Base of `.sdata`/`.sbss` (read-write small data). */
  r13?: number;
}

const MAX_INSTRUCTIONS = 96;
const MAX_JUMPS = 3;
/** The startup code lies at the start of the entry section; this bounds how much of it is read. */
const MAX_SCAN_BYTES = 0x4000;

interface Tracked {
  /** Known register value, or undefined once the register was written by something we cannot evaluate. */
  value: number | undefined;
  /** True after a full load (high half then low half) was seen. */
  complete: boolean;
}

function signed16(value: number): number {
  return (value << 16) >> 16;
}

/**
 * Finds the values that the startup code loads into r2 and r13 (EABI small-data anchors). Compilers emit
 * `lis rX, hi` followed by `addi rX, rX, lo` or `ori rX, rX, lo`. The scan is deliberately narrow: it follows
 * at most a few unconditional jumps from the entry point, reads straight-line code, and reports a register
 * only if a complete load into an address of main memory was seen. Anything else yields no value.
 *
 * `code` holds the bytes of the text section that contains `entry`, starting at `codeAddress`.
 */
export function findSmallDataBases(
  code: Buffer,
  codeAddress: number,
  entry: number,
): SmallDataBases {
  const word = (address: number): number | undefined => {
    const offset = address - codeAddress;
    return offset >= 0 && offset + 4 <= code.length ? code.readUInt32BE(offset) : undefined;
  };

  const registers = new Map<number, Tracked>();
  const set = (reg: number, value: number | undefined, complete: boolean): void => {
    registers.set(reg, { value, complete });
  };

  let pc = entry;
  let jumps = 0;
  for (let step = 0; step < MAX_INSTRUCTIONS; step++) {
    const w = word(pc);
    if (w === undefined) break;
    const opcode = w >>> 26;
    const rt = (w >>> 21) & 31; // RT for addis/addi, RS for ori
    const ra = (w >>> 16) & 31;
    const imm = w & 0xffff;

    if (opcode === 15 && ra === 0) {
      // lis rT, imm
      set(rt, (imm << 16) >>> 0, false);
    } else if (opcode === 14) {
      // addi rT, rA, simm  (li when rA = 0)
      const base = ra === 0 ? 0 : registers.get(ra)?.value;
      const value = base === undefined ? undefined : (base + signed16(imm)) >>> 0;
      set(rt, value, value !== undefined);
    } else if (opcode === 24) {
      // ori rA, rS, uimm
      const source = registers.get(rt)?.value;
      set(ra, source === undefined ? undefined : (source | imm) >>> 0, source !== undefined);
    } else if (opcode === 18) {
      const link = (w & 1) !== 0;
      const absolute = (w & 2) !== 0;
      const displacement = ((w & 0x03ff_fffc) << 6) >> 6;
      if (!link) {
        // Unconditional jump: follow it a few times (crt0 often starts with "b _start"), otherwise stop.
        if (++jumps > MAX_JUMPS) break;
        pc = absolute ? displacement >>> 0 : (pc + displacement) >>> 0;
        continue;
      }
      // A call may clobber volatile registers but never r2/r13 in EABI; keep scanning behind it.
    } else if (w === 0x4e80_0020) {
      break; // blr
    }
    pc = (pc + 4) >>> 0;
  }

  const result: SmallDataBases = {};
  for (const [name, reg] of [
    ['r2', 2],
    ['r13', 13],
  ] as const) {
    const tracked = registers.get(reg);
    if (
      tracked?.complete &&
      tracked.value !== undefined &&
      tracked.value >= MEM1_START &&
      tracked.value < MEM1_END
    ) {
      result[name] = tracked.value;
    }
  }
  return result;
}

/** Reads the entry section of a DOL through `read(fileOffset, length)` and looks for the small-data anchors. */
export function dolSmallDataBases(
  image: DolImage,
  read: (fileOffset: number, length: number) => Buffer,
): SmallDataBases {
  const section = image.sections.find(
    (s) => s.kind === 'text' && image.entry >= s.address && image.entry < s.address + s.size,
  );
  if (!section) return {};
  const length = Math.min(section.size, MAX_SCAN_BYTES);
  return findSmallDataBases(read(section.fileOffset, length), section.address, image.entry);
}
