import fs from 'node:fs/promises';
import path from 'node:path';
import { RecodeError } from '../../core/errors/index.js';
import type { BinaryMetadata } from '../../input/interfaces/types.js';
import { ghidraLanguageId } from './language.js';

export const DOL_IMPORT_SCRIPT = 'ImportDol.java';

/** Language ID of the Nintendo Gekko/Broadway CPU, including paired-singles instructions. */
const GEKKO_PATTERN = /id="(PowerPC:BE:32:[^"]*(?:gekko|broadway)[^"]*)"/i;
const GENERIC_PPC = 'PowerPC:BE:32:default';

/**
 * Finds the Gekko/Broadway language in a Ghidra installation by reading its language definitions.
 * Older Ghidra releases lack it; the caller then falls back to generic PowerPC and warns.
 */
export async function findGekkoLanguage(installDir: string): Promise<string | undefined> {
  const dir = path.join(installDir, 'Ghidra', 'Processors', 'PowerPC', 'data', 'languages');
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return undefined;
  }
  for (const name of names.filter((n) => n.endsWith('.ldefs')).sort()) {
    const text = await fs.readFile(path.join(dir, name), 'utf8');
    const match = GEKKO_PATTERN.exec(text);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export interface ImportPlan {
  /** Arguments between `-import <file>` and the post script. */
  args: string[];
  /** Address handed to ExportAnalysis.java for creating the entry function, or "-" for none. */
  entry: string;
  warnings: string[];
}

/** Derives the Ghidra import strategy from the binary's metadata. Native formats need no extra arguments. */
export function planImport(
  metadata: BinaryMetadata,
  options: { gekkoLanguage?: string | undefined },
): ImportPlan {
  if (metadata.format === 'raw') {
    const language = ghidraLanguageId(metadata);
    if (!language || !metadata.baseAddress) {
      throw new RecodeError('INVALID_INPUT', 'Raw binary lacks architecture or base address.');
    }
    return {
      args: [
        '-loader',
        'BinaryLoader',
        '-loader-baseAddr',
        metadata.baseAddress,
        '-processor',
        language,
      ],
      entry: metadata.entryPoint ?? '-',
      warnings: [],
    };
  }

  if (metadata.format === 'dol') {
    if (!metadata.entryPoint) throw new RecodeError('INVALID_INPUT', 'DOL lacks an entry point.');
    const warnings: string[] = [];
    let language = options.gekkoLanguage;
    if (!language) {
      language = GENERIC_PPC;
      warnings.push(
        `This Ghidra has no Gekko/Broadway language; using ${GENERIC_PPC}. Paired-singles (floating point) code will decode incorrectly. Use a newer Ghidra for best results.`,
      );
    }
    const layout = metadata.segments.map((s) =>
      [s.name ?? 'section', s.address, s.size, s.fileOffset, s.permissions].join(','),
    );
    const bss = metadata.sections.find((s) => s.name === '.bss');
    if (bss)
      layout.push([bss.name, bss.address, bss.size, '-', bss.permissions ?? 'rw-'].join(','));
    // Ghidra's BinaryLoader maps the whole file at one address; ImportDol.java then replaces that single
    // block with the DOL's real sections taken from the same file bytes.
    return {
      args: [
        '-loader',
        'BinaryLoader',
        '-loader-baseAddr',
        '0x0',
        '-processor',
        language,
        '-preScript',
        DOL_IMPORT_SCRIPT,
        metadata.entryPoint,
        ...layout,
      ],
      entry: metadata.entryPoint,
      warnings,
    };
  }

  return { args: [], entry: '-', warnings: [] };
}
