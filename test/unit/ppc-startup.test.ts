import { describe, expect, it } from 'vitest';
import { findSmallDataBases } from '../../src/input/parsers/ppc-startup.js';

const lis = (reg: number, imm: number): number => (15 << 26) | (reg << 21) | imm;
const addi = (rt: number, ra: number, imm: number): number =>
  (14 << 26) | (rt << 21) | (ra << 16) | (imm & 0xffff);
const ori = (ra: number, rs: number, imm: number): number =>
  (24 << 26) | (rs << 21) | (ra << 16) | imm;
const branch = (displacement: number, link = false): number =>
  (18 << 26) | (displacement & 0x03ff_fffc) | (link ? 1 : 0);
const BLR = 0x4e80_0020;
const NOP = 0x6000_0000;

function code(words: number[]): Buffer {
  const buffer = Buffer.alloc(words.length * 4);
  words.forEach((w, i) => buffer.writeUInt32BE(w >>> 0, i * 4));
  return buffer;
}

const BASE = 0x8000_3100;

describe('small-data anchor detection', () => {
  it('reads lis/ori pairs, following the leading jump and skipping calls (pattern of a real devkitPPC DOL)', () => {
    // 0x00: b +0x20   0x20: bl ...; lis r2,0x8001; ori r2,r2,0xcfd8; lis r13,0x8002; ori r13,r13,0x2a0c
    const words = new Array<number>(0x80 / 4).fill(NOP);
    words[0] = branch(0x20);
    words[8] = branch(0x338, true);
    words[9] = lis(2, 0x8001);
    words[10] = ori(2, 2, 0xcfd8);
    words[11] = lis(13, 0x8002);
    words[12] = ori(13, 13, 0x2a0c);
    expect(findSmallDataBases(code(words), BASE, BASE)).toEqual({
      r2: 0x8001_cfd8,
      r13: 0x8002_2a0c,
    });
  });

  it('understands addi with a signed low half (the usual @ha/@l pair)', () => {
    const words = [lis(13, 0x8002), addi(13, 13, -0x7000), BLR];
    expect(findSmallDataBases(code(words), BASE, BASE)).toEqual({ r13: 0x8001_9000 });
  });

  it('reports nothing for a half-finished load, an unknown overwrite or out-of-memory values', () => {
    expect(findSmallDataBases(code([lis(13, 0x8002), BLR]), BASE, BASE)).toEqual({});
    expect(findSmallDataBases(code([lis(13, 0x1234), ori(13, 13, 0x10), BLR]), BASE, BASE)).toEqual(
      {},
    );
    // r13 is first loaded, then overwritten by an instruction the scanner does not evaluate (mr via ori from r5)
    const overwritten = [lis(13, 0x8002), ori(13, 13, 4), ori(13, 5, 0), BLR];
    expect(findSmallDataBases(code(overwritten), BASE, BASE)).toEqual({});
  });

  it('stops at blr and never runs off the end of the buffer or loops forever', () => {
    expect(findSmallDataBases(code([BLR, lis(13, 0x8002), ori(13, 13, 4)]), BASE, BASE)).toEqual(
      {},
    );
    expect(findSmallDataBases(code([branch(0)]), BASE, BASE)).toEqual({}); // jump to itself
    expect(findSmallDataBases(Buffer.alloc(2), BASE, BASE)).toEqual({});
    expect(findSmallDataBases(code([NOP]), BASE, 0x9000_0000)).toEqual({});
  });
});
