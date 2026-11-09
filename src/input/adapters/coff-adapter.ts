import path from 'node:path';
import fs from 'node:fs/promises';
import type { BinaryMetadata, DetectionResult } from '../interfaces/types.js';
import { FileView } from '../parsers/binary-reader.js';
import { looksLikeCoffObject, parseCoff } from '../parsers/coff.js';
import { SelfDescribingBinaryAdapter } from './binary-adapter.js';

/** COFF object files (.obj). Without a magic number, detection is structural and less certain. */
export class CoffAdapter extends SelfDescribingBinaryAdapter {
  readonly id = 'coff';
  protected readonly formatLabel = 'COFF object file';
  protected readonly detectedFormat = 'coff' as const;

  protected matchesMagic(head: Buffer): boolean {
    return head.length >= 20;
  }
  protected parse(view: FileView): BinaryMetadata {
    return parseCoff(view);
  }

  override async detect(filePath: string): Promise<DetectionResult> {
    const stat = await fs.stat(filePath);
    if (stat.size < 20) return this.miss();
    const view = FileView.open(filePath);
    let plausible: boolean;
    try {
      plausible = looksLikeCoffObject(view);
    } finally {
      view.close();
    }
    if (!plausible) return this.miss();
    const extensionMatches = ['.obj', '.o'].includes(path.extname(filePath).toLowerCase());
    return {
      adapterId: this.id,
      kind: 'binary',
      format: 'coff',
      confidence: extensionMatches ? 0.8 : 0.5,
      description: this.formatLabel,
    };
  }

  private miss(): DetectionResult {
    return { adapterId: this.id, kind: 'unknown', confidence: 0, description: 'Not a COFF object' };
  }
}
