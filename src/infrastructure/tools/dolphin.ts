import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RecodeError } from '../../core/errors/index.js';
import type { ConvertedDisc, DiscConverter } from '../../input/interfaces/types.js';
import { runProcess, succeeded } from '../process/process-manager.js';
import { which } from '../process/which.js';

/** Names under which Dolphin's command-line tool is shipped (Linux packages vs. Windows/macOS builds). */
const DEFAULT_COMMANDS = ['dolphin-tool', 'DolphinTool'];
const CONVERT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Converts compressed GameCube discs to a plain ISO with `dolphin-tool convert -f iso`. The ISO (about 1.4 GB)
 * is written to a private temporary directory and removed by `dispose`.
 */
export class DolphinToolConverter implements DiscConverter {
  constructor(
    private readonly configuredCommand?: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async locate(): Promise<string | undefined> {
    const candidates = this.configuredCommand ? [this.configuredCommand] : DEFAULT_COMMANDS;
    for (const candidate of candidates) {
      const found = await which(candidate, this.env);
      if (found) return found;
    }
    return undefined;
  }

  async convertToIso(source: string, signal?: AbortSignal): Promise<ConvertedDisc> {
    const command = await this.locate();
    if (!command) {
      throw new RecodeError(
        'PREREQUISITE',
        "Compressed discs need Dolphin's command-line tool, which was not found.",
        {
          hint: 'Install Dolphin (it ships "dolphin-tool"/"DolphinTool") and put it on PATH, set "tools.dolphinToolCommand" with "recode config set", or convert the disc to ISO yourself.',
        },
      );
    }
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recode-disc-'));
    const isoPath = path.join(directory, 'disc.iso');
    const dispose = (): Promise<void> => fs.rm(directory, { recursive: true, force: true });
    try {
      const result = await runProcess({
        command,
        args: ['convert', '-i', source, '-o', isoPath, '-f', 'iso'],
        env: this.env,
        timeoutMs: CONVERT_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      });
      if (result.aborted) throw new RecodeError('CANCELLED', 'Disc conversion was cancelled.');
      if (result.timedOut) {
        throw new RecodeError('TOOL_FAILED', 'Converting the disc took longer than 30 minutes.');
      }
      if (!succeeded(result)) {
        throw new RecodeError(
          'TOOL_FAILED',
          `Dolphin could not convert ${path.basename(source)} (exit code ${result.exitCode}).`,
          { hint: (result.stderr || result.stdout).trim().split('\n').slice(-5).join('\n') },
        );
      }
      await fs.access(isoPath).catch(() => {
        throw new RecodeError('TOOL_FAILED', 'Dolphin finished but produced no ISO file.');
      });
    } catch (error) {
      await dispose();
      throw error;
    }
    return { isoPath, dispose };
  }
}
