import type { Command } from 'commander';
import { RecodeError } from '../../core/errors/index.js';
import { WorkflowManager } from '../../core/workflow/workflow.js';
import { createDefaultRegistry } from '../../input/adapters/registry.js';
import { RAW_OPTION_HELP } from '../../input/adapters/raw-adapter.js';
import { ImportService } from '../../input/import-service.js';
import {
  ArchitectureSchema,
  RawBinaryOptionsSchema,
  type MetadataHints,
} from '../../input/interfaces/types.js';
import { prepareFingerprint } from '../../app/pipeline.js';
import { writeJsonAtomic } from '../../infrastructure/filesystem/files.js';
import path from 'node:path';
import type { Runtime } from '../runtime.js';

interface ImportCliOptions {
  raw?: boolean;
  arch?: string;
  endian?: string;
  bits?: string;
  base?: string;
  entry?: string;
}

function normalizeHex(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
}

async function collectRawHints(
  runtime: Runtime,
  options: ImportCliOptions,
): Promise<MetadataHints> {
  const ask = async (
    label: string,
    current: string | undefined,
    choices?: string,
  ): Promise<string | undefined> =>
    current ?? (await runtime.prompt(`${label}${choices ? ` (${choices})` : ''}:`)) ?? undefined;

  const arch = await ask(
    'Architecture',
    options.arch,
    ArchitectureSchema.options.filter((a) => a !== 'unknown').join('|'),
  );
  const endian = await ask('Endianness', options.endian, 'little|big');
  const bits = await ask('Bits', options.bits, '16|32|64');
  const base = await ask('Base address (hex)', options.base);
  const entry =
    options.entry ?? ((await runtime.prompt('Entry point (hex, empty = none):')) || undefined);

  const parsed = RawBinaryOptionsSchema.safeParse({
    architecture: arch,
    endianness: endian,
    bits: bits === undefined ? undefined : Number.parseInt(bits, 10),
    baseAddress: base === undefined ? undefined : normalizeHex(base),
    ...(entry ? { entryPoint: normalizeHex(entry) } : {}),
  });
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => i.path.join('.') || 'value').join(', ');
    throw new RecodeError(
      'INVALID_INPUT',
      `Raw binary information is missing or invalid (${problems}).`,
      {
        hint: RAW_OPTION_HELP,
      },
    );
  }
  return { raw: parsed.data };
}

export function registerImport(program: Command, runtime: Runtime): void {
  program
    .command('import <path>')
    .description(
      'Import a binary, ZIP archive or reference file (source, header, JSON, YAML, TXT, MAP) into the project',
    )
    .option('--raw', 'treat the file as a headerless raw binary')
    .option(
      '--arch <arch>',
      'raw: processor architecture (x86, x86_64, arm, aarch64, mips, mips64, ppc, ppc64, riscv32, riscv64)',
    )
    .option('--endian <endianness>', 'raw: little or big')
    .option('--bits <bits>', 'raw: 16, 32 or 64')
    .option('--base <address>', 'raw: memory base address (hex)')
    .option('--entry <address>', 'raw: entry point address (hex)')
    .action(async (file: string, options: ImportCliOptions) => {
      const { project, config, events } = await runtime.context();
      await project.withLock(async () => {
        const registry = createDefaultRegistry(config.archive);
        const service = new ImportService(project, registry);
        const absolute = path.resolve(runtime.cwd, file);
        const detection = await service.detect(absolute).catch(() => undefined);
        const needsRaw = options.raw === true || detection?.format === 'raw';
        const hints = needsRaw ? await collectRawHints(runtime, options) : undefined;

        const report = await service.import(absolute, {
          ...(hints ? { hints } : {}),
          ...(options.raw ? { forceRaw: true } : {}),
        });

        runtime.out.info(`Detected: ${report.detection.description}`);
        for (const reference of report.references)
          runtime.out.success(`Stored reference file ${path.relative(project.root, reference)}`);
        for (const { record, created } of report.binaries) {
          const m = record.metadata;
          runtime.out.success(
            `${created ? 'Imported' : 'Already imported'} ${record.id}: ${m.format.toUpperCase()} ${m.kind}, ${m.architecture} ${m.bits}-bit ${m.endianness}-endian` +
              (m.entryPoint ? `, entry ${m.entryPoint}` : ''),
          );
          for (const warning of m.warnings) runtime.out.warn(warning);
          const workflow = new WorkflowManager(project.workflowFile(record.id), record.id, events);
          await workflow.markCompleted('prepare', prepareFingerprint(record), 'imported');
          await writeJsonAtomic(path.join(project.analysisDir(record.id), 'metadata.json'), m);
        }
      });
    });
}
