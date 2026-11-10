import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RecodeError } from '../../src/core/errors/index.js';
import { EventBus, type RecodeEvent } from '../../src/core/events/event-bus.js';
import { Project } from '../../src/core/project/project.js';
import { TaskStore, makeTask, type Task } from '../../src/core/tasks/task-store.js';
import { WorkflowManager } from '../../src/core/workflow/workflow.js';
import { writeJsonAtomic } from '../../src/infrastructure/filesystem/files.js';
import type { BinaryMetadata } from '../../src/input/interfaces/types.js';
import { makeTempDir, registerTempCleanup } from '../helpers/tmp.js';

registerTempCleanup();

const metadata: BinaryMetadata = {
  format: 'elf',
  kind: 'executable',
  architecture: 'x86_64',
  bits: 64,
  endianness: 'little',
  sections: [],
  segments: [],
  symbols: [],
  symbolsTruncated: false,
  source: 'headers',
  warnings: [],
};

async function newProject() {
  const dir = await makeTempDir();
  return Project.create(path.join(dir, 'p'), 'p');
}

describe('Project', () => {
  it('creates the directory layout and manifest', async () => {
    const project = await newProject();
    for (const dir of ['input', 'reference', 'analysis', 'source', 'build', 'reconstruction']) {
      expect((await fs.stat(path.join(project.root, dir))).isDirectory()).toBe(true);
    }
    expect((await Project.open(project.root)).name).toBe('p');
  });

  it('refuses to create a project in a non-empty directory', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, 'file'), 'x');
    await expect(Project.create(dir, 'x')).rejects.toMatchObject({ code: 'PROJECT' });
  });

  it('finds the project from a nested directory and honours explicit paths', async () => {
    const project = await newProject();
    const nested = path.join(project.root, 'input');
    expect((await Project.resolve(undefined, nested)).root).toBe(project.root);
    expect((await Project.resolve(project.root, '/')).root).toBe(project.root);
    await expect(Project.resolve(undefined, await makeTempDir())).rejects.toMatchObject({
      code: 'PROJECT',
    });
  });

  it('registers binaries idempotently by content hash', async () => {
    const project = await newProject();
    const file = path.join(project.paths.input, 'a.bin');
    await fs.writeFile(file, 'content');
    const first = await project.registerBinary(file, 'test', metadata);
    const second = await project.registerBinary(file, 'test', metadata);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(project.binaries).toHaveLength(1);
    expect(first.record.id).toMatch(/^a-[0-9a-f]{8}$/);
  });

  it('requires an explicit binary when several exist and supports id prefixes', async () => {
    const project = await newProject();
    for (const name of ['a', 'b']) {
      const file = path.join(project.paths.input, `${name}.bin`);
      await fs.writeFile(file, name);
      await project.registerBinary(file, 'test', metadata);
    }
    expect(() => project.resolveBinary()).toThrowError(expect.objectContaining({ code: 'USAGE' }));
    expect(project.resolveBinary('a-').fileName).toBe('a.bin');
    expect(() => project.resolveBinary('zzz')).toThrow(RecodeError);
  });

  it('locks the project and takes over stale locks of dead processes', async () => {
    const project = await newProject();
    await fs.mkdir(project.paths.state, { recursive: true });
    await fs.writeFile(project.paths.lock, '999999'); // pid that does not exist
    await expect(project.withLock(async () => 'ok')).resolves.toBe('ok');

    await fs.writeFile(project.paths.lock, String(process.ppid)); // alive foreign process
    await expect(project.withLock(async () => 'never')).rejects.toThrow(/in use by another/);
    await fs.rm(project.paths.lock);
  });
});

