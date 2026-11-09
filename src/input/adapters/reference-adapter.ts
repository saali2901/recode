import fs from 'node:fs/promises';
import path from 'node:path';
import { RecodeError } from '../../core/errors/index.js';
import { copyUnique, readHead } from '../../infrastructure/filesystem/files.js';
import { REFERENCE_EXTENSIONS, looksLikeText } from '../detection/text.js';
import type { DetectionResult } from '../interfaces/types.js';

/**
 * Reference material (sources, headers, JSON, YAML, text, map/symbol files).
 * Intentionally not an InputAdapter: it never yields analyzable binaries.
 */
export class ReferenceMaterialAdapter {
  readonly id = 'reference';

  async detect(filePath: string): Promise<DetectionResult> {
    const ext = path.extname(filePath).toLowerCase();
    if (!REFERENCE_EXTENSIONS.has(ext)) {
      return {
        adapterId: this.id,
        kind: 'unknown',
        confidence: 0,
        description: 'Not reference material',
      };
    }
    const head = await readHead(filePath, 4096);
    if (!looksLikeText(head)) {
      return {
        adapterId: this.id,
        kind: 'unknown',
        confidence: 0,
        description: `File has extension ${ext} but binary content`,
      };
    }
    return {
      adapterId: this.id,
      kind: 'reference',
      format: 'reference',
      confidence: 0.9,
      description: `Reference material (${ext})`,
    };
  }

  async store(filePath: string, referenceDirectory: string): Promise<string> {
    const stat = await fs.stat(filePath);
    if (stat.size > 50 * 1024 * 1024) {
      throw new RecodeError('INVALID_INPUT', 'Reference file is larger than 50 MiB.');
    }
    return copyUnique(filePath, referenceDirectory, path.basename(filePath));
  }
}
