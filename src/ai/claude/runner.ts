import { RecodeError } from '../../core/errors/index.js';
import { runProcess, type RunResult } from '../../infrastructure/process/process-manager.js';
import { parseStreamLine, type ClaudeEvent, type TokenUsage } from './events.js';

export type BlockReason = 'rate-limit' | 'untrusted';

const RATE_LIMIT_PATTERN =
  /(hit|reached|exceeded) your [\w -]{0,30}limit|usage limit|rate[ -]?limit|limit[^.]{0,30}resets?/i;
const UNTRUSTED_PATTERN = /has not been trusted|not been trusted/i;

/** Recognizes failures that retrying cannot fix: exhausted subscription limit, untrusted workspace. */
export function classifyBlock(resultText: string, stderr: string): BlockReason | undefined {
  if (RATE_LIMIT_PATTERN.test(resultText)) return 'rate-limit';
  if (UNTRUSTED_PATTERN.test(stderr)) return 'untrusted';
  return undefined;
}

export interface ClaudeRunOptions {
  /** Executable name or path of the Claude Code CLI. */
  command: string;
  prompt: string;
  /** Working directory; Claude is confined to it (and below) by the permission rules. */
  cwd: string;
  /** Name of the agent in .claude/agents/ that runs the main thread. */
  agent: string;
  /** Permission rules that are pre-approved, e.g. "Read" or "Write(reconstruction/results/**)". */
  allowedTools: string[];
  /** Built-in tools made available at all. Everything else (Bash, WebFetch, ...) is removed. */
  availableTools: string[];
  model?: string | undefined;
  maxTurns: number;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  logFile?: string | undefined;
  onEvent?: ((event: ClaudeEvent) => void) | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

export interface ClaudeRunResult {
  ok: boolean;
  sessionId: string | undefined;
  /** Final text of the lead agent, or the error description. */
  resultText: string;
  costUsd: number | undefined;
  turns: number | undefined;
  /** Model the CLI reported at start-up (the concrete model behind an alias), if any. */
  model: string | undefined;
  usage: TokenUsage | undefined;
  /** Subagent types that were started, in order. */
  subagentsStarted: string[];
  unknownEventTypes: string[];
  failure: string | undefined;
  /** Set when the session was stopped by a condition that retrying cannot fix. */
  blocked: BlockReason | undefined;
  raw: RunResult;
}

export const DENIED_TOOLS = [
  'Bash',
  'WebFetch',
  'WebSearch',
  'Edit(/.claude/**)',
  'Edit(/.recode/**)',
  'Edit(/input/**)',
  'Edit(/analysis/**)',
  'Edit(/source/**)',
  'Edit(/recode.json)',
];

/** Builds the argument vector for a headless, non-interactive Claude Code session. */
export function buildClaudeArguments(options: ClaudeRunOptions): string[] {
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--permission-mode',
    'dontAsk',
    '--setting-sources',
    'project',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--agent',
    options.agent,
    '--max-turns',
    String(options.maxTurns),
    '--tools',
    options.availableTools.join(','),
    '--allowedTools',
    options.allowedTools.join(','),
    // Repeated here so that the restrictions hold even if Claude ignores the project's settings.json
    // (it does so for folders it does not trust).
    '--disallowedTools',
    DENIED_TOOLS.join(','),
  ];
  if (options.model) args.push('--model', options.model);
  return args;
}

/**
 * Runs one headless Claude Code session and folds its stream-json events into a result.
 * The prompt is passed on stdin, never on the command line.
 */
export async function runClaude(options: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const subagentsStarted: string[] = [];
  const unknownEventTypes = new Set<string>();
  let final: Extract<ClaudeEvent, { kind: 'result' }> | undefined;
  let lastText = '';
  let model: string | undefined;

  const raw = await runProcess({
    command: options.command,
    args: buildClaudeArguments(options),
    cwd: options.cwd,
    ...(options.env ? { env: options.env } : {}),
    stdin: options.prompt,
    timeoutMs: options.timeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.logFile ? { logFile: options.logFile } : {}),
    onStdoutLine: (line) => {
      for (const event of parseStreamLine(line)) {
        if (event.kind === 'init') model = event.model;
        else if (event.kind === 'result') final = event;
        else if (event.kind === 'unknown') unknownEventTypes.add(event.type);
        else if (event.kind === 'tool-use' && event.subagentType)
          subagentsStarted.push(event.subagentType);
        else if (event.kind === 'text' && !event.subagent) lastText = event.text;
        options.onEvent?.(event);
      }
    },
  });

  if (raw.aborted) throw new RecodeError('CANCELLED', 'Claude Code session was cancelled.');

  let failure: string | undefined;
  if (raw.timedOut) failure = 'Claude Code session timed out.';
  else if (!final)
    failure = `Claude Code ended without a result event (exit code ${raw.exitCode}).`;
  else if (!final.ok)
    failure = `Claude Code reported "${final.subtype}": ${final.text || 'no details'}`;
  else if (raw.exitCode !== 0) failure = `Claude Code exited with code ${raw.exitCode}.`;
  if (failure && raw.stderr.trim()) failure += ` stderr: ${raw.stderr.trim().slice(-400)}`;

  return {
    ok: failure === undefined,
    sessionId: final?.sessionId,
    resultText: final?.text || lastText,
    costUsd: final?.costUsd,
    turns: final?.turns,
    model,
    usage: final?.usage,
    subagentsStarted,
    unknownEventTypes: [...unknownEventTypes],
    failure,
    blocked: classifyBlock(`${final?.text ?? ''} ${failure ?? ''}`, raw.stderr),
    raw,
  };
}
