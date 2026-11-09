import fs from 'node:fs/promises';
import path from 'node:path';
import { RecodeError } from '../../core/errors/index.js';
import { readHead } from '../../infrastructure/filesystem/files.js';
import { sanitizeFileName } from '../../infrastructure/filesystem/paths.js';
import { extractZip, isZipMagic, type ArchiveLimits } from '../extractors/zip.js';
import type {
  BinaryMetadata,
  DetectionResult,
  InputAdapter,
  MetadataHints,
  PreparedBinary,
} from '../interfaces/types.js';
import type { AdapterRegistry } from './registry.js';

/**
 * ZIP archives. Entries are extracted safely below `<outputDirectory>/<archive-name>/` and every
 * entry recognized as a binary by another adapter is returned. Other files stay in the extraction
 * directory. Nested archives are not expanded.
 */
export class ZipAdapter implements InputAdapter {
  readonly id = 'zip';

  constructor(
    private readonly registry: AdapterRegistry,
    private readonly limits: ArchiveLimits,
  ) {}

  async detect(filePath: string): Promise<DetectionResult> {
    const head = await readHead(filePath, 4);
    const match = isZipMagic(head);
    return {
      adapterId: this.id,
      kind: match ? 'archive' : 'unknown',
      format: match ? 'zip' : undefined,
      confidence: match ? 1 : 0,
      description: match ? 'ZIP archive' : 'Not a ZIP archive',
    };
  }

  async getMetadata(): Promise<BinaryMetadata> {
    throw new RecodeError(
      'INVALID_INPUT',
      'Archives have no binary metadata; import extracts them first.',
    );
  }

  async prepare(
    filePath: string,
    outputDirectory: string,
    hints?: MetadataHints,
  ): Promise<PreparedBinary[]> {
    const stem = sanitizeFileName(path.basename(filePath, path.extname(filePath)), 'archive');
    const target = await uniqueDirectory(outputDirectory, stem);
    const extraction = await extractZip(filePath, target, this.limits);

    const prepared: PreparedBinary[] = [];
    for (const file of extraction.extracted) {
      const detection = await this.registry.detectBinary(file);
      if (!detection) continue;
      const adapter = this.registry.get(detection.adapterId);
      if (!adapter || adapter.id === this.id) continue;
      const metadata = await adapter.getMetadata(file, hints);
      prepared.push({
        path: file,
        origin: `${path.basename(filePath)}!${path.relative(target, file)}`,
        metadata,
      });
    }
    return prepared;
  }
}

async function uniqueDirectory(parent: string, name: string): Promise<string> {
  await fs.mkdir(parent, { recursive: true });
  for (let i = 0; i < 1000; i++) {
    const candidate = path.join(parent, i === 0 ? name : `${name}-${i}`);
    try {
      await fs.mkdir(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new RecodeError('INVALID_INPUT', `Cannot create extraction directory for ${name}`);
}
