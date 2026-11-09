import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { makeTempDir, registerTempCleanup } from '../helpers/tmp.js';

registerTempCleanup();
const exec = promisify(execFile);
const script = path.resolve('install.sh');

async function bash(
  args: string[],
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await exec('bash', [script, ...args], {
      env: { ...process.env, ...env },
      timeout: 120_000,
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

describe('install.sh', () => {
  it('is valid bash and shows its help', async () => {
    await exec('bash', ['-n', script]);
    const help = await bash(['--help'], {});
    expect(help.stdout).toContain('curl -fsSL');
  });

  it('rejects unknown options', async () => {
    expect((await bash(['--bogus'], {})).code).toBe(2);
  });

  it('dry run prints every step and changes nothing', async () => {
    const root = await makeTempDir();
    const result = await bash(['--dry-run', '-y'], {
      RECODE_HOME_DIR: path.join(root, 'data'),
      RECODE_BIN_DIR: path.join(root, 'bin'),
      RECODE_REPO: 'https://example.invalid/recode.git',
    });
    expect(result.code, result.stderr).toBe(0);
    for (const step of [
      'git clone',
      'npm ci && npm run build',
      'would write',
      'would run: recode setup',
    ]) {
      expect(result.stdout).toContain(step);
    }
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('asks before doing anything and cancels without a terminal confirmation', async () => {
    const root = await makeTempDir();
    // No -y and no controlling terminal: the installer must refuse instead of proceeding silently.
    const result = await exec('setsid', ['bash', script, '--dry-run'], {
      env: {
        ...process.env,
        RECODE_HOME_DIR: path.join(root, 'data'),
        RECODE_BIN_DIR: path.join(root, 'bin'),
      },
      timeout: 60_000,
    }).then(
      (r) => ({ ...r, code: 0 }),
      (e: { stderr?: string; code?: number }) => ({
        stdout: '',
        stderr: e.stderr ?? '',
        code: e.code ?? 1,
      }),
    );
    expect(result.code).not.toBe(0);
    expect(await fs.readdir(root)).toEqual([]);
  });
});

/**
 * Optional: a real installation (downloads Node.js and npm packages, builds ReCode) from the local git repository.
 * Enable with: RECODE_TEST_INSTALL=1 npx vitest run test/integration/installer.test.ts
 */
describe.skipIf(process.env['RECODE_TEST_INSTALL'] !== '1')(
  'install.sh real run (optional)',
  () => {
    it(
      'installs a working recode command with a private Node.js',
      { timeout: 600_000 },
      async () => {
        const root = await makeTempDir();
        const env = {
          RECODE_HOME_DIR: path.join(root, 'data'),
          RECODE_BIN_DIR: path.join(root, 'bin'),
          RECODE_REPO: path.resolve('.'),
          RECODE_REF: process.env['RECODE_TEST_REF'] ?? 'installer',
          RECODE_FORCE_NODE_DOWNLOAD: '1',
        };
        const result = await bash(['-y', '--no-setup'], env);
        expect(result.code, result.stderr).toBe(0);
        const recode = path.join(root, 'bin', 'recode');
        expect((await exec(recode, ['--version'])).stdout.trim()).toBe('0.1.0');
        expect((await exec(recode, ['setup', '--dry-run'])).stdout).toMatch(
          /Dry run|already installed/,
        );
      },
    );
  },
);
