import type { RecodeConfig } from '../../infrastructure/config/config.js';
import type { Dossier } from '../../decompiler/analysis/store.js';

export const TIERS = ['fast', 'standard', 'advanced', 'expert'] as const;
export type Tier = (typeof TIERS)[number];

export const isTier = (value: string | undefined): value is Tier =>
  value !== undefined && (TIERS as readonly string[]).includes(value);

export const tierIndex = (tier: Tier): number => TIERS.indexOf(tier);

export interface TierSpec {
  tier: Tier;
  /** Value for `claude --model`; undefined = Claude Code's default model. */
  model: string | undefined;
  maxConcurrent: number | undefined;
  contextTokens: number;
  batchSize: number | undefined;
}

/** Tier -> concrete model settings, resolved from the configuration (never hard-coded model IDs). */
export type ModelTable = Record<Tier, TierSpec>;

export function buildModelTable(config: RecodeConfig): ModelTable {
  const fixedModel = config.claude.model;
  const fixed = config.routing.mode === 'fixed' || fixedModel !== undefined;
  const make = (tier: Tier): TierSpec => {
    const t = config.routing.tiers[tier];
    return {
      tier,
      model: fixed ? fixedModel : t.model,
      maxConcurrent: t.maxConcurrent,
      contextTokens: t.contextTokens ?? 200_000,
      batchSize: t.batchSize,
    };
  };
  return {
    fast: make('fast'),
    standard: make('standard'),
    advanced: make('advanced'),
    expert: make('expert'),
  };
}

/** True when the configuration pins one model for every task (no routing, no escalation). */
export function isFixedRouting(config: RecodeConfig): boolean {
  return config.routing.mode === 'fixed' || config.claude.model !== undefined;
}

export interface RouteDecision {
  tier: Tier;
  score: number;
  /** Short, machine-written reasons (never text from the binary). */
  reasons: string[];
  /** Rough size of the model input for batching decisions. */
  estimatedInputTokens: number;
}

const sat = (value: number, full: number): number => Math.max(0, Math.min(1, value / full));

export interface ScoreContext {
  /** Members of the function's strongly connected component (1 = not mutually recursive). */
  sccSize: number;
  /** Extra difficulty learned from earlier failures of similar functions (0-25). */
  historyBoost?: number;
}

/**
 * Difficulty of reconstructing a function, 0-100, from measured properties only. Each contribution is capped, so
 * one extreme value cannot dominate, and every contribution above a minimum is reported as a reason.
 */
export function difficultyScore(
  dossier: Dossier,
  context: ScoreContext,
): { score: number; reasons: string[] } {
  const m = dossier.metrics;
  const parts: Array<[string, number]> = [
    [`size ${m.codeLines} lines`, sat(m.codeLines, 200) * 18],
    [`cyclomatic ${m.cyclomatic}`, sat(m.cyclomatic - 1, 30) * 16],
    [`${m.basicBlocks} basic blocks`, sat(m.basicBlocks, 60) * 6],
    [`nesting ${m.maxNesting}`, sat(m.maxNesting - 2, 6) * 5],
    [`${m.gotos} gotos`, sat(m.gotos, 6) * 5],
    [`${m.pointerArithmetic} pointer-arithmetic expressions`, sat(m.pointerArithmetic, 10) * 10],
    [`${m.memoryAccesses} memory accesses`, sat(m.memoryAccesses, 30) * 6],
    [`${m.distinctOffsets} distinct struct offsets`, sat(m.distinctOffsets, 16) * 8],
    [`${m.indirectCalls} indirect calls`, sat(m.indirectCalls, 3) * 12],
    [`${m.computedJumps} computed jumps`, sat(m.computedJumps, 2) * 6],
    [`${m.directCalls} callees`, sat(m.directCalls, 15) * 4],
    ['self-recursive', m.selfRecursive ? 8 : 0],
    [
      `mutual recursion (${context.sccSize} functions)`,
      context.sccSize > 1 ? 4 + sat(context.sccSize, 4) * 4 : 0,
    ],
    [`${m.undefinedTypes} undefined types`, sat(m.undefinedTypes, 8) * 5],
    [`${m.unresolvedVariables} unresolved variables`, sat(m.unresolvedVariables, 10) * 4],
    [`${m.intrinsics} unlifted intrinsics`, sat(m.intrinsics, 8) * 5],
    [`${m.decompilerWarnings} decompiler warnings`, sat(m.decompilerWarnings, 1) * 10],
    ['decompilation failed (assembly only)', m.decompileFailed ? 25 : 0],
    [`${m.floatingPoint} floating-point tokens`, sat(m.floatingPoint, 10) * 3],
    [`${m.bitOperations} bit operations`, sat(m.bitOperations, 20) * 4],
    ['similar functions failed before', context.historyBoost ?? 0],
  ];
  const score = Math.min(
    100,
    parts.reduce((sum, [, v]) => sum + v, 0),
  );
  const reasons = parts
    .filter(([, v]) => v >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([label, v]) => `${label} (+${v.toFixed(0)})`);
  return { score: Math.round(score * 10) / 10, reasons };
}

