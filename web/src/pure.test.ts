import { describe, expect, it } from 'vitest';
import { estimateRemaining, formatBytes, formatDuration } from './format';
import { describeEvent, initialStream, parseRoute, streamReducer } from './hooks';
import type { JobInfo } from './types';
import { firstOpenStep } from './wizard/steps';
import type { BinarySummary, ProjectDetail, StepState } from './types';

const job = (patch: Partial<JobInfo> = {}): JobInfo => ({
  id: 'j1',
  step: 'reconstruct',
  binaryId: 'b',
  status: 'running',
  startedAt: '2026-01-01T00:00:00Z',
  ...patch,
});

describe('formatting', () => {
  it('formats sizes and durations', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(5 * 1024 ** 2)).toBe('5.0 MiB');
    expect(formatDuration(4000)).toBe('4s');
    expect(formatDuration(125_000)).toBe('2m 05s');
    expect(formatDuration(3_900_000)).toBe('1h 05m');
  });

  it('estimates remaining time only with a basis', () => {
    expect(estimateRemaining(10_000, 0, 10)).toBeUndefined();
    expect(estimateRemaining(10_000, 10, 10)).toBeUndefined();
    expect(estimateRemaining(10_000, 2, 10)).toBe(40_000);
  });
});

describe('routing', () => {
  it('parses hash routes', () => {
    expect(parseRoute('')).toEqual({ name: 'projects' });
    expect(parseRoute('#/projects/my%20proj')).toEqual({ name: 'project', project: 'my proj' });
    expect(parseRoute('#/settings')).toEqual({ name: 'settings' });
    expect(parseRoute('#/doctor')).toEqual({ name: 'doctor' });
    expect(parseRoute('#/unknown/path')).toEqual({ name: 'projects' });
  });
});

describe('stream reducer', () => {
  it('clears log and activity when a new job starts, not when the same job updates', () => {
    let state = streamReducer(initialStream, { type: 'job', job: job() });
    state = streamReducer(state, { type: 'log', id: 1, file: 'a.log', line: 'hello' });
    state = streamReducer(state, {
      type: 'event',
      id: 2,
      event: { type: 'agent-activity', agent: 'recode-c-reconstructor', summary: 'fn_1' },
    });
    expect(state.lines).toHaveLength(1);
    expect(state.activity).toHaveLength(1);
    state = streamReducer(state, { type: 'job', job: job({ status: 'completed' }) });
    expect(state.lines).toHaveLength(1);
    state = streamReducer(state, { type: 'job', job: job({ id: 'j2' }) });
    expect(state.lines).toHaveLength(0);
    expect(state.activity).toHaveLength(0);
  });

  it('turns events into log lines and counts progress events', () => {
    let state = streamReducer(initialStream, {
      type: 'event',
      id: 1,
      event: { type: 'task-completed', label: 'add_ints @ 0x1' },
    });
    expect(state.lines[0]?.text).toBe('✓ add_ints @ 0x1');
    expect(state.progressTick).toBe(1);
    state = streamReducer(state, {
      type: 'event',
      id: 2,
      event: { type: 'agent-activity', agent: 'x', summary: 'y' },
    });
    expect(state.progressTick).toBe(1);
    expect(describeEvent({ type: 'something-new' })).toBeUndefined();
  });

  it('keeps the log bounded', () => {
    let state = initialStream;
    for (let i = 0; i < 1700; i++)
      state = streamReducer(state, { type: 'log', id: i, file: 'a.log', line: String(i) });
    expect(state.lines).toHaveLength(1500);
    expect(state.lines.at(-1)?.text).toBe('1699');
  });
});

describe('wizard step logic', () => {
  const steps = (done: string[]): Record<string, StepState> =>
    Object.fromEntries(
      ['prepare', 'analyze', 'reconstruct', 'build', 'validate'].map((s) => [
        s,
        { status: done.includes(s) ? 'completed' : 'pending', attempts: 0 },
      ]),
    );
  const binary = (done: string[]): BinarySummary => ({
    id: 'b',
    fileName: 'b',
    size: 1,
    sha256: '',
    format: 'elf',
    kind: 'executable',
    architecture: 'x86_64',
    bits: 64,
    endianness: 'little',
    entryPoint: null,
    sectionCount: 0,
    symbolCount: 0,
    warnings: [],
    steps: steps(done) as BinarySummary['steps'],
    tasks: null,
  });
  const detail = (b: BinarySummary[]): ProjectDetail => ({
    name: 'p',
    binaries: b,
    references: [],
    job: null,
  });

  it('points at the first unfinished step', () => {
    expect(firstOpenStep(undefined, undefined)).toBe(0);
    expect(firstOpenStep(detail([]), undefined)).toBe(0);
    expect(firstOpenStep(detail([binary(['prepare'])]), binary(['prepare']))).toBe(1);
    expect(
      firstOpenStep(detail([binary(['prepare', 'analyze'])]), binary(['prepare', 'analyze'])),
    ).toBe(2);
    expect(
      firstOpenStep(
        detail([binary(['analyze', 'reconstruct', 'build'])]),
        binary(['analyze', 'reconstruct', 'build']),
      ),
    ).toBe(4);
    const all = binary(['analyze', 'reconstruct', 'build', 'validate']);
    expect(firstOpenStep(detail([all]), all)).toBe(5);
  });
});
