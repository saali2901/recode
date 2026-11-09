import type { BinaryMetadata } from '../interfaces/types.js';
import type { FileView } from '../parsers/binary-reader.js';
import { isMzMagic, parsePe } from '../parsers/pe.js';
import { SelfDescribingBinaryAdapter } from './binary-adapter.js';

/** Windows PE files (EXE and DLL). */
export class PeAdapter extends SelfDescribingBinaryAdapter {
  readonly id = 'pe';
  protected readonly formatLabel = 'PE (Portable Executable)';
  protected readonly detectedFormat = 'pe' as const;
  protected matchesMagic(head: Buffer): boolean {
    return isMzMagic(head);
  }
  protected parse(view: FileView): BinaryMetadata {
    return parsePe(view);
  }
}
