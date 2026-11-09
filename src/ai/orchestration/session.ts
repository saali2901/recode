import fs from 'node:fs/promises';
import path from 'node:path';
import type { EventBus } from '../../core/events/event-bus.js';
import type { Project } from '../../core/project/project.js';
import { writeJsonAtomic } from '../../infrastructure/filesystem/files.js';
import type { RecodeConfig } from '../../infrastructure/config/config.js';
import type { ClaudeEvent } from '../claude/events.js';
import { runClaude, type ClaudeRunResult } from '../claude/runner.js';
import type { BatchSpec } from '../prompts/prompts.js';

export interface SessionRequest {
  label: string;
  agent: string;
  prompt: string;
  spec: BatchSpec;
  batchFile: string;
  signal?: AbortSignal | undefined;
}

export type SessionRunner = (request: SessionRequest) => Promise<ClaudeRunResult>;

export interface SessionContext {
  project: Project;
  config: RecodeConfig;
  events: EventBus;
  binaryId: string;
}

/** Writes the batch file and builds the default runner that spawns the Claude Code CLI. */
export function createClaudeSessionRunner(context: SessionContext): SessionRunner {
  const { project, config, events, binaryId } = context;
  return async (request) => {
    const rootRelative = `/reconstruction/${binaryId}/**`;
    const logFile = path.join(
      project.paths.logs,
      `claude-${path.basename(request.batchFile, '.json')}.log`,
    );
    const result = await runClaude({
      command: config.tools.claudeCommand,
      prompt: request.prompt,
      cwd: project.root,
      agent: request.agent,
      availableTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task'],
      allowedTools: ['Read', 'Glob', 'Grep', 'Task', `Edit(${rootRelative})`],
      model: config.claude.model,
      maxTurns: config.claude.maxTurns,
      timeoutMs: config.claude.sessionTimeoutMinutes * 60_000,
      signal: request.signal,
      logFile,
      onEvent: (event) => reportActivity(events, request, event),
    });
    await appendSessionLog(project, binaryId, request, result);
    return result;
  };
}

function reportActivity(events: EventBus, request: SessionRequest, event: ClaudeEvent): void {
  if (event.kind === 'tool-use' && event.subagentType) {
    events.emit({
      type: 'agent-activity',
      session: request.label,
      agent: event.subagentType,
      summary: event.summary || 'started',
    });
  }
}

async function appendSessionLog(
  project: Project,
  binaryId: string,
  request: SessionRequest,
  result: ClaudeRunResult,
): Promise<void> {
  const file = path.join(project.paths.state, 'sessions', `${binaryId}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const entry = {
    at: new Date().toISOString(),
    label: request.label,
    agent: request.agent,
    tasks: request.spec.tasks.map((t) => t.taskId),
    sessionId: result.sessionId,
    ok: result.ok,
    failure: result.failure,
    costUsd: result.costUsd,
    turns: result.turns,
    subagentsStarted: result.subagentsStarted,
    unknownEventTypes: result.unknownEventTypes,
  };
  await fs.appendFile(file, `${JSON.stringify(entry)}\n`);
}

/** Persists a batch spec for the agents to read. */
export async function writeBatchFile(
  project: Project,
  binaryId: string,
  name: string,
  spec: BatchSpec,
): Promise<string> {
  const file = path.join(project.reconstructionDir(binaryId), 'batches', `${name}.json`);
  await writeJsonAtomic(file, spec);
  return file;
}
