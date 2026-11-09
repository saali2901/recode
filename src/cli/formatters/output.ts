import pc from 'picocolors';
import type { RecodeEvent } from '../../core/events/event-bus.js';

export interface OutputStreams {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

/** All terminal output goes through here so commands stay testable and consistent. */
export class Output {
  constructor(
    private readonly streams: OutputStreams = { stdout: process.stdout, stderr: process.stderr },
    private readonly verbose = false,
  ) {}

  line(text = ''): void {
    this.streams.stdout.write(`${text}\n`);
  }
  info(text: string): void {
    this.line(`${pc.cyan('i')} ${text}`);
  }
  success(text: string): void {
    this.line(`${pc.green('✓')} ${text}`);
  }
  warn(text: string): void {
    this.streams.stderr.write(`${pc.yellow('!')} ${text}\n`);
  }
  error(text: string): void {
    this.streams.stderr.write(`${pc.red('✗')} ${text}\n`);
  }
  hint(text: string): void {
    for (const line of text.split('\n')) this.streams.stderr.write(`  ${pc.dim(line)}\n`);
  }
  json(value: unknown): void {
    this.line(JSON.stringify(value, null, 2));
  }

  table(rows: string[][], header?: string[]): void {
    const all = header ? [header, ...rows] : rows;
    const widths =
      all[0]?.map((_, col) => Math.max(...all.map((r) => (r[col] ?? '').length))) ?? [];
    const render = (row: string[]): string =>
      row
        .map((cell, i) => cell.padEnd(widths[i] ?? 0))
        .join('  ')
        .trimEnd();
    if (header) {
      this.line(pc.bold(render(header)));
    }
    for (const row of rows) this.line(render(row));
  }

  /** Renders a workflow event as one progress line. */
  event(event: RecodeEvent): void {
    switch (event.type) {
      case 'step-started':
        this.line(`${pc.blue('▶')} ${event.step} (${event.binaryId})`);
        break;
      case 'step-completed':
        this.line(
          `${pc.green('■')} ${event.step} ${event.skipped ? pc.dim('up to date, skipped (use --force to rerun)') : 'done'}`,
        );
        break;
      case 'step-failed':
        this.line(`${pc.red('■')} ${event.step} failed`);
        break;
      case 'info':
        this.info(event.message);
        break;
      case 'warning':
        this.warn(event.message);
        break;
      case 'task-started':
        if (this.verbose) this.line(pc.dim(`  … ${event.label}`));
        break;
      case 'task-completed':
        this.line(`  ${pc.green('✓')} ${event.label}`);
        break;
      case 'task-failed':
        this.line(`  ${pc.red('✗')} ${event.label}: ${event.message}`);
        break;
      case 'agent-activity':
        this.line(pc.dim(`  ↳ ${event.agent}: ${event.summary}`));
        break;
    }
  }
}
