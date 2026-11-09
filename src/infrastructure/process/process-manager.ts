import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RecodeError } from '../../core/errors/index.js';
import { prepareSpawn } from './windows-command.js';

export interface RunOptions {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Hard timeout; the process tree is killed when exceeded. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Text written to stdin, then stdin is closed. */
  stdin?: string;
  /** Combined stdout/stderr transcript is appended here. */
  logFile?: string;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /** Maximum bytes of stdout/stderr kept in memory (default 4 MiB each). */
  maxCaptureBytes?: number;
}

export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  /** True if captured output was truncated to maxCaptureBytes. */
  truncated: boolean;
}

export function succeeded(result: RunResult): boolean {
  return result.exitCode === 0 && !result.timedOut && !result.aborted;
}

class LineSplitter {
  private pending = '';
  constructor(private readonly emit: (line: string) => void) {}
  push(chunk: string): void {
    this.pending += chunk;
    let index = this.pending.indexOf('\n');
    while (index >= 0) {
      this.emit(this.pending.slice(0, index).replace(/\r$/, ''));
      this.pending = this.pending.slice(index + 1);
      index = this.pending.indexOf('\n');
    }
  }
  flush(): void {
    if (this.pending.length > 0) this.emit(this.pending);
    this.pending = '';
  }
}

class BoundedBuffer {
  private text = '';
  truncated = false;
  constructor(private readonly limit: number) {}
  append(chunk: string): void {
    if (this.text.length >= this.limit) {
      this.truncated = true;
      return;
    }
    this.text += chunk;
    if (this.text.length > this.limit) {
      this.text = this.text.slice(0, this.limit);
      this.truncated = true;
    }
  }
  toString(): string {
    return this.text;
  }
}

/** Kills a child and its descendants. POSIX: process group; Windows: taskkill. */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

/**
 * Runs an external program without a shell. Arguments are passed as an array and never
 * interpolated. The child runs in its own process group so that timeouts and aborts
 * terminate the whole tree.
 */
export async function runProcess(options: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const target = await prepareSpawn(options.command, options.args, options.env ?? process.env);
  const limit = options.maxCaptureBytes ?? 4 * 1024 * 1024;
  const stdout = new BoundedBuffer(limit);
  const stderr = new BoundedBuffer(limit);

  let logStream: ReturnType<typeof createWriteStream> | undefined;
  if (options.logFile) {
    await fs.mkdir(path.dirname(options.logFile), { recursive: true });
    logStream = createWriteStream(options.logFile, { flags: 'a' });
    logStream.write(`$ ${options.command} ${options.args.join(' ')}\n`);
  }

  return new Promise<RunResult>((resolve, reject) => {
    if (options.signal?.aborted) {
      logStream?.end();
      resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        aborted: true,
        durationMs: 0,
        stdout: '',
        stderr: '',
        truncated: false,
      });
      return;
    }

    const child = spawn(target.command, target.args, {
      windowsVerbatimArguments: target.windowsVerbatimArguments,
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let timedOut = false;
    let aborted = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const terminate = (): void => {
      killTree(child, 'SIGTERM');
      killTimer = setTimeout(() => killTree(child, 'SIGKILL'), 3000);
      killTimer.unref();
    };

    const timeout = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          terminate();
        }, options.timeoutMs)
      : undefined;

    const onAbort = (): void => {
      aborted = true;
      terminate();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const outLines = new LineSplitter((line) => options.onStdoutLine?.(line));
    const errLines = new LineSplitter((line) => options.onStderrLine?.(line));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout.append(chunk);
      logStream?.write(chunk);
      outLines.push(chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr.append(chunk);
      logStream?.write(chunk);
      errLines.push(chunk);
    });

    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
    };

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      logStream?.end();
      reject(
        new RecodeError('TOOL_FAILED', `Cannot start "${options.command}": ${error.message}`, {
          cause: error,
        }),
      );
    });

    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      outLines.flush();
      errLines.flush();
      logStream?.write(`\n[exit ${exitCode ?? signal}]\n`);
      logStream?.end();
      resolve({
        exitCode,
        signal,
        timedOut,
        aborted,
        durationMs: Date.now() - started,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        truncated: stdout.truncated || stderr.truncated,
      });
    });

    child.stdin.on('error', () => {
      // Child may exit before reading stdin; the close handler reports the outcome.
    });
    child.stdin.end(options.stdin ?? '');
  });
}

/** Limits the number of concurrently running tasks. */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (limit < 1) throw new RangeError('Concurrency limit must be at least 1.');
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}
