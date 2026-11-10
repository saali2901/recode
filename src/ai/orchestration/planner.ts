import { condense } from '../../core/graph/graph.js';
import { makeTask, type Task } from '../../core/tasks/task-store.js';
import type { FunctionInfo } from '../../decompiler/interfaces/schemas.js';
import { functionTaskId } from '../../reconstruction/c/c-generator.js';

export interface Plan {
  tasks: Task[];
  excluded: Array<{ address: string; name: string; reason: string }>;
  stats: PlanStats;
}

export interface PlanStats {
  functionTasks: number;
  components: number;
  /** Number of functions in the largest strongly connected component (mutual recursion). */
  largestComponent: number;
  /** Longest chain of dependent components (the critical path measured in components). */
  criticalPath: number;
  /** Tasks that can start without waiting for any other function. */
  leaves: number;
}

/**
 * How a function depends on the functions it calls.
 * - `adaptive` (default): callees of other components are soft dependencies. The scheduler waits for them while
 *   other work is available and relaxes them when workers would idle; the callee's Ghidra signature is the fallback.
 * - `complete`: callees must be reconstructed first (hard dependencies).
 * - `signatures`: calls never order the work; callers always get the decompiler signature of callees.
 * - `legacy`: the original planner (depth-first order, back edges dropped, hard dependencies).
 */
export type DependencyMode = 'adaptive' | 'complete' | 'signatures' | 'legacy';

export interface PlanOptions {
  mode?: DependencyMode;
  /** Strongly connected components larger than this are split into chunks of this size. */
  maxGroupSize?: number;
  /** Content hash per function address (see the analysis store); stored as `inputHash`. */
  inputHashes?: ReadonlyMap<string, string>;
}

function selectCandidates(functions: FunctionInfo[]): {
  candidates: Map<string, FunctionInfo>;
  excluded: Plan['excluded'];
} {
  const excluded: Plan['excluded'] = [];
  const candidates = new Map<string, FunctionInfo>();
  for (const fn of functions) {
    if (fn.isExternal) excluded.push({ address: fn.address, name: fn.name, reason: 'external' });
    else if (fn.isThunk) excluded.push({ address: fn.address, name: fn.name, reason: 'thunk' });
    else if (fn.decompiledFile === null && fn.disassemblyFile === null) {
      excluded.push({ address: fn.address, name: fn.name, reason: 'no analysis output' });
    } else candidates.set(fn.address, fn);
  }
  return { candidates, excluded };
}

const head = (): Task[] => [
  makeTask({
    id: 'overview',
    kind: 'overview',
    title: 'Binary overview',
    dependsOn: [],
    priority: 1000,
  }),
  makeTask({
    id: 'types',
    kind: 'types',
    title: 'Shared data structures',
    dependsOn: ['overview'],
    priority: 999,
  }),
];

/**
 * Builds the task graph: overview -> types -> functions.
 *
 * Call edges are condensed into strongly connected components (Tarjan), so recursion and mutual recursion are
 * handled exactly instead of by accident of traversal order: members of one component form a group that is
 * reconstructed in one session with consistent prototypes. The condensation is a DAG, hence no waiting cycles.
 */
export function planTasks(functions: FunctionInfo[], options: PlanOptions = {}): Plan {
  const mode = options.mode ?? 'adaptive';
  if (mode === 'legacy') return planTasksLegacy(functions, options);
  const maxGroup = Math.max(1, options.maxGroupSize ?? 24);
  const { candidates, excluded } = selectCandidates(functions);

  const sorted = [...candidates.keys()].sort();
  const edges = new Map<string, string[]>();
  for (const address of sorted) {
    const fn = candidates.get(address);
    const own = [...new Set(fn?.calls ?? [])].filter((c) => c !== address && candidates.has(c));
    edges.set(address, own.sort());
  }
  const graph = condense(sorted, edges);
  const { components, componentOf } = graph.scc;

  // Split oversized components into groups of at most `maxGroup` members.
  const groupOf = new Map<string, string | undefined>();
  components.forEach((members) => {
    if (members.length === 1) {
      groupOf.set(members[0] ?? '', undefined);
      return;
    }
    for (let i = 0; i < members.length; i += maxGroup) {
      const chunk = members.slice(i, i + maxGroup);
      const id = `scc_${(chunk[0] ?? '').slice(2)}`;
      for (const member of chunk) groupOf.set(member, chunk.length > 1 ? id : undefined);
    }
  });

  const tasks = head();
  let leaves = 0;
  for (const members of components) {
    for (const address of members) {
      const fn = candidates.get(address);
      if (!fn) continue;
      const own = componentOf.get(address);
      const callees = (edges.get(address) ?? [])
        // Callees in the same component are the group's business, not an ordering constraint.
        .filter((c) => componentOf.get(c) !== own)
        .map(functionTaskId);
      if (callees.length === 0) leaves++;
      const hash = options.inputHashes?.get(address);
      tasks.push(
        makeTask({
          id: functionTaskId(address),
          kind: 'function',
          title: `${fn.name} @ ${address}`,
          address,
          dependsOn: mode === 'complete' ? ['types', ...callees] : ['types'],
          softDependsOn: mode === 'adaptive' ? callees : [],
          ...(groupOf.get(address) ? { group: groupOf.get(address) as string } : {}),
          priority: graph.height[own ?? 0] ?? 0,
          ...(hash ? { inputHash: hash } : {}),
        }),
      );
    }
  }
  return {
    tasks,
    excluded,
    stats: {
      functionTasks: tasks.length - 2,
      components: components.length,
      largestComponent: components.reduce((max, c) => Math.max(max, c.length), 0),
      criticalPath: graph.depth.reduce((max, d) => Math.max(max, d + 1), 0),
      leaves,
    },
  };
}

/**
 * The original planner (kept for `scheduler.mode: "legacy"` and as the baseline of the benchmarks): depth-first
 * traversal, back edges dropped, every callee a hard dependency. Recursive, so extremely deep call chains are
 * limited by the JavaScript stack.
 */
export function planTasksLegacy(functions: FunctionInfo[], options: PlanOptions = {}): Plan {
  const { candidates, excluded } = selectCandidates(functions);
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
  const tasks = [
    ...head(),
    ...order.map((fn) => {
      const hash = options.inputHashes?.get(fn.address);
      return makeTask({
        id: functionTaskId(fn.address),
        kind: 'function',
        title: `${fn.name} @ ${fn.address}`,
        address: fn.address,
        dependsOn: ['types', ...(deps.get(fn.address) ?? [])],
        ...(hash ? { inputHash: hash } : {}),
      });
    }),
  ];
  return {
    tasks,
    excluded,
    stats: {
      functionTasks: order.length,
      components: order.length,
      largestComponent: 1,
      criticalPath: 0,
      leaves: tasks.filter((t) => t.kind === 'function' && t.dependsOn.length === 1).length,
    },
  };
}
