import { Command, CommanderError } from 'commander';
import { ExitCode, RecodeError, toRecodeError } from '../core/errors/index.js';
import { registerConfig } from './commands/config.js';
import { registerDoctor } from './commands/doctor.js';
import { registerImport } from './commands/import.js';
import { registerInit } from './commands/init.js';
import { registerInspect } from './commands/inspect.js';
import { registerLogs } from './commands/logs.js';
import { registerStatus } from './commands/status.js';
import { registerUi } from './commands/ui.js';
import { registerStepCommands } from './commands/steps.js';
import { Output, type OutputStreams } from './formatters/output.js';
import { createRuntime, type Runtime } from './runtime.js';

export interface CliOptions {
  cwd?: string;
  streams?: OutputStreams;
  signal?: AbortSignal;
  overrides?: Runtime['overrides'];
  interactive?: boolean;
}

export const VERSION = '0.1.0';

/** Builds the command tree. Exposed separately so tests can run commands in-process. */
export function buildProgram(
  runtime: Runtime,
  getProject: { value?: string },
  streams: OutputStreams,
): Command {
  const program = new Command();
  program
    .name('recode')
    .description(
      'Local AI-assisted reverse engineering: Binary → Ghidra → Claude Code → C → build → validation',
    )
    .version(VERSION)
    .option(
      '-p, --project <dir>',
      'project directory (default: nearest parent containing recode.json)',
    )
    .option('-v, --verbose', 'show more progress details')
    .showHelpAfterError('(run with --help for usage)')
    .configureOutput({
      writeOut: (text) => streams.stdout.write(text),
      writeErr: (text) => streams.stderr.write(text),
    })
    .exitOverride()
    .hook('preAction', (command) => {
      getProject.value = command.optsWithGlobals<{ project?: string }>().project;
    });

  registerInit(program, runtime);
  registerImport(program, runtime);
  registerInspect(program, runtime);
  registerStepCommands(program, runtime);
  registerStatus(program, runtime);
  registerLogs(program, runtime);
  registerDoctor(program, runtime);
  registerConfig(program, runtime);
  registerUi(program, runtime);
  return program;
}

/** Runs the CLI and returns the process exit code; never throws. */
export async function runCli(argv: readonly string[], options: CliOptions = {}): Promise<number> {
  const streams = options.streams ?? { stdout: process.stdout, stderr: process.stderr };
  const out = new Output(streams, argv.includes('--verbose') || argv.includes('-v'));
  const holder: { value?: string } = {};
  const runtime = createRuntime({
    out,
    cwd: options.cwd ?? process.cwd(),
    signal: options.signal ?? new AbortController().signal,
    ...(options.overrides ? { overrides: options.overrides } : {}),
    ...(options.interactive !== undefined ? { interactive: options.interactive } : {}),
    getGlobalProject: () => holder.value,
  });
  const program = buildProgram(runtime, holder, streams);
  process.exitCode = undefined;

  try {
    await program.parseAsync(argv as string[], { from: 'user' });
    const code = process.exitCode as number | undefined;
    process.exitCode = undefined;
    return code ?? ExitCode.Ok;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version')
        return ExitCode.Ok;
      return ExitCode.Usage;
    }
    const failure = error instanceof RecodeError ? error : toRecodeError(error);
    out.error(failure.message);
    if (failure.hint) out.hint(failure.hint);
    return failure.exitCode;
  }
}
