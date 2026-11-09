import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { RecodeError } from '../../core/errors/index.js';
import type { BinaryRecord, Project } from '../../core/project/project.js';
import type { RecodeConfig } from '../../infrastructure/config/config.js';
import { readJsonIfExists, writeJsonAtomic } from '../../infrastructure/filesystem/files.js';
import { runProcess, succeeded } from '../../infrastructure/process/process-manager.js';
import { parseDiagnostics, type Diagnostic } from './diagnostics.js';

export type BuildStatus = 'success' | 'configure-failed' | 'build-failed';

export interface BuildReport {
  status: BuildStatus;
  builtAt: string;
  errorCount: number;
  warningCount: number;
  diagnostics: Diagnostic[];
  /** Tail of the tool output for human inspection when nothing could be parsed. */
  outputTail: string;
}

const GeneratedManifestSchema = z.object({
  fileMap: z.object({
    files: z.record(z.string(), z.string()),
    headerLines: z.record(z.string(), z.string()),
  }),
});

/** Configures and builds the generated C project with CMake and Ninja. */
export async function buildProject(options: {
  project: Project;
  binary: BinaryRecord;
  config: RecodeConfig;
  signal?: AbortSignal | undefined;
}): Promise<BuildReport> {
  const { project, binary, config } = options;
  const sourceDir = project.sourceDir(binary.id);
  const buildDir = project.buildDir(binary.id);
  const manifest = await readJsonIfExists(
    path.join(sourceDir, '.recode-generated.json'),
    GeneratedManifestSchema,
  );
  if (!manifest) {
    throw new RecodeError('WORKFLOW', 'No generated source found; run "recode reconstruct" first.');
  }
  await fs.mkdir(buildDir, { recursive: true });
  const logFile = path.join(project.paths.logs, `build-${binary.id}.log`);

  const configureArgs = [
    '-S',
    sourceDir,
    '-B',
    buildDir,
    '-G',
    'Ninja',
    '-DCMAKE_BUILD_TYPE=Debug',
  ];
  if (config.tools.cCompiler) configureArgs.push(`-DCMAKE_C_COMPILER=${config.tools.cCompiler}`);

  const timeoutMs = config.build.timeoutSeconds * 1000;
  const configure = await runProcess({
    command: config.tools.cmakeCommand,
    args: configureArgs,
    timeoutMs,
    logFile,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (configure.aborted) throw new RecodeError('CANCELLED', 'Build cancelled.');
  if (!succeeded(configure)) {
    return finish(
      project,
      binary,
      manifest,
      'configure-failed',
      `${configure.stdout}\n${configure.stderr}`,
    );
  }

  // "-k 0" keeps Ninja going so that all errors are collected in one pass.
  const build = await runProcess({
    command: config.tools.cmakeCommand,
    args: ['--build', buildDir, '--', '-k', '0'],
    timeoutMs,
    logFile,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (build.aborted) throw new RecodeError('CANCELLED', 'Build cancelled.');
  return finish(
    project,
    binary,
    manifest,
    succeeded(build) ? 'success' : 'build-failed',
    `${build.stdout}\n${build.stderr}`,
  );
}

async function finish(
  project: Project,
  binary: BinaryRecord,
  manifest: z.infer<typeof GeneratedManifestSchema>,
  status: BuildStatus,
  output: string,
): Promise<BuildReport> {
  const diagnostics = parseDiagnostics(output).map((d) => attribute(project, binary, manifest, d));
  const report: BuildReport = {
    status,
    builtAt: new Date().toISOString(),
    errorCount: diagnostics.filter((d) => d.severity === 'error').length,
    warningCount: diagnostics.filter((d) => d.severity === 'warning').length,
    diagnostics,
    outputTail: output.trim().split('\n').slice(-30).join('\n'),
  };
  await writeJsonAtomic(path.join(project.buildDir(binary.id), 'diagnostics.json'), {
    diagnostics,
  });
  await writeJsonAtomic(path.join(project.buildDir(binary.id), 'build-report.json'), report);
  return report;
}

/** Maps a diagnostic to the task whose generated file (or header line) it points at. */
function attribute(
  project: Project,
  binary: BinaryRecord,
  manifest: z.infer<typeof GeneratedManifestSchema>,
  diagnostic: Diagnostic,
): Diagnostic {
  const absolute = path.isAbsolute(diagnostic.file)
    ? diagnostic.file
    : path.resolve(project.buildDir(binary.id), diagnostic.file);
  const relative = path.relative(project.root, absolute).split(path.sep).join('/');
  let taskId = manifest.fileMap.files[relative];
  if (!taskId && relative.endsWith('include/recode_functions.h')) {
    taskId = manifest.fileMap.headerLines[String(diagnostic.line)];
  }
  return { ...diagnostic, file: relative.startsWith('..') ? diagnostic.file : relative, taskId };
}
