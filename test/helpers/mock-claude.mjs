#!/usr/bin/env node
// Test double for the Claude Code CLI. It speaks the stream-json protocol and writes the result
// files a real agent session would write, based on the batch file named in the prompt.
// It does NOT use any AI: reconstructions come from a fixed table for the sample fixture.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);

if (args[0] === '--version') {
  console.log('0.0.0-mock (Claude Code)');
  process.exit(0);
}
if (args[0] === 'auth') {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'mock' }));
  process.exit(0);
}

const prompt = fs.readFileSync(0, 'utf8');
const mode = process.env.MOCK_CLAUDE_MODE ?? 'ok';
const stateDir = process.env.MOCK_STATE_DIR ?? process.cwd();
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (process.env.MOCK_LOG) {
  fs.appendFileSync(
    process.env.MOCK_LOG,
    `${JSON.stringify({ args, cwd: process.cwd(), prompt })}\n`,
  );
}

const FUNCTIONS = {
  add_ints: {
    prototype: 'int add_ints(int a, int b);',
    code: 'int add_ints(int a, int b)\n{\n    return a + b;\n}',
  },
  multiply: {
    prototype: 'int multiply(int a, int b);',
    code: 'int multiply(int a, int b)\n{\n    return a * b;\n}',
    broken: 'int multiply(int a, int b)\n{\n    return a * b\n}',
  },
  square: {
    prototype: 'int square(int value);',
    code: 'int square(int value)\n{\n    return multiply(value, value);\n}',
  },
  shape_area: {
    prototype: 'int shape_area(const struct shape *s);',
    code:
      'int shape_area(const struct shape *s)\n{\n    switch (s->kind) {\n    case SHAPE_RECT:\n        return multiply(s->width, s->height);\n' +
      '    case SHAPE_SQUARE:\n        return square(s->width);\n    case SHAPE_TRIANGLE:\n        return multiply(s->width, s->height) / 2;\n    }\n    return -1;\n}',
  },
  sum_areas: {
    prototype: 'int sum_areas(const struct shape *shapes, int count);',
    code: 'int sum_areas(const struct shape *shapes, int count)\n{\n    int total = 0;\n    for (int i = 0; i < count; i++) {\n        total = add_ints(total, shape_area(&shapes[i]));\n    }\n    return total;\n}',
  },
  main: {
    prototype: 'int main(void);',
    includes: ['stdio.h'],
    code: 'int main(void)\n{\n    struct shape list[3] = { { SHAPE_RECT, 3, 4 }, { SHAPE_SQUARE, 5, 5 }, { SHAPE_TRIANGLE, 6, 4 } };\n    printf("total area: %d\\n", sum_areas(list, 3));\n    return 0;\n}',
  },
};

const TYPES_HEADER =
  'enum shape_kind { SHAPE_RECT = 0, SHAPE_SQUARE = 1, SHAPE_TRIANGLE = 2 };\nstruct shape {\n    enum shape_kind kind;\n    int width;\n    int height;\n};';

const seenFile = path.join(stateDir, 'mock-claude-seen.json');
const seen = fs.existsSync(seenFile) ? JSON.parse(fs.readFileSync(seenFile, 'utf8')) : {};
const bump = (key) => {
  seen[key] = (seen[key] ?? 0) + 1;
  fs.writeFileSync(seenFile, JSON.stringify(seen));
  return seen[key];
};

const requestedModel = flag('--model');
emit({
  type: 'system',
  subtype: 'init',
  session_id: 'mock-session',
  model: requestedModel ? `mock-${requestedModel}` : 'mock',
  tools: ['Read', 'Write', 'Task'],
});
// A model listed here behaves like one the installed CLI does not know.
if (
  requestedModel &&
  (process.env.MOCK_UNAVAILABLE_MODELS ?? '').split(',').includes(requestedModel)
) {
  emit({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    result: `There's an issue with the selected model (${requestedModel}). It may not exist or you may not have access to it.`,
    session_id: 'mock-session',
  });
  process.exit(1);
}
// Availability probe of ReCode ("Reply with the single word: ok").
if (/Reply with the single word/.test(prompt) && !/Batch file/.test(prompt)) {
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'ok',
    session_id: 'mock-session',
  });
  process.exit(0);
}
emit({ type: 'future_event_type_nobody_knows', data: 1 });
process.stdout.write('this line is not json\n');

