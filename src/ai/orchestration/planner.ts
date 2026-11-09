import type { Task } from '../../core/tasks/task-store.js';
import type { FunctionInfo } from '../../decompiler/interfaces/schemas.js';
import { functionTaskId } from '../../reconstruction/c/c-generator.js';

export interface Plan {
  tasks: Task[];
  excluded: Array<{ address: string; name: string; reason: string }>;
}

const newTask = (
  partial: Pick<Task, 'id' | 'kind' | 'title' | 'dependsOn'> & Partial<Task>,
): Task => ({
  status: 'pending',
  attempts: 0,
  ...partial,
});

/**
 * Builds the task graph: overview -> types -> functions, with each function depending on the
 * functions it calls (callees first). Cycles from recursion are broken by ignoring back edges,
 * so the graph is always acyclic.
 */
export function planTasks(functions: FunctionInfo[]): Plan {
  const excluded: Plan['excluded'] = [];
  const candidates = new Map<string, FunctionInfo>();
  for (const fn of functions) {
    if (fn.isExternal) excluded.push({ address: fn.address, name: fn.name, reason: 'external' });
    else if (fn.isThunk) excluded.push({ address: fn.address, name: fn.name, reason: 'thunk' });
    else if (fn.decompiledFile === null && fn.disassemblyFile === null) {
      excluded.push({ address: fn.address, name: fn.name, reason: 'no analysis output' });
    } else candidates.set(fn.address, fn);
  }

  const order: FunctionInfo[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const deps = new Map<string, string[]>();

  const visit = (fn: FunctionInfo): void => {
    state.set(fn.address, 'visiting');
    const own: string[] = [];
    for (const target of [...new Set(fn.calls)].sort()) {
      const callee = candidates.get(target);
      if (!callee || target === fn.address) continue;
      const calleeState = state.get(target);
      if (calleeState === 'visiting') continue; // back edge: recursion
      if (calleeState === undefined) visit(callee);
      own.push(functionTaskId(target));
    }
    deps.set(fn.address, own);
    state.set(fn.address, 'done');
    order.push(fn);
  };
  for (const fn of [...candidates.values()].sort((a, b) => a.address.localeCompare(b.address))) {
    if (!state.has(fn.address)) visit(fn);
  }

  const tasks: Task[] = [
    newTask({ id: 'overview', kind: 'overview', title: 'Binary overview', dependsOn: [] }),
    newTask({
      id: 'types',
      kind: 'types',
      title: 'Shared data structures',
      dependsOn: ['overview'],
    }),
    ...order.map((fn) =>
      newTask({
        id: functionTaskId(fn.address),
        kind: 'function',
        title: `${fn.name} @ ${fn.address}`,
        address: fn.address,
        dependsOn: ['types', ...(deps.get(fn.address) ?? [])],
      }),
    ),
  ];
  return { tasks, excluded };
}
