import fs from 'node:fs';

/** Thrown when a header refers to data outside the file. */
export class TruncatedError extends Error {}

/** Random-access, bounds-checked reader over an open file descriptor. */
export class FileView {
  private constructor(
    private readonly fd: number,
    readonly size: number,
  ) {}

  static open(filePath: string): FileView {
    const fd = fs.openSync(filePath, 'r');
    return new FileView(fd, fs.fstatSync(fd).size);
  }

  close(): void {
    fs.closeSync(this.fd);
  }

  read(offset: number, length: number): Buffer {
    if (offset < 0 || length < 0 || offset + length > this.size) {
      throw new TruncatedError(
        `Read of ${length} bytes at ${offset} exceeds file size ${this.size}`,
      );
    }
    const buffer = Buffer.alloc(length);
    if (length > 0) fs.readSync(this.fd, buffer, 0, length, offset);
    return buffer;
  }
}

/** Endian-aware integer access on a buffer; 64-bit values are returned as bigint. */
export class Cursor {
  constructor(
    readonly buffer: Buffer,
    readonly little: boolean,
  ) {}

  u8(offset: number): number {
    this.check(offset, 1);
    return this.buffer.readUInt8(offset);
  }
  u16(offset: number): number {
    this.check(offset, 2);
    return this.little ? this.buffer.readUInt16LE(offset) : this.buffer.readUInt16BE(offset);
  }
  u32(offset: number): number {
    this.check(offset, 4);
    return this.little ? this.buffer.readUInt32LE(offset) : this.buffer.readUInt32BE(offset);
  }
  u64(offset: number): bigint {
    this.check(offset, 8);
    return this.little ? this.buffer.readBigUInt64LE(offset) : this.buffer.readBigUInt64BE(offset);
  }
  /** Reads a word of `bytes` (4 or 8) as bigint. */
  word(offset: number, bytes: 4 | 8): bigint {
    return bytes === 8 ? this.u64(offset) : BigInt(this.u32(offset));
  }
  cString(offset: number, maxLength = 512): string {
    if (offset < 0 || offset >= this.buffer.length) return '';
    let end = offset;
    const limit = Math.min(this.buffer.length, offset + maxLength);
    while (end < limit && this.buffer[end] !== 0) end++;
    return this.buffer.toString('utf8', offset, end);
  }
  fixedString(offset: number, length: number): string {
    this.check(offset, length);
    const raw = this.buffer.toString('latin1', offset, offset + length);
    const nul = raw.indexOf('\0');
    return nul >= 0 ? raw.slice(0, nul) : raw;
  }
  private check(offset: number, length: number): void {
    if (offset < 0 || offset + length > this.buffer.length) {
      throw new TruncatedError(`Field at ${offset} (+${length}) outside of buffer`);
    }
  }
}

export function hex(value: bigint | number): `0x${string}` {
  return `0x${value.toString(16)}`;
}

/** Converts a bigint to a number if it is a plausible in-file offset/size, else throws. */
export function toSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new TruncatedError('Value too large');
  return Number(value);
}

export const MAX_SYMBOLS = 20_000;
