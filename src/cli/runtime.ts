import readline from 'node:readline/promises';
import { createContext, type AppContext } from '../app/context.js';
import type { PipelineDeps } from '../app/pipeline.js';
import type { Output } from './formatters/output.js';

/** Per-invocation services shared by all commands. */
export interface Runtime {
  out: Output;
  cwd: string;
  signal: AbortSignal;
  /** Test hooks: replace Ghidra / Claude by fakes. */
  overrides: Partial<Pick<PipelineDeps, 'decompiler' | 'sessionRunner' | 'skipPrerequisites'>>;
  /** Opens the project (global --project option included) with logging and event output wired. */
  context(projectDir?: string): Promise<AppContext>;
  /** Asks a question on the terminal; returns undefined when not interactive. */
  prompt(question: string): Promise<string | undefined>;
  isInteractive: boolean;
}

export function createRuntime(options: {
  out: Output;
  cwd: string;
  signal: AbortSignal;
  overrides?: Runtime['overrides'];
  interactive?: boolean;
  getGlobalProject: () => string | undefined;
}): Runtime {
  const isInteractive =
    options.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  return {
    out: options.out,
    cwd: options.cwd,
    signal: options.signal,
    overrides: options.overrides ?? {},
    isInteractive,
    async context(projectDir) {
      const context = await createContext({
        projectDir: projectDir ?? options.getGlobalProject(),
        cwd: options.cwd,
        signal: options.signal,
      });
      context.events.subscribe((event) => options.out.event(event));
      return context;
    },
    async prompt(question) {
      if (!isInteractive) return undefined;
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        return (await rl.question(`${question} `)).trim();
      } finally {
        rl.close();
      }
    },
  };
}
