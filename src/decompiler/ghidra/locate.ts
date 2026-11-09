import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { which } from '../../infrastructure/process/which.js';

export interface GhidraInstallation {
  installDir: string;
  version: string;
  /** Absolute path of the analyzeHeadless launcher. */
  headlessPath: string;
}

const HEADLESS_NAME = process.platform === 'win32' ? 'analyzeHeadless.bat' : 'analyzeHeadless';

/** Checks that a directory is a Ghidra installation and reads its version. */
export async function inspectInstallation(
  installDir: string,
): Promise<GhidraInstallation | undefined> {
  const headlessPath = path.join(installDir, 'support', HEADLESS_NAME);
  try {
    await fs.access(headlessPath);
    const properties = await fs.readFile(
      path.join(installDir, 'Ghidra', 'application.properties'),
      'utf8',
    );
    const version = /^application\.version=(.+)$/m.exec(properties)?.[1]?.trim();
    return { installDir, version: version ?? 'unknown', headlessPath };
  } catch {
    return undefined;
  }
}

async function globDirectories(parent: string, prefix: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(parent, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && e.name.toLowerCase().startsWith(prefix))
      .map((e) => path.join(parent, e.name))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Locates a Ghidra installation: explicit configuration first, then GHIDRA_INSTALL_DIR,
 * the PATH, and a few conventional installation directories.
 */
export async function findGhidra(
  configuredDir: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GhidraInstallation | undefined> {
  const candidates: string[] = [];
  if (configuredDir) candidates.push(configuredDir);
  if (env['GHIDRA_INSTALL_DIR']) candidates.push(env['GHIDRA_INSTALL_DIR']);

  const onPath = await which(HEADLESS_NAME, env);
  if (onPath) {
    candidates.push(path.dirname(path.dirname(await fs.realpath(onPath))));
  }

  const home = os.homedir();
  for (const parent of ['/opt', '/usr/local', '/usr/share', '/Applications', 'C:\\', home]) {
    candidates.push(...(await globDirectories(parent, 'ghidra')));
  }

  for (const dir of candidates) {
    const installation = await inspectInstallation(dir);
    if (installation) return installation;
  }
  return undefined;
}
