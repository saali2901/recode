#!/usr/bin/env node
import { runCli } from './cli/cli.js';
import { ExitCode } from './core/errors/index.js';

const controller = new AbortController();
let interrupts = 0;
process.on('SIGINT', () => {
  interrupts++;
  if (interrupts > 1) process.exit(ExitCode.Cancelled);
  process.stderr.write(
    '\nInterrupt received: stopping child processes and saving progress (Ctrl+C again to force quit)...\n',
  );
  controller.abort();
});
process.on('SIGTERM', () => controller.abort());

const code = await runCli(process.argv.slice(2), { signal: controller.signal });
process.exit(code);
