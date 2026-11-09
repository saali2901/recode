import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseElf } from '../../src/input/parsers/elf.js';
import { FileView } from '../../src/input/parsers/binary-reader.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MOCK_CLAUDE = path.join(here, 'mock-claude.mjs');
export const SAMPLE_ELF = path.resolve(here, '../fixtures/build/sample-x86_64');
export const SAMPLE_OBJECT = path.resolve(here, '../fixtures/build/sample.o');

const CALLS: Record<string, string[]> = {
  sum_areas: ['add_ints', 'shape_area'],
  shape_area: ['multiply', 'square'],
  square: ['multiply'],
  main: ['sum_areas'],
};
const WANTED = ['add_ints', 'multiply', 'square', 'shape_area', 'sum_areas', 'main'];

/** Installs a fake Ghidra directory whose analyzeHeadless is the test double. Returns env for runs. */
export async function installFakeGhidra(
  root: string,
  elfPath = SAMPLE_ELF,
): Promise<{ installDir: string; env: Record<string, string> }> {
  const installDir = path.join(root, 'ghidra_99.0_MOCK');
  await fs.mkdir(path.join(installDir, 'support'), { recursive: true });
  await fs.mkdir(path.join(installDir, 'Ghidra'), { recursive: true });
  await fs.writeFile(
    path.join(installDir, 'Ghidra', 'application.properties'),
    'application.version=99.0\n',
  );
  const launcher = path.join(installDir, 'support', 'analyzeHeadless');
  await fs.writeFile(
    launcher,
    `#!/bin/sh\nexec "${process.execPath}" "${path.join(here, 'fake-ghidra.mjs')}" "$@"\n`,
  );
  await fs.chmod(launcher, 0o755);

  const view = FileView.open(elfPath);
  const metadata = parseElf(view);
  view.close();
  const table = WANTED.map((name) => {
    const symbol = metadata.symbols.find((s) => s.name === name);
    if (!symbol) throw new Error(`fixture lacks symbol ${name}`);
    return {
      name,
      address: symbol.address,
      size: Number.parseInt(symbol.size ?? '0x10', 16),
      calls: CALLS[name] ?? [],
    };
  });
  const tableFile = path.join(root, 'fake-ghidra-functions.json');
  await fs.writeFile(tableFile, JSON.stringify(table));
  return { installDir, env: { FAKE_GHIDRA_FUNCTIONS: tableFile } };
}
