import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadFunctions } from '../../src/decompiler/extraction/analysis-files.js';
import { GhidraDecompiler } from '../../src/decompiler/ghidra/ghidra-decompiler.js';
import { findGhidra } from '../../src/decompiler/ghidra/locate.js';
import { parseElf } from '../../src/input/parsers/elf.js';
import { FileView } from '../../src/input/parsers/binary-reader.js';
import { SAMPLE_ELF } from '../helpers/tools.js';
import { makeTempDir, registerTempCleanup } from '../helpers/tmp.js';

registerTempCleanup();

/**
 * Optional test against a REAL Ghidra installation.
 * Enable with: GHIDRA_INSTALL_DIR=/path/to/ghidra RECODE_TEST_GHIDRA=1 npm run test:ghidra
 */
const enabled = process.env['RECODE_TEST_GHIDRA'] === '1';

describe.skipIf(!enabled)('real Ghidra installation (optional)', () => {
  it(
    'analyzes the compiled sample and exports functions, call graph and decompiler output',
    { timeout: 15 * 60_000 },
    async () => {
      const installation = await findGhidra(process.env['GHIDRA_INSTALL_DIR']);
      expect(installation, 'Ghidra not found; set GHIDRA_INSTALL_DIR').toBeDefined();

      const root = await makeTempDir();
      const view = FileView.open(SAMPLE_ELF);
      const metadata = parseElf(view);
      view.close();
      const decompiler = new GhidraDecompiler({
        installDir: installation?.installDir,
        javaCommand: 'java',
      });
      const out = path.join(root, 'analysis');
      const summary = await decompiler.analyze({
        binaryPath: SAMPLE_ELF,
        metadata,
        outputDirectory: out,
        workDirectory: path.join(root, 'work'),
        logFile: path.join(root, 'ghidra.log'),
        timeoutSeconds: 600,
        maxFunctions: 1000,
      });
      expect(summary.functionCount).toBeGreaterThan(5);

      const functions = await loadFunctions(out);
      const byName = new Map(functions.map((f) => [f.name, f]));
      for (const name of ['add_ints', 'multiply', 'square', 'shape_area', 'sum_areas', 'main']) {
        expect(byName.has(name), `function ${name}`).toBe(true);
      }
      const sumAreas = byName.get('sum_areas');
      expect(sumAreas?.calls).toEqual(
        expect.arrayContaining([
          byName.get('add_ints')?.address,
          byName.get('shape_area')?.address,
        ]),
      );
      const code = await fs.readFile(path.join(out, sumAreas?.decompiledFile ?? 'missing'), 'utf8');
      expect(code).toContain('sum_areas');
    },
  );
});
