import { crc32, deflateRawSync } from 'node:zlib';

/** Builders for minimal, valid binaries used in parser tests (no external toolchain needed). */

export function buildPe(options: {
  bits?: 32 | 64;
  dll?: boolean;
  machine?: number;
  imageBase?: bigint;
  entryRva?: number;
  exportName?: string;
}): Buffer {
  const bits = options.bits ?? 64;
  const optionalSize = bits === 64 ? 240 : 224;
  const sectionCount = options.exportName ? 2 : 1;
  const buf = Buffer.alloc(0x800);
  buf.write('MZ', 0, 'latin1');
  buf.writeUInt32LE(0x40, 0x3c);
  buf.write('PE\0\0', 0x40, 'latin1');
  const coff = 0x44;
  buf.writeUInt16LE(options.machine ?? (bits === 64 ? 0x8664 : 0x14c), coff);
  buf.writeUInt16LE(sectionCount, coff + 2);
  buf.writeUInt16LE(optionalSize, coff + 16);
  buf.writeUInt16LE((options.dll ? 0x2000 : 0) | 0x0002, coff + 18);
  const opt = 0x40 + 24;
  buf.writeUInt16LE(bits === 64 ? 0x20b : 0x10b, opt);
  buf.writeUInt32LE(options.entryRva ?? 0x1000, opt + 16);
  const imageBase = options.imageBase ?? (bits === 64 ? 0x140000000n : 0x400000n);
  if (bits === 64) buf.writeBigUInt64LE(imageBase, opt + 24);
  else buf.writeUInt32LE(Number(imageBase), opt + 28);
  const dirBase = opt + (bits === 64 ? 112 : 96);
  buf.writeUInt32LE(16, dirBase - 4);

  const sections = opt + optionalSize;
  buf.write('.text', sections, 'latin1');
  buf.writeUInt32LE(0x100, sections + 8);
  buf.writeUInt32LE(0x1000, sections + 12);
  buf.writeUInt32LE(0x200, sections + 16);
  buf.writeUInt32LE(0x200, sections + 20);
  buf.writeUInt32LE(0x60000020, sections + 36);

  if (options.exportName) {
    const s2 = sections + 40;
    buf.write('.edata', s2, 'latin1');
    buf.writeUInt32LE(0x100, s2 + 8);
    buf.writeUInt32LE(0x2000, s2 + 12);
    buf.writeUInt32LE(0x200, s2 + 16);
    buf.writeUInt32LE(0x400, s2 + 20);
    buf.writeUInt32LE(0x40000040, s2 + 36);
    // export directory at file offset 0x400 (RVA 0x2000)
    const dir = 0x400;
    buf.writeUInt32LE(1, dir + 20); // number of functions
    buf.writeUInt32LE(1, dir + 24); // number of names
    buf.writeUInt32LE(0x2040, dir + 28); // functions RVA
    buf.writeUInt32LE(0x2050, dir + 32); // names RVA
    buf.writeUInt32LE(0x2060, dir + 36); // ordinals RVA
    buf.writeUInt32LE(0x1010, dir + 0x40); // function RVA
    buf.writeUInt32LE(0x2070, dir + 0x50); // name RVA
    buf.writeUInt16LE(0, dir + 0x60);
    buf.write(`${options.exportName}\0`, dir + 0x70, 'latin1');
    buf.writeUInt32LE(0x2000, dirBase); // export table RVA
    buf.writeUInt32LE(0x100, dirBase + 4);
  }
  return buf;
}

export function buildMachO(
  options: { cpu?: number; fileType?: number; little?: boolean; withMain?: boolean } = {},
): Buffer {
  const little = options.little ?? true;
  const buf = Buffer.alloc(0x1000);
  const w32 = (v: number, o: number): void => {
    if (little) buf.writeUInt32LE(v, o);
    else buf.writeUInt32BE(v, o);
  };
  const w64 = (v: bigint, o: number): void => {
    if (little) buf.writeBigUInt64LE(v, o);
    else buf.writeBigUInt64BE(v, o);
  };
  buf.writeUInt32BE(little ? 0xcffaedfe : 0xfeedfacf, 0);
  w32(options.cpu ?? 0x01000007, 4);
  w32(options.fileType ?? 2, 12);
  const commands = options.withMain === false ? 2 : 3;
  w32(commands, 16);
  let o = 32;
  // LC_SEGMENT_64 __TEXT with one section
  const segSize = 72 + 80;
  w32(0x19, o);
  w32(segSize, o + 4);
  buf.write('__TEXT', o + 8, 'latin1');
  w64(0x100000000n, o + 24);
  w64(0x1000n, o + 32);
  w64(0n, o + 40);
  w64(0x1000n, o + 48);
  w32(5, o + 60); // initprot r-x
  w32(1, o + 64); // nsects
  const sect = o + 72;
  buf.write('__text', sect, 'latin1');
  buf.write('__TEXT', sect + 16, 'latin1');
  w64(0x100000f00n, sect + 32);
  w64(0x20n, sect + 40);
  w32(0xf00, sect + 48);
  o += segSize;
  // LC_SYMTAB
  w32(0x2, o);
  w32(24, o + 4);
  w32(0x800, o + 8); // symoff
  w32(1, o + 12); // nsyms
  w32(0x820, o + 16); // stroff
  w32(0x20, o + 20); // strsize
  o += 24;
  if (options.withMain !== false) {
    w32(0x80000028, o);
    w32(24, o + 4);
    w64(0xf00n, o + 8);
    o += 24;
  }
  w32(o - 32, 20); // sizeofcmds
  // nlist_64 symbol "_main"
  w32(1, 0x800);
  buf.writeUInt8(0x0f, 0x804); // N_SECT | N_EXT
  buf.writeUInt8(1, 0x805);
  w64(0x100000f00n, 0x808);
  buf.write('\0_main\0', 0x820, 'latin1');
  return buf;
}

