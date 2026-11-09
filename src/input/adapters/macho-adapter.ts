import fs from 'node:fs/promises';
import path from 'node:path';
import { RecodeError } from '../../core/errors/index.js';
import { copyUnique, readHead } from '../../infrastructure/filesystem/files.js';
import type { BinaryMetadata, PreparedBinary } from '../interfaces/types.js';
import { FileView } from '../parsers/binary-reader.js';
import { isFatMagic, isMachOMagic, parseMachO, readFatSlices } from '../parsers/macho.js';
import { SelfDescribingBinaryAdapter } from './binary-adapter.js';

/** Mach-O images, including universal (fat) binaries which are split into one file per slice. */
export class MachOAdapter extends SelfDescribingBinaryAdapter {
  readonly id = 'macho';
  protected readonly formatLabel = 'Mach-O';
  protected readonly detectedFormat = 'macho' as const;

  protected matchesMagic(head: Buffer, fileSize: number): boolean {
    return isMachOMagic(head) || isFatMagic(head, fileSize);
  }

  protected parse(view: FileView): BinaryMetadata {
    const head = view.read(0, Math.min(8, view.size));
    if (isFatMagic(head, view.size)) {
      const first = readFatSlices(view)[0];
      if (!first) throw new RecodeError('INVALID_INPUT', 'Universal binary has no slices.');
      return parseMachO(view, first.offset, first.size);
    }
    return parseMachO(view);
  }

  override async prepare(filePath: string, outputDirectory: string): Promise<PreparedBinary[]> {
    const head = await readHead(filePath, 8);
    const stat = await fs.stat(filePath);
    if (!isFatMagic(head, stat.size)) return super.prepare(filePath, outputDirectory);

    const view = FileView.open(filePath);
    try {
      const prepared: PreparedBinary[] = [];
      const stem = path.basename(filePath);
      for (const slice of readFatSlices(view)) {
        const metadata = parseMachO(view, slice.offset, slice.size);
        const data = view.read(slice.offset, slice.size);
        const target = await writeSlice(outputDirectory, `${stem}.${slice.architecture}`, data);
        prepared.push({
          path: target,
          origin: `${stem} (universal slice ${slice.architecture})`,
          metadata,
        });
      }
      return prepared;
    } finally {
      view.close();
    }
  }
}

async function writeSlice(directory: string, name: string, data: Buffer): Promise<string> {
  await fs.mkdir(directory, { recursive: true });
  const tmpDir = await fs.mkdtemp(path.join(directory.replace(/[\\/]$/, ''), '.slice-'));
  const tmp = path.join(tmpDir, 'slice');
  try {
    await fs.writeFile(tmp, data);
    return await copyUnique(tmp, directory, name);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}