/** Functions that qualify for the fast tier: small, flat, fully lifted. A high score never does. */
function isTrivial(d: Dossier): boolean {
  const m = d.metrics;
  return (
    !m.decompileFailed &&
    m.codeLines <= 30 &&
    m.cyclomatic <= 5 &&
    m.indirectCalls === 0 &&
    m.computedJumps === 0 &&
    m.decompilerWarnings === 0 &&
    m.pointerArithmetic <= 2 &&
    m.directCalls <= 3 &&
    !m.selfRecursive &&
    m.gotos === 0
  );
}

export function estimateInputTokens(chars: number): number {
  // Conservative: code tokenizes at roughly 3-4 characters per token; add the fixed instruction overhead.
  return Math.ceil(chars / 3.2) + 4_000;
}

export function routeFunction(
  dossier: Dossier,
  config: RecodeConfig,
  context: ScoreContext & { inputChars?: number },
): RouteDecision {
  const { score, reasons } = difficultyScore(dossier, context);
  const estimatedInputTokens = estimateInputTokens(
    context.inputChars ?? dossier.metrics.codeLines * 60,
  );
  if (isFixedRouting(config)) {
    return { tier: 'standard', score, reasons: ['fixed model configured'], estimatedInputTokens };
  }
  const t = config.routing.thresholds;
  let tier: Tier = 'standard';
  if (score >= t.expert) tier = 'expert';
  else if (score >= t.advanced) tier = 'advanced';
  else if (score < t.standard && isTrivial(dossier)) tier = 'fast';
  const why =
    tier === 'fast'
      ? ['trivial: small, flat, fully lifted']
      : reasons.length > 0
        ? reasons
        : ['ordinary function'];
  return { tier, score, reasons: why, estimatedInputTokens };
}

/** Tier for tasks that are not functions. */
export function routeKind(kind: 'overview' | 'types', config: RecodeConfig): Tier {
  if (isFixedRouting(config)) return 'standard';
  return kind === 'types' ? 'advanced' : 'standard';
}

/** Models that answered a probe (or all, when probing is off). Tiers not in the set are unusable. */
export type Availability = ReadonlySet<Tier>;

/** The requested tier, or the nearest higher usable one (else the nearest lower one); undefined if none. */
export function effectiveTier(tier: Tier, available: Availability): Tier | undefined {
  for (let i = tierIndex(tier); i < TIERS.length; i++) {
    const candidate = TIERS[i];
    if (candidate && available.has(candidate)) return candidate;
  }
  for (let i = tierIndex(tier) - 1; i >= 0; i--) {
    const candidate = TIERS[i];
    if (candidate && available.has(candidate)) return candidate;
  }
  return undefined;
}

/** Next stronger usable tier. Tiers that resolve to the same model as the current one are skipped (no gain). */
export function nextTier(tier: Tier, table: ModelTable, available: Availability): Tier | undefined {
  for (let i = tierIndex(tier) + 1; i < TIERS.length; i++) {
    const candidate = TIERS[i];
    if (!candidate || !available.has(candidate)) continue;
    if (table[candidate].model === table[tier].model) continue;
    return candidate;
  }
  return undefined;
}
