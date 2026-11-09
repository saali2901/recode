import fs from 'node:fs/promises';
import type { Command } from 'commander';
import { RecodeError } from '../../core/errors/index.js';
import { safeJoin } from '../../infrastructure/filesystem/paths.js';
import type { Runtime } from '../runtime.js';

export function registerLogs(program: Command, runtime: Runtime): void {
  program
    .command('logs')
    .description(
      'Show ReCode logs (default) or tool transcripts of Ghidra, Claude Code and the build',
    )
    .option('--list', 'list available log files')
    .option('--file <name>', 'show a specific log file from the list')
    .option('-n, --lines <count>', 'number of lines from the end', '50')
    .action(async (options: { list?: boolean; file?: string; lines: string }) => {
      const { project } = await runtime.context();
      const dir = project.paths.logs;
      const files = (await fs.readdir(dir).catch(() => [])).sort();
      if (options.list) {
        for (const file of files) runtime.out.line(file);
        return;
      }
      const count = Number.parseInt(options.lines, 10);
      if (!Number.isInteger(count) || count < 1) {
        throw new RecodeError('INVALID_INPUT', '--lines must be a positive integer.');
      }
      const name = options.file ?? 'recode.log';
      const file = safeJoin(dir, name);
      const content = await fs.readFile(file, 'utf8').catch(() => {
        throw new RecodeError('INVALID_INPUT', `Log file ${name} not found.`, {
          hint: `Available: ${files.join(', ') || '(none)'}`,
        });
      });
      runtime.out.line(content.trimEnd().split('\n').slice(-count).join('\n'));
    });
}
