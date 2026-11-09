import path from 'node:path';
import { EventBus } from '../core/events/event-bus.js';
import { Project } from '../core/project/project.js';
import { loadConfig, type RecodeConfig } from '../infrastructure/config/config.js';
import { createFileLogger, type Logger } from '../infrastructure/logging/logger.js';

export interface AppContext {
  project: Project;
  config: RecodeConfig;
  logger: Logger;
  events: EventBus;
  signal: AbortSignal;
}

/** Opens a project, loads layered configuration and wires events to the file log. */
export async function createContext(options: {
  projectDir?: string | undefined;
  cwd: string;
  signal: AbortSignal;
}): Promise<AppContext> {
  const project = await Project.resolve(options.projectDir, options.cwd);
  const config = await loadConfig({ projectLayer: project.configLayer });
  const logger = createFileLogger(path.join(project.paths.logs), config.logging.level);
  const events = new EventBus();
  events.subscribe((event) => logger.info({ event }, event.type));
  return { project, config, logger, events, signal: options.signal };
}
