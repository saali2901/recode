import type { BinaryMetadata } from '../../input/interfaces/types.js';

/**
 * Maps architecture facts to a Ghidra language ID. Only needed for raw binaries, since Ghidra's
 * format loaders choose the language themselves for ELF, PE and Mach-O.
 */
export function ghidraLanguageId(
  metadata: Pick<BinaryMetadata, 'architecture' | 'bits' | 'endianness'>,
): string | undefined {
  const endian = metadata.endianness === 'little' ? 'LE' : 'BE';
  switch (metadata.architecture) {
    case 'x86':
      return metadata.bits === 16 ? 'x86:LE:16:Real Mode' : 'x86:LE:32:default';
    case 'x86_64':
      return 'x86:LE:64:default';
    case 'arm':
      return `ARM:${endian}:32:v8`;
    case 'aarch64':
      return `AARCH64:${endian}:64:v8A`;
    case 'mips':
      return `MIPS:${endian}:32:default`;
    case 'mips64':
      return `MIPS:${endian}:64:default`;
    case 'ppc':
      return `PowerPC:${endian}:32:default`;
    case 'ppc64':
      return `PowerPC:${endian}:64:default`;
    case 'riscv32':
      return 'RISCV:LE:32:default';
    case 'riscv64':
      return 'RISCV:LE:64:default';
    default:
      return undefined;
  }
}
