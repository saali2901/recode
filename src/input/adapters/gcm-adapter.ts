import fs from 'node:fs/promises';
import path from 'node:path';
import { RecodeError } from '../../core/errors/index.js';
import { readHead } from '../../infrastructure/filesystem/files.js';
import type {
  BinaryMetadata,
  DetectionResult,
  DiscConverter,
  InputAdapter,
  PreparedBinary,
} from '../interfaces/types.js';
import { FileView, TruncatedError } from '../parsers/binary-reader.js';
import { dolMetadata } from '../parsers/dol.js';
import { classifyDisc, GCM_HEADER_SIZE, parseGcmHeader, readBootDol } from '../parsers/gcm.js';

/**
 * GameCube disc images (`.iso`, `.gcm`). The boot executable (the disc's main DOL) is extracted and
 * imported like a standalone DOL. Compressed containers (RVZ, WIA, CISO, GCZ, WBFS) and Wii discs are
 * recognized but rejected with an explanation, because they cannot be read without a decoder.
 */
export class GcmAdapter implements InputAdapter {
  readonly id = 'gcm';

  constructor(private readonly converter?: DiscConverter) {}

  async detect(filePath: string): Promise<DetectionResult> {
    const disc = classifyDisc(await readHead(filePath, GCM_HEADER_SIZE));
    if (disc.kind === 'unknown') {
      return {
        adapterId: this.id,
        kind: 'unknown',
        confidence: 0,
        description: 'Not a GameCube disc image',
      };
    }
    const descriptions = {
      gamecube: 'GameCube disc image',
      wii: 'Wii disc image (not supported yet)',
      compressed: `${disc.format ?? 'Compressed'} disc container (convert to ISO first)`,
    } as const;
    return {
      adapterId: this.id,
      kind: 'binary',
      format: 'gcm',
      confidence: disc.kind === 'gamecube' ? 1 : 0.9,
      description: descriptions[disc.kind],
    };
  }

  async getMetadata(filePath: string): Promise<BinaryMetadata> {
    return (await this.readDisc(filePath)).metadata;
  }

  async prepare(filePath: string, outputDirectory: string): Promise<PreparedBinary[]> {
    const { metadata, data } = await this.readDisc(filePath);
    const target = await writeUnique(
      outputDirectory,
      `${metadata.game?.gameId ?? 'disc'}-boot.dol`,
      data,
    );
    return [{ path: target, origin: `${path.basename(filePath)} :: boot.dol`, metadata }];
  }

  private async readDisc(
    filePath: string,
    allowConversion = true,
  ): Promise<{ metadata: BinaryMetadata; data: Buffer }> {
    const name = path.basename(filePath);
    const disc = classifyDisc(await readHead(filePath, GCM_HEADER_SIZE));
    if (disc.kind === 'compressed') {
      if (!this.converter || !allowConversion) {
        throw new RecodeError('INVALID_INPUT', `${name} is a ${disc.format} container.`, {
          hint: 'Convert it to a plain ISO first (Dolphin: right-click the game > Convert File).',
        });
      }
      const converted = await this.converter.convertToIso(filePath);
      try {
        return await this.readDisc(converted.isoPath, false);
      } finally {
        await converted.dispose();
      }
    }
    if (disc.kind === 'wii') {
      throw new RecodeError('INVALID_INPUT', `${name} is a Wii disc; Wii is not supported yet.`, {
        hint: 'Only GameCube discs and standalone DOL files can be imported.',
      });
    }
    if (disc.kind !== 'gamecube') {
      throw new RecodeError('INVALID_INPUT', `${name} is not a GameCube disc image.`);
    }

    const view = FileView.open(filePath);
    try {
      const header = parseGcmHeader(view.read(0, GCM_HEADER_SIZE), view.size);
      const { image, data } = readBootDol(view, header.dolOffset);
      return { metadata: dolMetadata(image, header.game), data };
    } catch (error) {
      if (error instanceof TruncatedError) {
        throw new RecodeError(
          'INVALID_INPUT',
          `${name}: damaged GameCube disc (${error.message})`,
          {
            hint: 'The image may be incomplete or trimmed too aggressively; try dumping or converting it again.',
          },
        );
      }
      throw error;
    } finally {
      view.close();
    }
  }
}

/** Writes a new file without overwriting an existing one. */
async function writeUnique(directory: string, fileName: string, data: Buffer): Promise<string> {
  await fs.mkdir(directory, { recursive: true });
  const ext = path.extname(fileName);
  const stem = path.basename(fileName, ext);
  for (let i = 0; i < 1000; i++) {
    const target = path.join(directory, i === 0 ? fileName : `${stem}-${i}${ext}`);
    try {
      await fs.writeFile(target, data, { flag: 'wx' });
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new RecodeError('INVALID_INPUT', `Cannot find a free file name for ${fileName}`);
}
