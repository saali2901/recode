import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConcurrencyLimiter,
  runProcess,
  succeeded,
} from '../../src/infrastructure/process/process-manager.js';
import { which } from '../../src/infrastructure/process/which.js';
import { makeTempDir, registerTempCleanup } from '../helpers/tmp.js';

registerTempCleanup();
const node = process.execPath;

/** A killed process may linger as a zombie until its (re-parented) parent reaps it. */
async function isGone(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
  return stat === '' || /\) Z /.test(stat);
}

describe('runProcess', () => {
  it('captures output, exit code and streams lines', async () => {
    const lines: string[] = [];
    const result = await runProcess({
      command: node,
      args: ['-e', 'console.log("a"); console.error("e"); console.log("b"); process.exit(3)'],
      onStdoutLine: (l) => lines.push(l),
    });
    expect(result).toMatchObject({
      exitCode: 3,
      timedOut: false,
      aborted: false,
      stdout: 'a\nb\n',
      stderr: 'e\n',
    });
    expect(lines).toEqual(['a', 'b']);
    expect(succeeded(result)).toBe(false);
  });

  it('passes arguments without shell interpolation', async () => {
    const hostile = '$(touch /tmp/pwned-by-recode); `id` && echo x';
    const result = await runProcess({
      command: node,
      args: ['-e', 'console.log(process.argv[1])', hostile],
    });
    expect(result.stdout.trim()).toBe(hostile);
  });

  it('writes stdin and logs a transcript', async () => {
    const dir = await makeTempDir();
    const logFile = path.join(dir, 'logs', 'run.log');
    const result = await runProcess({
      command: node,
      args: ['-e', 'process.stdin.pipe(process.stdout)'],
      stdin: 'ping',
      logFile,
    });
    expect(result.stdout).toBe('ping');
    const log = await fs.readFile(logFile, 'utf8');
    expect(log).toContain('ping');
    expect(log).toContain('[exit 0]');
  });

  it('kills the whole process tree on timeout', async () => {
    const dir = await makeTempDir();
    const pidFile = path.join(dir, 'child.pid');
    const script = `
      const { spawn } = require('node:child_process');
      const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
      setInterval(()=>{},1000);`;
    const result = await runProcess({ command: node, args: ['-e', script], timeoutMs: 700 });
    expect(result.timedOut).toBe(true);
    const childPid = Number(await fs.readFile(pidFile, 'utf8'));
    await new Promise((r) => setTimeout(r, 300));
    expect(await isGone(childPid)).toBe(true);
  });

  it('aborts via AbortSignal', async () => {
    const controller = new AbortController();
    const pending = runProcess({
      command: node,
      args: ['-e', 'setInterval(()=>{},1000)'],
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 200);
    const result = await pending;
    expect(result.aborted).toBe(true);
    expect(succeeded(result)).toBe(false);
  });

  it('returns immediately if the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runProcess({
      command: node,
      args: ['-e', 'process.exit(0)'],
      signal: controller.signal,
    });
    expect(result.aborted).toBe(true);
  });

  it('reports a clear error when the program does not exist', async () => {
    await expect(runProcess({ command: '/nonexistent/tool', args: [] })).rejects.toMatchObject({
      code: 'TOOL_FAILED',
    });
  });

  it('truncates captured output beyond the limit', async () => {
    const result = await runProcess({
      command: node,
      args: ['-e', 'process.stdout.write("x".repeat(100000))'],
      maxCaptureBytes: 1000,
    });
    expect(result.stdout.length).toBe(1000);
    expect(result.truncated).toBe(true);
  });
});

describe('ConcurrencyLimiter', () => {
  it('never runs more than the limit at once', async () => {
    const limiter = new ConcurrencyLimiter(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        limiter.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 10));
          active--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });

  it('rejects invalid limits', () => {
    expect(() => new ConcurrencyLimiter(0)).toThrow(RangeError);
  });
});

describe('which', () => {
  it('finds executables on PATH and returns undefined otherwise', async () => {
    expect(await which('node')).toBeTruthy();
    expect(await which('definitely-not-installed-xyz')).toBeUndefined();
  });
});
