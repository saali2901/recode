/**
 * Graph algorithms used by the dependency planner. All of them are iterative (no recursion), so call graphs
 * with chains of tens of thousands of functions cannot overflow the JavaScript stack.
 */

export interface SccResult {
  /** Components in reverse topological order of the condensation: callees' components come before callers'. */
  components: string[][];
  /** Node id -> index into `components`. */
  componentOf: Map<string, number>;
}

/**
 * Tarjan's strongly connected components (iterative). `edges` maps a node to the nodes it depends on (calls).
 * Edges to unknown nodes are ignored. Result order is deterministic for a given input.
 */
export function stronglyConnectedComponents(
  nodes: readonly string[],
  edges: ReadonlyMap<string, readonly string[]>,
): SccResult {
  const known = new Set(nodes);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  const componentOf = new Map<string, number>();
  let counter = 0;

  for (const root of nodes) {
    if (index.has(root)) continue;
    const work: Array<{ node: string; next: number; targets: readonly string[] }> = [];
    const open = (node: string): void => {
      index.set(node, counter);
      low.set(node, counter);
      counter++;
      stack.push(node);
      onStack.add(node);
      work.push({ node, next: 0, targets: edges.get(node) ?? [] });
    };
    open(root);
    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (!frame) break;
      if (frame.next < frame.targets.length) {
        const target = frame.targets[frame.next++];
        if (target === undefined || !known.has(target)) continue;
        if (!index.has(target)) {
          open(target);
        } else if (onStack.has(target)) {
          low.set(frame.node, Math.min(low.get(frame.node) ?? 0, index.get(target) ?? 0));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) {
        low.set(parent.node, Math.min(low.get(parent.node) ?? 0, low.get(frame.node) ?? 0));
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        for (;;) {
          const member = stack.pop();
          if (member === undefined) break;
          onStack.delete(member);
          componentOf.set(member, components.length);
          component.push(member);
          if (member === frame.node) break;
        }
        components.push(component.sort());
      }
    }
  }
  return { components, componentOf };
}

export interface Condensation {
  scc: SccResult;
  /** For every component: the components it depends on (never itself). */
  dependsOn: number[][];
  /** For every component: the components that depend on it. */
  dependents: number[][];
  /** Longest chain of dependencies below the component (0 = depends on nothing). */
  depth: number[];
  /** Longest chain of dependents above the component, counted in components (critical-path priority). */
  height: number[];
}

/** Collapses strongly connected components into a DAG and computes depth and height of every component. */
export function condense(
  nodes: readonly string[],
  edges: ReadonlyMap<string, readonly string[]>,
): Condensation {
  const scc = stronglyConnectedComponents(nodes, edges);
  const count = scc.components.length;
  const dependsOn: number[][] = Array.from({ length: count }, () => []);
  const dependents: number[][] = Array.from({ length: count }, () => []);
  scc.components.forEach((members, c) => {
    const seen = new Set<number>();
    for (const member of members) {
      for (const target of edges.get(member) ?? []) {
        const t = scc.componentOf.get(target);
        if (t === undefined || t === c || seen.has(t)) continue;
        seen.add(t);
        dependsOn[c]?.push(t);
        dependents[t]?.push(c);
      }
    }
  });
  // Components are emitted callees-first by Tarjan, so one forward and one backward pass suffice.
  const depth = new Array<number>(count).fill(0);
  for (let c = 0; c < count; c++) {
    for (const d of dependsOn[c] ?? []) depth[c] = Math.max(depth[c] ?? 0, (depth[d] ?? 0) + 1);
  }
  const height = new Array<number>(count).fill(0);
  for (let c = count - 1; c >= 0; c--) {
    for (const d of dependents[c] ?? []) height[c] = Math.max(height[c] ?? 0, (height[d] ?? 0) + 1);
  }
  return { scc, dependsOn, dependents, depth, height };
}

/** Kahn's algorithm. Returns undefined if the graph has a cycle. `edges`: node -> nodes it depends on. */
export function topologicalOrder(
  nodes: readonly string[],
  edges: ReadonlyMap<string, readonly string[]>,
): string[] | undefined {
  const remaining = new Map<string, number>();
  const reverse = new Map<string, string[]>();
  for (const node of nodes) remaining.set(node, 0);
  for (const node of nodes) {
    for (const dep of new Set(edges.get(node) ?? [])) {
      if (!remaining.has(dep)) continue;
      remaining.set(node, (remaining.get(node) ?? 0) + 1);
      const list = reverse.get(dep) ?? [];
      list.push(node);
      reverse.set(dep, list);
    }
  }
  const queue = nodes.filter((n) => remaining.get(n) === 0);
  const order: string[] = [];
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head];
    if (node === undefined) break;
    order.push(node);
    for (const next of reverse.get(node) ?? []) {
      const left = (remaining.get(next) ?? 0) - 1;
      remaining.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  return order.length === nodes.length ? order : undefined;
}
