import { z } from 'zod';

/** Normalised view of the stream-json events ReCode cares about. */
export type ClaudeEvent =
  | { kind: 'init'; sessionId: string | undefined; model: string | undefined; tools: string[] }
  | { kind: 'text'; text: string; subagent: boolean }
  | {
      kind: 'tool-use';
      id: string;
      name: string;
      summary: string;
      /** Set when the tool call spawns a subagent. */
      subagentType: string | undefined;
      subagent: boolean;
    }
  | { kind: 'tool-result'; isError: boolean; subagent: boolean }
  | {
      kind: 'result';
      ok: boolean;
      subtype: string;
      text: string;
      sessionId: string | undefined;
      costUsd: number | undefined;
      turns: number | undefined;
      durationMs: number | undefined;
      usage: TokenUsage | undefined;
    }
  | { kind: 'unknown'; type: string };

/** Token counts the CLI reports in its final result event (absent in older CLI versions). */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

const BaseEventSchema = z.object({ type: z.string() }).passthrough();

const ContentBlockSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    is_error: z.boolean().optional(),
  })
  .passthrough();

const MessageEventSchema = z
  .object({
    type: z.enum(['assistant', 'user']),
    parent_tool_use_id: z.string().nullish(),
    message: z
      .object({ content: z.union([z.string(), z.array(ContentBlockSchema)]) })
      .passthrough(),
  })
  .passthrough();

const InitEventSchema = z
  .object({
    type: z.literal('system'),
    subtype: z.literal('init'),
    session_id: z.string().optional(),
    model: z.string().optional(),
    tools: z.array(z.string()).optional(),
  })
  .passthrough();

const ResultEventSchema = z
  .object({
    type: z.literal('result'),
    subtype: z.string().default('unknown'),
    is_error: z.boolean().optional(),
    result: z.string().optional(),
    session_id: z.string().optional(),
    total_cost_usd: z.number().optional(),
    num_turns: z.number().optional(),
    duration_ms: z.number().optional(),
    usage: z
      .object({
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
        cache_read_input_tokens: z.number().optional(),
        cache_creation_input_tokens: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

function summarizeInput(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  const candidate = input['description'] ?? input['file_path'] ?? input['path'] ?? input['pattern'];
  return typeof candidate === 'string' ? candidate.slice(0, 160) : '';
}

/**
 * Parses one line of `--output-format stream-json` output. Never throws: malformed lines and
 * unknown event types come back as { kind: 'unknown' } so new CLI versions cannot break a run.
 */
export function parseStreamLine(line: string): ClaudeEvent[] {
  const trimmed = line.trim();
  if (trimmed === '') return [];
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return [{ kind: 'unknown', type: 'non-json' }];
  }
  const base = BaseEventSchema.safeParse(json);
  if (!base.success) return [{ kind: 'unknown', type: 'malformed' }];

  const init = InitEventSchema.safeParse(json);
  if (init.success) {
    return [
      {
        kind: 'init',
        sessionId: init.data.session_id,
        model: init.data.model,
        tools: init.data.tools ?? [],
      },
    ];
  }

  const result = ResultEventSchema.safeParse(json);
  if (result.success) {
    const data = result.data;
    return [
      {
        kind: 'result',
        ok: data.is_error !== true && data.subtype === 'success',
        subtype: data.subtype,
        text: data.result ?? '',
        sessionId: data.session_id,
        costUsd: data.total_cost_usd,
        turns: data.num_turns,
        durationMs: data.duration_ms,
        usage: data.usage
          ? {
              inputTokens: data.usage.input_tokens ?? 0,
              outputTokens: data.usage.output_tokens ?? 0,
              cacheReadTokens: data.usage.cache_read_input_tokens ?? 0,
              cacheCreationTokens: data.usage.cache_creation_input_tokens ?? 0,
            }
          : undefined,
      },
    ];
  }

  const message = MessageEventSchema.safeParse(json);
  if (message.success) {
    const subagent = message.data.parent_tool_use_id != null;
    const content = message.data.message.content;
    if (typeof content === 'string') {
      return message.data.type === 'assistant' ? [{ kind: 'text', text: content, subagent }] : [];
    }
    const events: ClaudeEvent[] = [];
    for (const block of content) {
      if (block.type === 'text' && block.text && message.data.type === 'assistant') {
        events.push({ kind: 'text', text: block.text, subagent });
      } else if (block.type === 'tool_use') {
        const isSpawn = block.name === 'Task' || block.name === 'Agent';
        const subagentType = isSpawn ? asString(block.input?.['subagent_type']) : undefined;
        events.push({
          kind: 'tool-use',
          id: block.id ?? '',
          name: block.name ?? 'unknown',
          summary: summarizeInput(block.input),
          subagentType,
          subagent,
        });
      } else if (block.type === 'tool_result') {
        events.push({ kind: 'tool-result', isError: block.is_error === true, subagent });
      }
    }
    return events;
  }

  return [{ kind: 'unknown', type: base.data.type }];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
