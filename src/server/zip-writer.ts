import fs from 'node:fs/promises';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { crc32, deflateRawSync } from 'node:zlib';

const MAX_ENTRY_BYTES = 0xffffffff; // ZIP64 is not written

interface CentralRecord {
  name: Buffer;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
  method: number;
}

async function listFiles(root: string, dir = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    // Symlinks are skipped on purpose: an archive must never pull in files from outside the tree.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...(await listFiles(root, full)));
    else if (entry.isFile()) files.push(full);
  }
  return files.sort();
}

function write(out: Writable, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    out.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}

/** Streams the files below `directory` into `out` as a ZIP archive (deflate, no ZIP64). */
export async function writeDirectoryZip(
  directory: string,
  out: Writable,
  prefix = '',
): Promise<void> {
  const records: CentralRecord[] = [];
  let offset = 0;
  for (const file of await listFiles(directory)) {
    const relative = path.relative(directory, file).split(path.sep).join('/');
    const content = await fs.readFile(file);
    if (content.length > MAX_ENTRY_BYTES) continue;
    const compressed = deflateRawSync(content);
    const useDeflate = compressed.length < content.length;
    const data = useDeflate ? compressed : content;
    const name = Buffer.from(`${prefix}${relative}`, 'utf8');
    const crc = crc32(content);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(useDeflate ? 8 : 0, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(content.length, 22);
    header.writeUInt16LE(name.length, 26);
    await write(out, Buffer.concat([header, name, data]));
    records.push({
      name,
      crc,
      compressedSize: data.length,
      size: content.length,
      offset,
      method: useDeflate ? 8 : 0,
    });
    offset += 30 + name.length + data.length;
  }

  const central: Buffer[] = [];
  for (const r of records) {
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(0x031e, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(r.method, 10);
    entry.writeUInt32LE(r.crc, 16);
    entry.writeUInt32LE(r.compressedSize, 20);
    entry.writeUInt32LE(r.size, 24);
    entry.writeUInt16LE(r.name.length, 28);
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    entry.writeUInt32LE(r.offset, 42);
    central.push(entry, r.name);
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(records.length, 8);
  end.writeUInt16LE(records.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  await write(out, Buffer.concat([centralBytes, end]));
}
