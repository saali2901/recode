import fs from 'node:fs/promises';
import path from 'node:path';
import { RecodeError } from '../../core/errors/index.js';
import { copyUnique } from '../../infrastructure/filesystem/files.js';
import {
  RawBinaryOptionsSchema,
  type BinaryMetadata,
  type DetectionResult,
  type InputAdapter,
  type MetadataHints,
  type PreparedBinary,
} from '../interfaces/types.js';

const RAW_EXTENSIONS = new Set(['.bin', '.raw', '.img', '.rom', '.fw']);

export const RAW_OPTION_HELP =
  'Raw binaries carry no header information. Provide: --arch <x86|x86_64|arm|aarch64|mips|mips64|ppc|ppc64|riscv32|riscv64> ' +
  '--endian <little|big> --bits <16|32|64> --base <hex address> [--entry <hex address>]';

/** Headerless binaries; all facts about them must be supplied by the user. */
export class RawBinaryAdapter implements InputAdapter {
  readonly id = 'raw';

  async detect(filePath: string): Promise<DetectionResult> {
    const byExtension = RAW_EXTENSIONS.has(path.extname(filePath).toLowerCase());
    return {
      adapterId: this.id,
      kind: byExtension ? 'binary' : 'unknown',
      format: byExtension ? 'raw' : undefined,
      confidence: byExtension ? 0.3 : 0,
      description: byExtension
        ? 'Headerless binary (by file extension only)'
        : 'No recognizable structure',
    };
  }

  async getMetadata(_filePath: string, hints?: MetadataHints): Promise<BinaryMetadata> {
    const parsed = RawBinaryOptionsSchema.safeParse(hints?.raw);
    if (!parsed.success) {
      throw new RecodeError('INVALID_INPUT', 'Missing or invalid information for raw binary.', {
        hint: RAW_OPTION_HELP,
      });
    }
    const options = parsed.data;
    return {
      format: 'raw',
      kind: 'raw',
      architecture: options.architecture,
      bits: options.bits,
      endianness: options.endianness,
      entryPoint: options.entryPoint,
      baseAddress: options.baseAddress,
      sections: [],
      segments: [],
      symbols: [],
      symbolsTruncated: false,
      source: 'user',
      warnings: ['Metadata was supplied by the user, not read from the file.'],
    };
  }

  async prepare(
    filePath: string,
    outputDirectory: string,
    hints?: MetadataHints,
  ): Promise<PreparedBinary[]> {
    const metadata = await this.getMetadata(filePath, hints);
    const stat = await fs.stat(filePath);
    if (stat.size === 0) throw new RecodeError('INVALID_INPUT', 'Raw binary is empty.');
    const target = await copyUnique(filePath, outputDirectory, path.basename(filePath));
    return [{ path: target, origin: path.basename(filePath), metadata }];
  }
}
