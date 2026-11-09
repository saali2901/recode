import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RecodeError } from '../../core/errors/index.js';
import { assetPath } from '../../infrastructure/filesystem/assets.js';
import { pathExists } from '../../infrastructure/filesystem/files.js';
import { runProcess, succeeded } from '../../infrastructure/process/process-manager.js';
import { validateAnalysisDirectory } from '../extraction/analysis-files.js';
import type { DecompileRequest, DecompileSummary, Decompiler } from '../interfaces/decompiler.js';
import { findGhidra, type GhidraInstallation } from './locate.js';
import { ghidraLanguageId } from './language.js';

export const SCRIPT_NAME = 'ExportAnalysis.java';

/** Directory containing the bundled Ghidra scripts. */
export function bundledScriptDirectory(): string {
  return path.dirname(assetPath('src', 'decompiler', 'scripts', SCRIPT_NAME));
}

export interface GhidraOptions {
  installDir?: string | undefined;
  javaCommand: string;
  env?: NodeJS.ProcessEnv;
  scriptDirectory?: string;
}

/** Decompiler backend driving Ghidra's headless analyzer. */
export class GhidraDecompiler implements Decompiler {
  readonly id = 'ghidra';
  private installation: GhidraInstallation | undefined;

  constructor(private readonly options: GhidraOptions) {}

  async check(): Promise<{ version: string; details: string }> {
    const installation = await findGhidra(this.options.installDir, this.options.env);
    if (!installation) {
      throw new RecodeError('PREREQUISITE', 'Ghidra was not found.', {
        hint: 'Install Ghidra (see docs/installation.md) and set GHIDRA_INSTALL_DIR or run "recode config set tools.ghidraInstallDir <dir>".',
      });
    }
    this.installation = installation;
    return { version: installation.version, details: installation.installDir };
  }

  async analyze(request: DecompileRequest): Promise<DecompileSummary> {
    if (!this.installation) await this.check();
    const installation = this.installation;
    if (!installation) throw new RecodeError('PREREQUISITE', 'Ghidra was not found.');
    const scriptDir = this.options.scriptDirectory ?? bundledScriptDirectory();

    const staging = `${request.outputDirectory}.staging-${process.pid}`;
    await fs.rm(staging, { recursive: true, force: true });
    await fs.mkdir(staging, { recursive: true });
    const projectDir = await createProjectDirectory(request);

    const args = this.buildArguments(request, { staging, projectDir, scriptDir });
    const result = await runProcess({
      command: installation.headlessPath,
      args,
      env: this.options.env ?? process.env,
      timeoutMs: (request.timeoutSeconds + 120) * 1000,
      ...(request.signal ? { signal: request.signal } : {}),
      logFile: request.logFile,
    });

    try {
      if (result.aborted) throw new RecodeError('CANCELLED', 'Ghidra analysis was cancelled.');
      if (result.timedOut) {
        throw new RecodeError(
          'TOOL_FAILED',
          `Ghidra did not finish within ${request.timeoutSeconds}s.`,
          {
            hint: 'Raise ghidra.analysisTimeoutSeconds with "recode config set".',
          },
        );
      }
      if (!succeeded(result)) {
        throw new RecodeError(
          'TOOL_FAILED',
          `Ghidra headless analyzer exited with code ${result.exitCode}. See ${request.logFile}.`,
          { hint: tailOf(result.stderr || result.stdout) },
        );
      }
      if (!(await pathExists(path.join(staging, 'program.json')))) {
        throw new RecodeError(
          'TOOL_FAILED',
          `Ghidra finished but the export script produced no result. See ${request.logFile}.`,
          { hint: 'Check the log for script compile errors (is the Ghidra version supported?).' },
        );
      }
      const { program, functions } = await validateAnalysisDirectory(staging);
      await swapDirectory(staging, request.outputDirectory);
      return {
        tool: 'ghidra',
        toolVersion: installation.version,
        program,
        functionCount: functions.length,
        decompiledCount: functions.filter((f) => f.decompiledFile !== null).length,
        failedFunctions: functions.filter((f) => f.decompileError).length,
      };
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  }

  private buildArguments(
    request: DecompileRequest,
    dirs: { staging: string; projectDir: string; scriptDir: string },
  ): string[] {
    const { metadata } = request;
    const args = [
      dirs.projectDir,
      'recode',
      '-import',
      request.binaryPath,
      '-overwrite',
      '-deleteProject',
      '-analysisTimeoutPerFile',
      String(request.timeoutSeconds),
      '-scriptPath',
      dirs.scriptDir,
    ];
    if (metadata.format === 'raw') {
      const language = ghidraLanguageId(metadata);
      if (!language || !metadata.baseAddress) {
        throw new RecodeError('INVALID_INPUT', 'Raw binary lacks architecture or base address.');
      }
      args.push(
        '-loader',
        'BinaryLoader',
        '-loader-baseAddr',
        metadata.baseAddress,
        '-processor',
        language,
      );
    }
    args.push(
      '-postScript',
      SCRIPT_NAME,
      dirs.staging,
      String(request.maxFunctions),
      metadata.format === 'raw' && metadata.entryPoint ? metadata.entryPoint : '-',
    );
    return args;
  }
}

/** Ghidra rejects project paths that contain an element starting with a dot (e.g. ".recode"). */
export function hasHiddenSegment(target: string): boolean {
  return path
    .resolve(target)
    .split(/[\\/]/)
    .some((segment) => segment.startsWith('.') && segment !== '.' && segment !== '..');
}

/**
 * Creates a scratch directory for Ghidra's project files. The project's own work directory cannot be used
 * (it lives below ".recode"), so the system temp directory is preferred.
 */
export async function createProjectDirectory(request: DecompileRequest): Promise<string> {
  const parents = [os.tmpdir(), path.dirname(request.outputDirectory)];
  for (const parent of parents) {
    if (hasHiddenSegment(parent)) continue;
    await fs.mkdir(parent, { recursive: true });
    return fs.mkdtemp(path.join(parent, 'recode-ghidra-'));
  }
  throw new RecodeError(
    'TOOL_FAILED',
    'No directory without a dot-prefixed path element is available for the Ghidra project.',
    { hint: 'Ghidra rejects such paths. Set TMPDIR (or TEMP on Windows) to a normal directory.' },
  );
}

async function swapDirectory(staging: string, target: string): Promise<void> {
  const backup = `${target}.old-${process.pid}`;
  const hadTarget = await pathExists(target);
  if (hadTarget) await fs.rename(target, backup);
  try {
    await fs.rename(staging, target);
  } catch (error) {
    if (hadTarget) await fs.rename(backup, target);
    throw error;
  }
  if (hadTarget) await fs.rm(backup, { recursive: true, force: true });
}

function tailOf(text: string): string {
  return text.trim().split('\n').slice(-8).join('\n');
}
