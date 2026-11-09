import path from 'node:path';
import type { EventBus } from '../core/events/event-bus.js';
import type { Project } from '../core/project/project.js';
import { WorkflowManager } from '../core/workflow/workflow.js';
import type { RecodeConfig } from '../infrastructure/config/config.js';
import { writeJsonAtomic } from '../infrastructure/filesystem/files.js';
import { createDefaultRegistry } from '../input/adapters/registry.js';
import { ImportService, type ImportReport } from '../input/import-service.js';
import type { DetectionResult, MetadataHints } from '../input/interfaces/types.js';
import { prepareFingerprint } from './pipeline.js';

export interface ImportRequest {
  hints?: MetadataHints | undefined;
  forceRaw?: boolean | undefined;
}

/** Detects the type of a file without importing it. */
export function detectFile(
  config: RecodeConfig,
  project: Project,
  file: string,
): Promise<DetectionResult> {
  return new ImportService(project, createDefaultRegistry(config.archive)).detect(file);
}

/**
 * Imports a file into the project and marks the "prepare" workflow step of every new binary as
 * completed. The caller must hold the project lock.
 */
export async function importIntoProject(
  project: Project,
  config: RecodeConfig,
  events: EventBus,
  file: string,
  request: ImportRequest = {},
): Promise<ImportReport> {
  const service = new ImportService(project, createDefaultRegistry(config.archive));
  const report = await service.import(file, {
    ...(request.hints ? { hints: request.hints } : {}),
    ...(request.forceRaw ? { forceRaw: true } : {}),
  });
  for (const { record } of report.binaries) {
    const workflow = new WorkflowManager(project.workflowFile(record.id), record.id, events);
    await workflow.markCompleted('prepare', prepareFingerprint(record), 'imported');
    await writeJsonAtomic(
      path.join(project.analysisDir(record.id), 'metadata.json'),
      record.metadata,
    );
  }
  return report;
}
