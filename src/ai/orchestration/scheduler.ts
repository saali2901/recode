import os from 'node:os';
import type { RecodeConfig } from '../../infrastructure/config/config.js';
import type { Task } from '../../core/tasks/task-store.js';
import { TIERS, isTier, tierIndex, type ModelTable, type Tier } from '../routing/router.js';

export interface ResourceProbe {
  /** 1-minute load average divided by the number of CPUs. */
  loadPerCpu(): number;
  /** Free RAM as a fraction of total RAM. */
  freeMemoryFraction(): number;
}

export const systemProbe: ResourceProbe = {
  loadPerCpu: () => (os.loadavg()[0] ?? 0) / Math.max(1, os.cpus().length),
  freeMemoryFraction: () => os.freemem() / Math.max(1, os.totalmem()),
};

/**
 * Concurrency controller for Claude Code sessions (AIMD): +1 after `limit` consecutive healthy sessions, halved on
 * a failed session, never above `max`, never below 1. While the machine is loaded or short on RAM no session is
 * added (running ones continue). The bound is a hard cap, not a suggestion: `canStart` is checked before every launch.
 */
export class AdaptiveLimiter {
  private limit: number;
  private streak = 0;
  adjustments = 0;

  constructor(
    private readonly options: {
      initial: number;
      max: number;
      maxLoadPerCpu: number;
      minFreeMemoryFraction: number;
      probe?: ResourceProbe;
    },
  ) {
    this.limit = Math.max(1, Math.min(options.initial, options.max));
  }

  get current(): number {
    return this.limit;
  }

  canStart(running: number): boolean {
    if (running >= this.limit) return false;
    if (running === 0) return true; // always make progress
    const probe = this.options.probe ?? systemProbe;
    return (
      probe.loadPerCpu() <= this.options.maxLoadPerCpu &&
      probe.freeMemoryFraction() >= this.options.minFreeMemoryFraction
    );
  }

  recordSuccess(): void {
    this.streak++;
    if (this.streak >= this.limit && this.limit < this.options.max) {
      this.limit++;
      this.streak = 0;
      this.adjustments++;
    }
  }

  recordFailure(): void {
    this.streak = 0;
    const next = Math.max(1, Math.floor(this.limit / 2));
    if (next !== this.limit) {
      this.limit = next;
      this.adjustments++;
    }
  }
}

export interface Candidate {
  task: Task;
  /** True when a soft dependency is still open (the task runs against Ghidra signatures). */
  relaxed: boolean;
  tier: Tier;
  inputTokens: number;
}

export interface PickLimits {
  table: ModelTable;
  config: RecodeConfig;
  /** Sessions currently running per tier. */
  runningByTier: ReadonlyMap<Tier, number>;
  /** Share of the model's context window one batch may fill with task input. */
  contextShare?: number;
}

export function batchSizeFor(tier: Tier, limits: PickLimits): number {
  const fixed = limits.config.routing.mode === 'fixed' || limits.config.claude.model !== undefined;
  const own = fixed ? undefined : limits.table[tier].batchSize;
  return own ?? limits.config.claude.batchSize;
}

/**
 * Chooses the next batch from the candidates, or undefined if nothing can start. Rules:
 * - highest critical-path priority first, stronger tiers first among equals (long poles start early);
 * - tiers at their `maxConcurrent` are skipped;
 * - one batch = one tier (the session runs one model), at most `batchSize` function tasks, and the summed task
 *   input stays within `contextShare` of the tier's context window;
 * - all members of a mutually recursive group go together (they need consistent prototypes), even beyond the limit;
 * - overview/types run alone.
 */
export function pickBatch(
  candidates: readonly Candidate[],
  limits: PickLimits,
): Candidate[] | undefined {
  const share = limits.contextShare ?? 0.35;
  const sorted = [...candidates].sort(
    (a, b) =>
      b.task.priority - a.task.priority ||
      tierIndex(b.tier) - tierIndex(a.tier) ||
      a.task.id.localeCompare(b.task.id),
  );
  const capped = (tier: Tier): boolean => {
    const cap = limits.table[tier].maxConcurrent;
    return cap !== undefined && (limits.runningByTier.get(tier) ?? 0) >= cap;
  };
  const head = sorted.find((c) => !capped(c.tier));
  if (!head) return undefined;
  if (head.task.kind !== 'function') return [head];

  const batch: Candidate[] = [head];
  const taken = new Set([head.task.id]);
  let tokens = head.inputTokens;
  const groupId = head.task.group;
  if (groupId) {
    for (const c of sorted) {
      if (c.task.group === groupId && !taken.has(c.task.id)) {
        batch.push(c);
        taken.add(c.task.id);
        tokens += c.inputTokens;
      }
    }
  }
  const limit = batchSizeFor(head.tier, limits);
  const budget = limits.table[head.tier].contextTokens * share;
  for (const c of sorted) {
    if (batch.length >= limit) break;
    if (taken.has(c.task.id) || c.task.kind !== 'function' || c.tier !== head.tier) continue;
    if (c.relaxed !== head.relaxed || c.task.group) continue; // groups only travel with their own members
    if (tokens + c.inputTokens > budget) continue;
    batch.push(c);
    taken.add(c.task.id);
    tokens += c.inputTokens;
  }
  return batch;
}

export const tierOfTask = (task: Task): Tier => (isTier(task.tier) ? task.tier : 'standard');

export { TIERS };
