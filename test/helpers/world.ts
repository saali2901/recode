import fs from 'node:fs/promises';
import path from 'node:path';
import { Writable } from 'node:stream';
import { vi } from 'vitest';
import { runCli } from '../../src/cli/cli.js';
import type { Runtime } from '../../src/cli/runtime.js';
import { MOCK_CLAUDE, installFakeGhidra } from './tools.js';
import { makeTempDir } from './tmp.js';

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

class Collector extends Writable {
  text = '';
  override _write(chunk: Buffer, _encoding: string, callback: () => void): void {
    this.text += chunk.toString();
    callback();
  }
}

export interface World {
  root: string;
  workDir: string;
  projectDir: string;
  claudeLog: string;
  ghidraLog: string;
  run(
    args: string[],
    options?: { cwd?: string; overrides?: Runtime['overrides']; signal?: AbortSignal },
  ): Promise<CliRun>;
  setEnv(name: string, value: string | undefined): void;
  claudeInvocations(): Promise<Array<{ args: string[]; prompt: string; cwd: string }>>;
}

/**
 * A hermetic environment: fake Ghidra, mock Claude CLI, isolated user config. Real tools used:
 * the C compiler, CMake and Ninja.
 */
export async function createWorld(options: { project?: boolean } = {}): Promise<World> {
  const root = await makeTempDir();
  const ghidra = await installFakeGhidra(root);
  const claudeLog = path.join(root, 'claude-invocations.jsonl');
  const ghidraLog = path.join(root, 'ghidra-invocations.jsonl');
  const stateDir = path.join(root, 'mock-state');
  await fs.mkdir(stateDir, { recursive: true });
  const workDir = path.join(root, 'work');
  await fs.mkdir(workDir);

  vi.stubEnv('RECODE_HOME', path.join(root, 'recode-home'));
  vi.stubEnv('GHIDRA_INSTALL_DIR', ghidra.installDir);
  vi.stubEnv('RECODE_CLAUDE_COMMAND', MOCK_CLAUDE);
  vi.stubEnv('FAKE_GHIDRA_FUNCTIONS', ghidra.env['FAKE_GHIDRA_FUNCTIONS']);
  vi.stubEnv('FAKE_GHIDRA_LOG', ghidraLog);
  vi.stubEnv('MOCK_LOG', claudeLog);
  vi.stubEnv('MOCK_STATE_DIR', stateDir);
  vi.stubEnv('MOCK_CLAUDE_MODE', 'ok');
  vi.stubEnv('FAKE_GHIDRA_MODE', 'ok');
  vi.stubEnv('RECODE_PROJECT', undefined);

  const world: World = {
    root,
    workDir,
    projectDir: path.join(workDir, 'proj'),
    claudeLog,
    ghidraLog,
    setEnv: (name, value) => vi.stubEnv(name, value),
    async run(args, runOptions = {}) {
      const stdout = new Collector();
      const stderr = new Collector();
      const code = await runCli(args, {
        cwd: runOptions.cwd ?? world.projectDir,
        streams: { stdout, stderr },
        interactive: false,
        ...(runOptions.overrides ? { overrides: runOptions.overrides } : {}),
        ...(runOptions.signal ? { signal: runOptions.signal } : {}),
      });
      return { code, stdout: stdout.text, stderr: stderr.text };
    },
    async claudeInvocations() {
      const text = await fs.readFile(claudeLog, 'utf8').catch(() => '');
      return text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { args: string[]; prompt: string; cwd: string })
        .filter((entry) => entry.args.includes('--print'));
    },
  };

  if (options.project !== false) {
    const init = await world.run(['init', 'proj'], { cwd: workDir });
    if (init.code !== 0) throw new Error(`init failed: ${init.stderr}`);
  }
  return world;
}
