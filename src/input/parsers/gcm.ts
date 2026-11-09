import type { GameInfo } from '../interfaces/types.js';
import { Cursor, type FileView, TruncatedError } from './binary-reader.js';
import { DOL_HEADER_SIZE, parseDol, type DolImage } from './dol.js';

/** Size of the disc header, boot info and boot info 2 that precede the apploader. */
export const GCM_HEADER_SIZE = 0x440;
const GAMECUBE_MAGIC = 0xc233_9f3d;
const WII_MAGIC = 0x5d1c_9ea3;
const DOL_OFFSET_FIELD = 0x420;
/** The apploader starts at 0x2440; the boot DOL always lies behind it. */
const MIN_DOL_OFFSET = 0x2440;

const REGIONS: Readonly<Record<string, string>> = {
  E: 'NTSC-U (USA)',
  J: 'NTSC-J (Japan)',
  P: 'PAL (Europe)',
  D: 'PAL (Germany)',
  F: 'PAL (France)',
  I: 'PAL (Italy)',
  S: 'PAL (Spain)',
  U: 'PAL (Australia)',
  K: 'NTSC-K (Korea)',
};

/** Container formats that wrap a disc and must be converted to a plain ISO first (e.g. with Dolphin). */
const COMPRESSED_FORMATS: ReadonlyArray<{ name: string; magic: Buffer }> = [
  { name: 'CISO', magic: Buffer.from('CISO', 'latin1') },
  { name: 'WIA', magic: Buffer.from('WIA\x01', 'latin1') },
  { name: 'RVZ', magic: Buffer.from('RVZ\x01', 'latin1') },
  { name: 'GCZ', magic: Buffer.from([0xb1, 0x0b, 0xc0, 0x01]) },
  { name: 'WBFS', magic: Buffer.from('WBFS', 'latin1') },
];

export type DiscKind = 'gamecube' | 'wii' | 'compressed' | 'unknown';

export function classifyDisc(head: Buffer): { kind: DiscKind; format?: string } {
  for (const format of COMPRESSED_FORMATS) {
    if (head.subarray(0, format.magic.length).equals(format.magic)) {
      return { kind: 'compressed', format: format.name };
    }
  }
  if (head.length < GCM_HEADER_SIZE) return { kind: 'unknown' };
  const c = new Cursor(head, false);
  if (c.u32(0x1c) === GAMECUBE_MAGIC) return { kind: 'gamecube' };
  if (c.u32(0x18) === WII_MAGIC) return { kind: 'wii' };
  return { kind: 'unknown' };
}

export interface GcmDisc {
  game: GameInfo;
  dolOffset: number;
}

/** Reads the identification and the boot DOL location from a GameCube disc header. */
export function parseGcmHeader(head: Buffer, discSize: number): GcmDisc {
  const c = new Cursor(head, false);
  const gameCode = c.fixedString(0, 4);
  const maker = c.fixedString(4, 2);
  if (!/^[A-Z0-9]{4}$/.test(gameCode)) {
    throw new TruncatedError('Disc header has an invalid game code');
  }
  const dolOffset = c.u32(DOL_OFFSET_FIELD);
  if (dolOffset < MIN_DOL_OFFSET || dolOffset + DOL_HEADER_SIZE > discSize) {
    throw new TruncatedError(`Boot DOL offset 0x${dolOffset.toString(16)} is outside of the disc`);
  }
  const title = c
    .fixedString(0x20, 64)
    .replace(/[^\x20-\x7e]/g, '?')
    .trim();
  const region = REGIONS[gameCode.charAt(3)];
  return {
    game: {
      gameId: `${gameCode}${/^[A-Z0-9]{2}$/.test(maker) ? maker : ''}`,
      title: title || gameCode,
      ...(region ? { region } : {}),
      discNumber: c.u8(6),
      version: c.u8(7),
    },
    dolOffset,
  };
}

/** Reads the boot DOL out of the disc image. Its size comes from the validated DOL header. */
export function readBootDol(view: FileView, dolOffset: number): { image: DolImage; data: Buffer } {
  const header = view.read(dolOffset, DOL_HEADER_SIZE);
  const image = parseDol(header, view.size - dolOffset);
  return { image, data: view.read(dolOffset, image.fileSize) };
}