describe('WorkflowManager', () => {
  async function manager() {
    const project = await newProject();
    const events: RecodeEvent[] = [];
    const bus = new EventBus();
    bus.subscribe((e) => events.push(e));
    const workflow = new WorkflowManager(project.workflowFile('bin'), 'bin', bus);
    await workflow.markCompleted('prepare', 'fp0', 'imported');
    return { project, workflow, events, bus };
  }

  it('runs a step, records state and skips it when inputs are unchanged', async () => {
    const { workflow, events } = await manager();
    let runs = 0;
    const execute = async () => ({ summary: `run ${++runs}` });
    const first = await workflow.runStep({ step: 'analyze', fingerprint: 'a', execute });
    const second = await workflow.runStep({ step: 'analyze', fingerprint: 'a', execute });
    const forced = await workflow.runStep({
      step: 'analyze',
      fingerprint: 'a',
      force: true,
      execute,
    });
    expect([first.skipped, second.skipped, forced.skipped]).toEqual([false, true, false]);
    expect(runs).toBe(2);
    expect(second.summary).toBe('run 1');
    expect(events.filter((e) => e.type === 'step-completed' && e.skipped)).toHaveLength(1);
  });

  it('re-runs when the fingerprint changes and invalidates later steps', async () => {
    const { workflow } = await manager();
    const ok = async () => ({ summary: 'ok' });
    await workflow.runStep({ step: 'analyze', fingerprint: 'a', execute: ok });
    await workflow.runStep({ step: 'reconstruct', fingerprint: 'r', execute: ok });
    await workflow.runStep({ step: 'analyze', fingerprint: 'b', execute: ok });
    const state = await workflow.getState();
    expect(state.steps.reconstruct.status).toBe('pending');
    expect(state.steps.analyze.fingerprint).toBe('b');
  });

  it('enforces step order', async () => {
    const { workflow } = await manager();
    await expect(
      workflow.runStep({ step: 'build', fingerprint: 'x', execute: async () => ({ summary: '' }) }),
    ).rejects.toMatchObject({
      code: 'WORKFLOW',
    });
  });

  it('records failures with attempts and allows a targeted retry', async () => {
    const { workflow } = await manager();
    await expect(
      workflow.runStep({
        step: 'analyze',
        fingerprint: 'a',
        execute: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');
    let state = await workflow.getState();
    expect(state.steps.analyze).toMatchObject({ status: 'failed', attempts: 1, error: 'boom' });
    await workflow.runStep({
      step: 'analyze',
      fingerprint: 'a',
      execute: async () => ({ summary: 'fine' }),
    });
    state = await workflow.getState();
    expect(state.steps.analyze).toMatchObject({ status: 'completed', attempts: 2 });
  });

  it('marks cancelled steps as cancelled', async () => {
    const { workflow } = await manager();
    const controller = new AbortController();
    await expect(
      workflow.runStep({
        step: 'analyze',
        fingerprint: 'a',
        signal: controller.signal,
        execute: async () => {
          controller.abort();
          return { summary: 'late' };
        },
      }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect((await workflow.getState()).steps.analyze.status).toBe('cancelled');
  });

  it('recovers from a crash: a persisted "running" step becomes "failed" and can be retried', async () => {
    const { project } = await manager();
    const file = project.workflowFile('bin');
    const state = JSON.parse(await fs.readFile(file, 'utf8'));
    state.steps.analyze = { status: 'running', attempts: 1, startedAt: new Date().toISOString() };
    await writeJsonAtomic(file, state);

    const restarted = new WorkflowManager(file, 'bin', new EventBus());
    const loaded = await restarted.load();
    expect(loaded.steps.analyze.status).toBe('failed');
    expect(loaded.steps.analyze.error).toMatch(/Interrupted/);
    const retry = await restarted.runStep({
      step: 'analyze',
      fingerprint: 'a',
      execute: async () => ({ summary: 'resumed' }),
    });
    expect(retry.skipped).toBe(false);
  });
});

describe('TaskStore', () => {
  const task = (id: string, dependsOn: string[] = []): Task =>
    makeTask({ id, kind: 'function', title: id, dependsOn });

  async function store() {
    const dir = await makeTempDir();
    const file = path.join(dir, 'tasks.json');
    const s = new TaskStore(file);
    await s.load();
    await s.setPlan('fp', [task('a'), task('b', ['a']), task('c', ['b'])]);
    return { file, store: s };
  }

  it('releases tasks only when their dependencies are resolved', async () => {
    const { store: s } = await store();
    expect(s.ready(3).map((t) => t.id)).toEqual(['a']);
    await s.start(['a']);
    await s.complete('a');
    expect(s.ready(3).map((t) => t.id)).toEqual(['b']);
  });

  it('retries failed tasks until attempts are exhausted, then unblocks dependents', async () => {
    const { store: s } = await store();
    for (let i = 0; i < 2; i++) {
      await s.start(['a']);
      await s.fail('a', 'nope');
    }
    expect(s.tasks.find((t) => t.id === 'a')?.attempts).toBe(2);
    expect(s.ready(3).map((t) => t.id)).toEqual(['a']); // third attempt still allowed
    expect(s.ready(2).map((t) => t.id)).toEqual(['b']); // exhausted: dependents may proceed
  });

  it('persists progress and restores interrupted tasks as pending', async () => {
    const { file, store: s } = await store();
    await s.start(['a']);
    const restored = new TaskStore(file);
    await restored.load();
    expect(restored.get('a')).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'Interrupted',
    });
  });

  it('keeps task state for an unchanged plan and resets it when the analysis changed', async () => {
    const { file, store: s } = await store();
    await s.start(['a']);
    await s.complete('a');
    const same = new TaskStore(file);
    await same.load();
    await same.setPlan('fp', [task('a'), task('b', ['a'])]);
    expect(same.get('a')?.status).toBe('completed');
    await same.setPlan('fp2', [task('a')]);
    expect(same.get('a')?.status).toBe('pending');
  });

  it('can reopen a task for repair with context', async () => {
    const { store: s } = await store();
    await s.start(['a']);
    await s.complete('a');
    await s.reopen('a', 'error: x');
    expect(s.get('a')).toMatchObject({ status: 'pending', attempts: 0, repairContext: 'error: x' });
  });
});