export function buildFatMachO(slices: Buffer[], cpus: number[]): Buffer {
  const header = Buffer.alloc(8 + slices.length * 20);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(slices.length, 4);
  let offset = 0x4000;
  const parts: Buffer[] = [header];
  let cursor = header.length;
  slices.forEach((slice, i) => {
    header.writeUInt32BE(cpus[i] ?? 7, 8 + i * 20);
    header.writeUInt32BE(offset, 8 + i * 20 + 8);
    header.writeUInt32BE(slice.length, 8 + i * 20 + 12);
    parts.push(Buffer.alloc(offset - cursor), slice);
    cursor = offset + slice.length;
    offset = Math.ceil(cursor / 0x4000) * 0x4000;
  });
  return Buffer.concat(parts);
}

export function buildCoffObject(): Buffer {
  const buf = Buffer.alloc(0x200);
  buf.writeUInt16LE(0x8664, 0); // machine
  buf.writeUInt16LE(1, 2); // sections
  buf.writeUInt32LE(0x100, 8); // symbol table pointer
  buf.writeUInt32LE(1, 12); // symbol count
  buf.write('.text', 20, 'latin1');
  buf.writeUInt32LE(0x10, 20 + 16);
  buf.writeUInt32LE(0x80, 20 + 20);
  buf.writeUInt32LE(0x60000020, 20 + 36);
  buf.write('func', 0x100, 'latin1');
  buf.writeUInt32LE(0, 0x108);
  buf.writeInt16LE(1, 0x10c);
  buf.writeUInt16LE(0x20, 0x10e);
  buf.writeUInt8(2, 0x110);
  buf.writeUInt32LE(4, 0x112 + 4); // empty string table size marker (> symtab end)
  return buf;
}

export interface ZipEntrySpec {
  name: string;
  data?: Buffer;
  method?: 0 | 8;
  unixMode?: number;
  /** Claim a different uncompressed size in the headers (ZIP bomb simulation). */
  fakeUncompressedSize?: number;
  encrypted?: boolean;
}

/** Writes a ZIP archive byte-for-byte, allowing hostile names that normal tools refuse. */
export function buildZip(entries: ZipEntrySpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = entry.data ?? Buffer.alloc(0);
    const method = entry.method ?? 8;
    const compressed = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(raw);
    const uncompressed = entry.fakeUncompressedSize ?? raw.length;
    const flags = entry.encrypted ? 1 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(uncompressed, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(uncompressed, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.unixMode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + compressed.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, eocd]);
}

export interface DolSectionSpec {
  slot: number;
  address: number;
  data: Buffer;
}

/** Builds a minimal valid GameCube DOL with one text section (slot 0) and one data section (slot 7). */
export function buildDol(
  options: {
    text?: DolSectionSpec;
    data?: DolSectionSpec;
    bss?: { address: number; size: number };
    entry?: number;
  } = {},
): Buffer {
  const text = options.text ?? {
    slot: 0,
    address: 0x8000_3100,
    data: Buffer.alloc(0x40, 0x60), // "nop" words
  };
  const data = options.data ?? { slot: 7, address: 0x8000_4000, data: Buffer.alloc(0x20, 0xab) };
  const specs = [text, data];
  const header = Buffer.alloc(0x100);
  let offset = 0x100;
  const chunks: Buffer[] = [header];
  for (const spec of specs) {
    header.writeUInt32BE(offset, spec.slot * 4);
    header.writeUInt32BE(spec.address, 0x48 + spec.slot * 4);
    header.writeUInt32BE(spec.data.length, 0x90 + spec.slot * 4);
    chunks.push(spec.data);
    offset += spec.data.length;
  }
  const bss = options.bss ?? { address: 0x8000_5000, size: 0x100 };
  header.writeUInt32BE(bss.address, 0xd8);
  header.writeUInt32BE(bss.size, 0xdc);
  header.writeUInt32BE(options.entry ?? text.address, 0xe0);
  return Buffer.concat(chunks);
}

/** Builds a GameCube disc image whose boot DOL is `dol`, placed at a 4-byte aligned offset behind the apploader. */
export function buildGcm(
  dol: Buffer,
  options: { gameId?: string; title?: string; dolOffset?: number; wii?: boolean } = {},
): Buffer {
  const dolOffset = options.dolOffset ?? 0x1_0000;
  const disc = Buffer.alloc(dolOffset + dol.length + 0x100);
  disc.write(options.gameId ?? 'GALE01', 0, 'latin1');
  disc.writeUInt8(0, 6);
  disc.writeUInt8(2, 7);
  if (options.wii) disc.writeUInt32BE(0x5d1c9ea3, 0x18);
  else disc.writeUInt32BE(0xc2339f3d, 0x1c);
  disc.write(options.title ?? 'TEST GAME', 0x20, 'latin1');
  disc.writeUInt32BE(dolOffset, 0x420);
  dol.copy(disc, dolOffset);
  return disc;
}
