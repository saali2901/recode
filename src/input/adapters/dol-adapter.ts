import path from 'node:path';
import { RecodeError } from '../../core/errors/index.js';
import type { BinaryMetadata, DetectionResult } from '../interfaces/types.js';
import { type FileView, TruncatedError } from '../parsers/binary-reader.js';
import { DOL_HEADER_SIZE, dolMetadata, parseDol } from '../parsers/dol.js';
import { dolSmallDataBases } from '../parsers/ppc-startup.js';
import { SelfDescribingBinaryAdapter } from './binary-adapter.js';

/**
 * GameCube executables (`.dol`). The format has no magic bytes, so a file counts as DOL only when the whole
 * header is structurally consistent; otherwise the adapter reports "not recognized" (never "malformed DOL").
 */
export class DolAdapter extends SelfDescribingBinaryAdapter {
  readonly id = 'dol';
  protected readonly formatLabel = 'GameCube DOL executable';
  protected readonly detectedFormat = 'dol' as const;

  protected matchesMagic(_head: Buffer, fileSize: number): boolean {
    return fileSize >= DOL_HEADER_SIZE;
  }

  protected parse(view: FileView): BinaryMetadata {
    if (view.size < DOL_HEADER_SIZE) throw new TruncatedError('File is smaller than a DOL header');
    const image = parseDol(view.read(0, DOL_HEADER_SIZE), view.size);
    return dolMetadata(image, { registers: dolSmallDataBases(image, (o, l) => view.read(o, l)) });
  }

  override async detect(filePath: string): Promise<DetectionResult> {
    const result = await super.detect(filePath);
    if (result.kind !== 'binary') {
      return { ...result, confidence: 0, description: `Not ${this.formatLabel}` };
    }
    const hasExtension = path.extname(filePath).toLowerCase() === '.dol';
    return { ...result, confidence: hasExtension ? 1 : 0.7 };
  }

  override async getMetadata(filePath: string): Promise<BinaryMetadata> {
    try {
      return await super.getMetadata(filePath);
    } catch (error) {
      if (error instanceof RecodeError) {
        throw new RecodeError('INVALID_INPUT', error.message, {
          hint: 'The file is not a valid GameCube DOL executable.',
        });
      }
      throw error;
    }
  }
}
