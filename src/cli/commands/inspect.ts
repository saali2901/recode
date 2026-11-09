import path from 'node:path';
import type { Command } from 'commander';
import { loadFunctions } from '../../decompiler/extraction/analysis-files.js';
import { pathExists } from '../../infrastructure/filesystem/files.js';
import type { Runtime } from '../runtime.js';

export function registerInspect(program: Command, runtime: Runtime): void {
  program
    .command('inspect')
    .description('Show format, architecture, sections and symbols of an imported binary')
    .option('--binary <id>', 'binary id (required if the project has several)')
    .option('--symbols', 'also list symbols from the file headers')
    .option('--json', 'machine-readable output')
    .action(async (options: { binary?: string; symbols?: boolean; json?: boolean }) => {
      const { project } = await runtime.context();
      const record = project.resolveBinary(options.binary);
      const m = record.metadata;
      const analysisDir = project.analysisDir(record.id);
      const hasAnalysis = await pathExists(path.join(analysisDir, 'functions.json'));
      const functions = hasAnalysis ? await loadFunctions(analysisDir) : undefined;

      if (options.json) {
        runtime.out.json({
          id: record.id,
          file: record.fileName,
          sha256: record.sha256,
          size: record.size,
          metadata: m,
          functionCount: functions?.length,
        });
        return;
      }
      const out = runtime.out;
      out.line(`Binary:        ${record.id}  (${record.fileName}, ${record.size} bytes)`);
      out.line(`SHA-256:       ${record.sha256}`);
      out.line(
        `Format:        ${m.format} (${m.kind})${m.source === 'user' ? '  [supplied by user]' : ''}`,
      );
      out.line(`Architecture:  ${m.architecture}, ${m.bits}-bit, ${m.endianness}-endian`);
      if (m.platform) out.line(`Platform:      ${m.platform}`);
      if (m.game) {
        out.line(
          `Game:          ${m.game.title} (${m.game.gameId}${m.game.region ? `, ${m.game.region}` : ''})`,
        );
      }
      out.line(`Entry point:   ${m.entryPoint ?? '(none)'}`);
      out.line(`Base address:  ${m.baseAddress ?? '(unknown)'}`);
      for (const warning of m.warnings) out.warn(warning);
      if (m.sections.length > 0) {
        out.line();
        out.table(
          m.sections.map((s) => [s.name, s.address, s.size, s.permissions ?? '']),
          ['Section', 'Address', 'Size', 'Perm'],
        );
      }
      if (m.segments.length > 0) {
        out.line();
        out.table(
          m.segments.map((s) => [s.name ?? '', s.address, s.size, s.permissions]),
          ['Segment', 'Address', 'Size', 'Perm'],
        );
      }
      out.line();
      out.line(
        `Symbols in headers: ${m.symbols.length}${m.symbolsTruncated ? '+ (truncated)' : ''}`,
      );
      if (options.symbols) {
        out.table(
          m.symbols.map((s) => [s.name, s.address, s.type]),
          ['Name', 'Address', 'Type'],
        );
      }
      out.line(
        functions
          ? `Analysis: ${functions.length} functions (see analysis/${record.id}/)`
          : 'Analysis: not run yet (recode analyze)',
      );
    });
}
