import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';

const created: string[] = [];

/** Creates a temp directory that is removed after the current test. */
export async function makeTempDir(prefix = 'recode-test-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function registerTempCleanup(): void {
  afterEach(async () => {
    await Promise.all(created.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });
}
