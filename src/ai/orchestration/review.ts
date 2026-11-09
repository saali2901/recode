import path from 'node:path';
import { RecodeError } from '../../core/errors/index.js';
import type { EventBus } from '../../core/events/event-bus.js';
import type { BinaryRecord, Project } from '../../core/project/project.js';
import { loadFunctions } from '../../decompiler/extraction/analysis-files.js';
import type { RecodeConfig } from '../../infrastructure/config/config.js';
import { pathExists, readJson } from '../../infrastructure/filesystem/files.js';
import { functionTaskId } from '../../reconstruction/c/c-generator.js';
import {
  FunctionResultSchema,
  ReviewResultSchema,
} from '../../reconstruction/interfaces/results.js';
import { reviewPrompt, type BatchSpec } from '../prompts/prompts.js';
import { writeBatchFile, type SessionRunner } from './session.js';

export interface ReviewSummary {
  requested: number;
  written: number;
  failed: string[];
}

/** Lets the validation agent review reconstructed functions; results go to reviews/<task>.json. */
export async function reviewReconstruction(deps: {
  project: Project;
  binary: BinaryRecord;
  config: RecodeConfig;
  events: EventBus;
  runSession: SessionRunner;
  signal?: AbortSignal | undefined;
}): Promise<ReviewSummary> {
  const { project, binary, config } = deps;
  const functions = await loadFunctions(project.analysisDir(binary.id));
  const recDir = project.reconstructionDir(binary.id);
  const analysis = `analysis/${binary.id}`;

  const tasks: BatchSpec['tasks'] = [];
  for (const fn of functions) {
    const id = functionTaskId(fn.address);
    const resultFile = path.join(recDir, 'results', `${id}.json`);
    if (!(await pathExists(resultFile))) continue;
    const result = await readJson(resultFile, FunctionResultSchema);
    if (result.status !== 'reconstructed') continue;
    tasks.push({
      taskId: id,
      kind: 'function',
      address: fn.address,
      ghidraName: fn.name,
      ghidraSignature: fn.signature,
      files: {
        reconstructed: `reconstruction/${binary.id}/results/${id}.json`,
        ...(fn.decompiledFile ? { decompiled: `${analysis}/${fn.decompiledFile}` } : {}),
        ...(fn.disassemblyFile ? { assembly: `${analysis}/${fn.disassemblyFile}` } : {}),
      },
      resultFile: `reconstruction/${binary.id}/reviews/${id}.json`,
      calleePrototypes: [],
    });
  }
  if (tasks.length === 0) {
    throw new RecodeError('WORKFLOW', 'There are no reconstructed functions to review.');
  }

  const failed: string[] = [];
  let written = 0;
  for (let i = 0; i < tasks.length; i += config.claude.batchSize) {
    if (deps.signal?.aborted) throw new RecodeError('CANCELLED', 'Review cancelled.');
    const slice = tasks.slice(i, i + config.claude.batchSize);
    const spec: BatchSpec = {
      binaryId: binary.id,
      createdAt: new Date().toISOString(),
      maxParallelAgents: 1,
      sharedFiles: { metadata: `${analysis}/metadata.json` },
      tasks: slice,
    };
    const name = `review-${String(i / config.claude.batchSize + 1).padStart(3, '0')}`;
    const batchFile = await writeBatchFile(project, binary.id, name, spec);
    const relative = path.relative(project.root, batchFile).split(path.sep).join('/');
    let sessionError: string | undefined;
    try {
      const outcome = await deps.runSession({
        label: name,
        agent: 'recode-validation-agent',
        prompt: reviewPrompt({ batchFile: relative, spec }),
        spec,
        batchFile,
        signal: deps.signal,
      });
      sessionError = outcome.failure;
    } catch (error) {
      if (error instanceof RecodeError && error.code === 'CANCELLED') throw error;
      sessionError = error instanceof Error ? error.message : String(error);
    }
    for (const task of slice) {
      const file = path.join(project.root, task.resultFile);
      try {
        await readJson(file, ReviewResultSchema);
        written++;
      } catch {
        failed.push(sessionError ? `${task.taskId} (${sessionError})` : task.taskId);
      }
    }
  }
  return { requested: tasks.length, written, failed };
}
