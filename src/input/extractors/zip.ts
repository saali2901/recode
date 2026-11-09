import fs from 'node:fs/promises';
import path from 'node:path';
import { crc32, inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';
import { RecodeError } from '../../core/errors/index.js';
import { safeJoin } from '../../infrastructure/filesystem/paths.js';
import { FileView } from '../parsers/binary-reader.js';

const inflateRawAsync = promisify(inflateRaw);

export interface ArchiveLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  maxCompressionRatio: number;
}

export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  crc: number;
  localHeaderOffset: number;
  isDirectory: boolean;
  isSymlink: boolean;
  /** Unix permission bits from the archive (0 if the archive has none). */
  mode: number;
  encrypted: boolean;
}

export interface ExtractionResult {
  extracted: string[];
  skipped: Array<{ name: string; reason: string }>;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export function isZipMagic(head: Buffer): boolean {
  return (
    head.length >= 4 &&
    head[0] === 0x50 &&
    head[1] === 0x4b &&
    ((head[2] === 3 && head[3] === 4) || (head[2] === 5 && head[3] === 6))
  );
}

function archiveError(message: string): RecodeError {
  return new RecodeError('ARCHIVE', message);
}

/** Reads the central directory. ZIP64 and multi-disk archives are rejected explicitly. */
export function readZipEntries(view: FileView, limits: ArchiveLimits): ZipEntry[] {
  const tailSize = Math.min(view.size, 22 + 0xffff);
  const tail = view.read(view.size - tailSize, tailSize);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0)
    throw archiveError('Not a valid ZIP archive: end-of-central-directory record not found.');

  const diskNumber = tail.readUInt16LE(eocd + 4);
  const total = tail.readUInt16LE(eocd + 10);
  const dirSize = tail.readUInt32LE(eocd + 12);
  const dirOffset = tail.readUInt32LE(eocd + 16);
  if (diskNumber !== 0) throw archiveError('Multi-disk ZIP archives are not supported.');
  if (total === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) {
    throw archiveError('ZIP64 archives are not supported.');
  }
  if (total > limits.maxFiles) {
    throw archiveError(`Archive contains ${total} entries; limit is ${limits.maxFiles}.`);
  }
  if (dirOffset + dirSize > view.size)
    throw archiveError('Corrupt ZIP: central directory out of range.');

