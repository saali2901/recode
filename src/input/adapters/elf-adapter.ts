import type { BinaryMetadata } from '../interfaces/types.js';
import type { FileView } from '../parsers/binary-reader.js';
import { isElfMagic, parseElf } from '../parsers/elf.js';
import { SelfDescribingBinaryAdapter } from './binary-adapter.js';

/** ELF executables, shared objects and relocatable object files. */
export class ElfAdapter extends SelfDescribingBinaryAdapter {
  readonly id = 'elf';
  protected readonly formatLabel = 'ELF';
  protected readonly detectedFormat = 'elf' as const;
  protected matchesMagic(head: Buffer): boolean {
    return isElfMagic(head);
  }
  protected parse(view: FileView): BinaryMetadata {
    return parseElf(view);
  }
}
