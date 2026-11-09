import fs from 'node:fs/promises';
import path from 'node:path';
import { parseStreamLine } from '../ai/claude/events.js';

export interface TailedLine {
  file: string;
  line: string;
}

const MAX_LINE = 1500;

/** Turns a raw log line into a readable one; stream-json from Claude Code is summarized. */
export function renderLogLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (trimmed === '') return undefined;
  if (!trimmed.startsWith('{')) return trimmed.slice(0, MAX_LINE);
  const events = parseStreamLine(trimmed);
  const parts: string[] = [];
  for (const event of events) {
    if (event.kind === 'text')
      parts.push(`${event.subagent ? '  [subagent] ' : ''}${event.text.replace(/\s+/g, ' ')}`);
    else if (event.kind === 'tool-use')
      parts.push(
        `${event.subagent ? '  [subagent] ' : ''}→ ${event.name}${event.summary ? ` ${event.summary}` : ''}`,
      );
    else if (event.kind === 'result')
      parts.push(`session ${event.ok ? 'finished' : 'failed'} (${event.subtype})`);
    else if (event.kind === 'init')
      parts.push(`session started${event.model ? ` (${event.model})` : ''}`);
  }
  return parts.length > 0 ? parts.join('\n').slice(0, MAX_LINE) : undefined;
}

/**
 * Follows the tool transcripts in a project's log directory (Ghidra, Claude Code, build) and
 * reports lines written after `start()`. `recode.log` (structured events) is excluded.
 */
export class LogTailer {
  private readonly offsets = new Map<string, number>();
  private readonly partial = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly directory: string,
    private readonly onLine: (line: TailedLine) => void,
    private readonly intervalMs = 300,
  ) {}

  async start(): Promise<void> {
    for (const name of await this.logFiles()) {
      const stat = await fs.stat(path.join(this.directory, name)).catch(() => undefined);
      this.offsets.set(name, stat?.size ?? 0);
    }
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.poll();
  }

  private async logFiles(): Promise<string[]> {
    const names = await fs.readdir(this.directory).catch(() => []);
    return names.filter((n) => n.endsWith('.log') && n !== 'recode.log');
  }

  private async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const name of await this.logFiles()) await this.readNew(name);
    } finally {
      this.running = false;
    }
  }

  private async readNew(name: string): Promise<void> {
    const file = path.join(this.directory, name);
    const stat = await fs.stat(file).catch(() => undefined);
    if (!stat) return;
    const offset = this.offsets.get(name) ?? 0;
    if (stat.size <= offset) return;
    const length = Math.min(stat.size - offset, 512 * 1024);
    const handle = await fs.open(file, 'r');
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, offset);
      this.offsets.set(name, offset + length);
      const text = (this.partial.get(name) ?? '') + buffer.toString('utf8');
      const lines = text.split('\n');
      this.partial.set(name, lines.pop() ?? '');
      for (const raw of lines) {
        const line = renderLogLine(raw);
        if (line !== undefined) this.onLine({ file: name, line });
      }
    } finally {
      await handle.close();
    }
  }
}