  const dir = view.read(dirOffset, dirSize);
  const entries: ZipEntry[] = [];
  let offset = 0;
  for (let i = 0; i < total; i++) {
    if (offset + 46 > dir.length || dir.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw archiveError('Corrupt ZIP: bad central directory entry.');
    }
    const flags = dir.readUInt16LE(offset + 8);
    const nameLength = dir.readUInt16LE(offset + 28);
    const extraLength = dir.readUInt16LE(offset + 30);
    const commentLength = dir.readUInt16LE(offset + 32);
    const externalAttributes = dir.readUInt32LE(offset + 38);
    const name = dir.toString('utf8', offset + 46, offset + 46 + nameLength);
    const unixMode = externalAttributes >>> 16;
    entries.push({
      name,
      method: dir.readUInt16LE(offset + 10),
      crc: dir.readUInt32LE(offset + 16),
      compressedSize: dir.readUInt32LE(offset + 20),
      uncompressedSize: dir.readUInt32LE(offset + 24),
      localHeaderOffset: dir.readUInt32LE(offset + 42),
      isDirectory: name.endsWith('/'),
      isSymlink: (unixMode & 0o170000) === 0o120000,
      mode: unixMode & 0o777,
      encrypted: (flags & 1) !== 0,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function validateEntryName(name: string): void {
  const normalized = name.replace(/\\/g, '/');
  if (
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split('/').includes('..')
  ) {
    throw new RecodeError(
      'UNSAFE_PATH',
      `Archive entry has an unsafe path: ${JSON.stringify(name)}`,
    );
  }
}

/**
 * Safely extracts a ZIP archive into `targetDir`.
 * Rejects path traversal, absolute paths, symlinks (skipped), encrypted entries, oversized
 * archives, suspicious compression ratios and CRC mismatches. Never overwrites existing files.
 */
export async function extractZip(
  archivePath: string,
  targetDir: string,
  limits: ArchiveLimits,
): Promise<ExtractionResult> {
  const view = FileView.open(archivePath);
  try {
    const entries = readZipEntries(view, limits);
    const result: ExtractionResult = { extracted: [], skipped: [] };
    let totalBytes = 0;
    await fs.mkdir(targetDir, { recursive: true });
    const realTarget = await fs.realpath(targetDir);

    for (const entry of entries) {
      validateEntryName(entry.name);
      if (entry.isSymlink) {
        result.skipped.push({ name: entry.name, reason: 'symbolic link' });
        continue;
      }
      if (entry.encrypted) {
        result.skipped.push({ name: entry.name, reason: 'encrypted entry' });
        continue;
      }
      const destination = safeJoin(realTarget, entry.name.replace(/\\/g, '/'));
      if (entry.isDirectory) {
        await fs.mkdir(destination, { recursive: true });
        continue;
      }
      if (entry.uncompressedSize > limits.maxFileBytes) {
        throw archiveError(`Entry ${entry.name} exceeds the per-file size limit.`);
      }
      totalBytes += entry.uncompressedSize;
      if (totalBytes > limits.maxTotalBytes) {
        throw archiveError('Archive exceeds the total extracted size limit.');
      }
      if (
        entry.compressedSize > 0 &&
        entry.uncompressedSize / entry.compressedSize > limits.maxCompressionRatio
      ) {
        throw archiveError(
          `Entry ${entry.name} has a suspicious compression ratio (possible ZIP bomb).`,
        );
      }
      const data = await readEntryData(view, entry, limits.maxFileBytes);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await assertNoSymlinkParents(realTarget, destination);
      try {
        // Only the executable bit is taken from the archive (never setuid/setgid or write bits).
        await fs.writeFile(destination, data, {
          flag: 'wx',
          mode: entry.mode & 0o111 ? 0o755 : 0o644,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw archiveError(`Duplicate or conflicting archive entry: ${entry.name}`);
        }
        throw error;
      }
      result.extracted.push(destination);
    }
    return result;
  } finally {
    view.close();
  }
}

async function assertNoSymlinkParents(root: string, destination: string): Promise<void> {
  const real = await fs.realpath(path.dirname(destination));
  const relative = path.relative(root, real);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new RecodeError('UNSAFE_PATH', 'Archive extraction would leave the target directory.');
  }
}

async function readEntryData(view: FileView, entry: ZipEntry, maxBytes: number): Promise<Buffer> {
  const local = view.read(entry.localHeaderOffset, 30);
  if (local.readUInt32LE(0) !== LOCAL_SIGNATURE)
    throw archiveError(`Corrupt local header for ${entry.name}.`);
  const dataOffset = entry.localHeaderOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  if (dataOffset + entry.compressedSize > view.size)
    throw archiveError(`Truncated data for ${entry.name}.`);
  const compressed = view.read(dataOffset, entry.compressedSize);

  let data: Buffer;
  if (entry.method === 0) {
    data = compressed;
  } else if (entry.method === 8) {
    try {
      data = await inflateRawAsync(compressed, { maxOutputLength: maxBytes });
    } catch (error) {
      throw archiveError(`Cannot decompress ${entry.name}: ${(error as Error).message}`);
    }
  } else {
    throw archiveError(`Unsupported compression method ${entry.method} for ${entry.name}.`);
  }
  if (data.length !== entry.uncompressedSize) {
    throw archiveError(`Size mismatch for ${entry.name}.`);
  }
  if (crc32(data) !== entry.crc) throw archiveError(`CRC mismatch for ${entry.name}.`);
  return data;
}