if (mode === 'ratelimit') {
  emit({
    type: 'result',
    subtype: 'success',
    is_error: true,
    result: "You've hit your 5-hour limit · resets 1:50pm (Europe/Berlin)",
    session_id: 'mock-session',
  });
  process.exit(0);
}
if (mode === 'untrusted') {
  process.stderr.write(
    'Ignoring 4 permissions.allow entries from .claude/settings.json: this workspace has not been trusted. Run Claude Code interactively here once and accept the trust dialog.\n',
  );
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'I could not write the file.',
    session_id: 'mock-session',
  });
  process.exit(0);
}
if (mode === 'crash') {
  process.stderr.write('mock claude crashed\n');
  process.exit(1);
}
if (mode === 'hang') {
  setInterval(() => {}, 1000);
} else {
  const latency = Number(process.env.MOCK_LATENCY_MS ?? '0');
  if (latency > 0) setTimeout(run, latency);
  else run();
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`,
  );
}

function run() {
  const batchMatch = /Batch file[^:]*: (\S+)/.exec(prompt);
  if (!batchMatch) {
    emit({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'no batch file in prompt',
      session_id: 'mock-session',
    });
    process.exit(0);
  }
  const batch = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), batchMatch[1]), 'utf8'));
  const agent = flag('--agent');

  for (const task of batch.tasks) {
    const out = path.resolve(process.cwd(), task.resultFile);
    if (agent === 'recode-lead') {
      emit({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: `t-${task.taskId}`,
              name: 'Task',
              input: { subagent_type: 'recode-c-reconstructor', description: task.taskId },
            },
          ],
        },
      });
      emit({
        type: 'assistant',
        parent_tool_use_id: `t-${task.taskId}`,
        message: { content: [{ type: 'text', text: 'working in subagent' }] },
      });
    }
    if (task.kind === 'overview') {
      write(
        out,
        '# Overview\n\nMock overview generated by the Claude test double. Not AI output.\n',
      );
    } else if (task.kind === 'types') {
      write(out, {
        taskId: 'types',
        header: TYPES_HEADER,
        items: [{ name: 'struct shape', kind: 'struct', confidence: 'probable' }],
        assumptions: [],
      });
    } else {
      const fn = FUNCTIONS[task.ghidraName];
      if (!fn) continue;
      const attempt = bump(task.taskId);
      if (mode === `skip:${task.ghidraName}` && attempt === 1) continue;
      if (mode === `badjson:${task.ghidraName}` && attempt === 1) {
        write(out, '{ this is not json');
        continue;
      }
      let code = fn.code;
      if (mode === 'break-multiply' && task.ghidraName === 'multiply' && !task.repairContext)
        code = fn.broken;
      if (mode === 'wrong-address' && task.ghidraName === 'add_ints') task.address = '0xdead';
      write(out, {
        taskId: task.taskId,
        address: task.address,
        status: 'reconstructed',
        name: task.ghidraName,
        prototype: fn.prototype,
        code,
        includes: fn.includes ?? [],
        confidence: 'probable',
        assumptions: [{ text: 'Mock reconstruction from a fixed table.', confidence: 'certain' }],
      });
    }
  }
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: `done ${batch.tasks.length} task(s)`,
    session_id: 'mock-session',
    total_cost_usd: 0.01,
    num_turns: 3,
    duration_ms: 10,
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  });
  process.exit(0);
}
