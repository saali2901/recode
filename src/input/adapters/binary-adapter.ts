import fs from 'node:fs/promises';
import path from 'node:path';
import { RecodeError } from '../../core/errors/index.js';
import { copyUnique, readHead } from '../../infrastructure/filesystem/files.js';
import type {
  BinaryMetadata,
  DetectionResult,
  InputAdapter,
  MetadataHints,
  PreparedBinary,
} from '../interfaces/types.js';
import { FileView, TruncatedError } from '../parsers/binary-reader.js';

/**
 * Shared behaviour of adapters for self-describing binary formats: header sniffing,
 * metadata parsing from the file itself and copying into the project without overwriting.
 */
export abstract class SelfDescribingBinaryAdapter implements InputAdapter {
  abstract readonly id: string;
  protected abstract readonly formatLabel: string;
  protected abstract readonly detectedFormat: NonNullable<DetectionResult['format']>;

  /** Quick magic-byte check on the first bytes of the file. */
  protected abstract matchesMagic(head: Buffer, fileSize: number): boolean;
  /** Full structural parse. Throws TruncatedError for malformed files. */
  protected abstract parse(view: FileView): BinaryMetadata;

  async detect(filePath: string): Promise<DetectionResult> {
    const miss: DetectionResult = {
      adapterId: this.id,
      kind: 'unknown',
      confidence: 0,
      description: `Not ${this.formatLabel}`,
    };
    const stat = await fs.stat(filePath);
    const head = await readHead(filePath, 64);
    if (!this.matchesMagic(head, stat.size)) return miss;
    try {
      await this.getMetadata(filePath);
    } catch (error) {
      if (error instanceof RecodeError || error instanceof TruncatedError) {
        return {
          ...miss,
          confidence: 0.3,
          description: `${this.formatLabel} magic but malformed headers`,
        };
      }
      throw error;
    }
    return {
      adapterId: this.id,
      kind: 'binary',
      format: this.detectedFormat,
      confidence: 1,
      description: this.formatLabel,
    };
  }

  async getMetadata(filePath: string, _hints?: MetadataHints): Promise<BinaryMetadata> {
    const view = FileView.open(filePath);
    try {
      return this.parse(view);
    } catch (error) {
      if (error instanceof TruncatedError) {
        throw new RecodeError(
          'INVALID_INPUT',
          `${path.basename(filePath)}: malformed ${this.formatLabel} (${error.message})`,
        );
      }
      throw error;
    } finally {
      view.close();
    }
  }

  async prepare(filePath: string, outputDirectory: string): Promise<PreparedBinary[]> {
    const metadata = await this.getMetadata(filePath);
    const target = await copyUnique(filePath, outputDirectory, path.basename(filePath));
    return [{ path: target, origin: path.basename(filePath), metadata }];
  }
}
