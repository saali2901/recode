import { describe, expect, it } from 'vitest';
import { buildClaudeArguments, runClaude } from '../../src/ai/claude/runner.js';
import { parseStreamLine } from '../../src/ai/claude/events.js';
import { MOCK_CLAUDE } from '../helpers/tools.js';
import { makeTempDir, registerTempCleanup } from '../helpers/tmp.js';

registerTempCleanup();

describe('stream-json event parsing', () => {
  it('parses init, text, tool use, subagent spawn and result events', () => {
    expect(
      parseStreamLine(
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          session_id: 's1',
          model: 'm',
          tools: ['Read'],
        }),
      ),
    ).toEqual([{ kind: 'init', sessionId: 's1', model: 'm', tools: ['Read'] }]);
    const assistant = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'hello' },
          {
            type: 'tool_use',
            id: 't1',
            name: 'Task',
            input: { subagent_type: 'recode-c-reconstructor', description: 'fn_1' },
          },
          { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'a.c' } },
        ],
      },
    };
    expect(parseStreamLine(JSON.stringify(assistant))).toEqual([
      { kind: 'text', text: 'hello', subagent: false },
      {
        kind: 'tool-use',
        id: 't1',
        name: 'Task',
        summary: 'fn_1',
        subagentType: 'recode-c-reconstructor',
        subagent: false,
      },
      {
        kind: 'tool-use',
        id: 't2',
        name: 'Read',
        summary: 'a.c',
        subagentType: undefined,
        subagent: false,
      },
    ]);
    const result = parseStreamLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'done',
        total_cost_usd: 0.5,
        num_turns: 4,
        session_id: 's1',
      }),
    );
    expect(result[0]).toMatchObject({
      kind: 'result',
      ok: true,
      text: 'done',
      costUsd: 0.5,
      turns: 4,
    });
  });

  it('marks messages from subagents', () => {
    const events = parseStreamLine(
      JSON.stringify({
        type: 'assistant',
        parent_tool_use_id: 't1',
        message: { content: [{ type: 'text', text: 'x' }] },
      }),
    );
    expect(events[0]).toMatchObject({ kind: 'text', subagent: true });
  });

  it('reports error results as not ok', () => {
    const [event] = parseStreamLine(
      JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true }),
    );
    expect(event).toMatchObject({ kind: 'result', ok: false, subtype: 'error_max_turns' });
  });

  it('never throws on unknown, partial or malformed input', () => {
    expect(parseStreamLine('')).toEqual([]);
    expect(parseStreamLine('not json')).toEqual([{ kind: 'unknown', type: 'non-json' }]);
    expect(parseStreamLine('[1,2]')).toEqual([{ kind: 'unknown', type: 'malformed' }]);
    expect(parseStreamLine('{"type":"brand_new_event","x":1}')).toEqual([
      { kind: 'unknown', type: 'brand_new_event' },
    ]);
    expect(parseStreamLine('{"type":"assistant","message":{"content":42}}')).toEqual([
      { kind: 'unknown', type: 'assistant' },
    ]);
    expect(parseStreamLine('{"type":"stream_event","event":{}}')).toEqual([
      { kind: 'unknown', type: 'stream_event' },
    ]);
  });
});

describe('Claude runner', () => {
  it('builds a locked-down argument vector', () => {
    const args = buildClaudeArguments({
      command: 'claude',
      prompt: 'x',
      cwd: '/p',
      agent: 'recode-lead',
      allowedTools: ['Read', 'Edit(/reconstruction/**)'],
      availableTools: ['Read', 'Edit', 'Task'],
      maxTurns: 7,
      timeoutMs: 1000,
      model: 'sonnet',
    });
    expect(args).toEqual(
      expect.arrayContaining([
        '--print',
        '--permission-mode',
        'dontAsk',
        '--agent',
        'recode-lead',
        '--max-turns',
        '7',
        '--model',
        'sonnet',
        '--setting-sources',
        'project',
      ]),
    );
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Edit,Task');
    expect(args.join(' ')).not.toContain('dangerously');
    expect(args).not.toContain('x'); // the prompt travels via stdin
  });

  async function run(mode: string, extra: { timeoutMs?: number } = {}) {
    const dir = await makeTempDir();
    process.env['MOCK_CLAUDE_MODE'] = mode;
    process.env['MOCK_STATE_DIR'] = dir;
    try {
      return await runClaude({
        command: MOCK_CLAUDE,
        prompt: 'no batch here',
        cwd: dir,
        agent: 'recode-lead',
        allowedTools: ['Read'],
        availableTools: ['Read'],
        maxTurns: 3,
        timeoutMs: extra.timeoutMs ?? 10_000,
      });
    } finally {
      delete process.env['MOCK_CLAUDE_MODE'];
      delete process.env['MOCK_STATE_DIR'];
    }
  }

  it('turns an error result into a failure and tolerates unknown events', async () => {
    const result = await run('ok');
    expect(result.ok).toBe(false);
    expect(result.failure).toContain('error_during_execution');
    expect(result.unknownEventTypes).toEqual(
      expect.arrayContaining(['future_event_type_nobody_knows', 'non-json']),
    );
  });

  it('reports a crash without a result event', async () => {
    const result = await run('crash');
    expect(result.ok).toBe(false);
    expect(result.failure).toContain('without a result event');
    expect(result.failure).toContain('mock claude crashed');
  });

  it('times out hanging sessions', async () => {
    const result = await run('hang', { timeoutMs: 500 });
    expect(result.ok).toBe(false);
    expect(result.failure).toContain('timed out');
  });
});
