import type { TaskHistoryEntry } from '../../core/tasks/task-store.js';
import type { Finding } from '../../validation/static/function-validator.js';
import { nextTier, type Availability, type ModelTable, type Tier } from './router.js';

export type EscalationAction =
  /** Keep the result. `issues` are recorded for the report (warnings the model could not resolve). */
  | { action: 'accept'; issues: string[] }
  /** Run again with a stronger model; it receives the previous result and the findings. */
  | { action: 'escalate'; tier: Tier; reason: string }
  /** Run again at the same tier because the findings are new information for the model. */
  | { action: 'retry'; reason: string }
  /** No stronger model left and nothing new to tell the current one. */
  | { action: 'give-up'; reason: string };

export interface EscalationInput {
  tier: Tier;
  table: ModelTable;
  available: Availability;
  escalationEnabled: boolean;
  /** Findings of the deterministic validators for the new result. */
  findings: readonly Finding[];
  /** The session produced no usable result file (crash, timeout, invalid JSON). */
  noResult: boolean;
  history: readonly TaskHistoryEntry[];
}

/** Stable key of a finding set: the same problems at the same tier are not new information. */
export function findingsKey(findings: readonly Finding[]): string {
  return findings
    .filter((f) => f.severity !== 'info')
    .map((f) => `${f.code}`)
    .sort()
    .join(',');
}

const KEY_PREFIX = 'key:';

/** History entries carry the findings key as an issue `key:<codes>` so repeats can be recognized. */
export function keyIssue(findings: readonly Finding[]): string {
  return `${KEY_PREFIX}${findingsKey(findings)}`;
}

/**
 * Decides what happens after a model produced (or failed to produce) a result:
 * 1. Clean result (no errors, not speculative): accept.
 * 2. Otherwise move to the next stronger model that differs from the current one, with the previous result and
 *    findings as input, so the stronger model refines instead of starting over.
 * 3. At the strongest model: one more attempt, but only if the findings differ from everything already tried at
 *    this tier (a repeat without new information cannot help); then stop and record the open issues.
 * A session that produced nothing is retried at the same tier: there is no result to learn from yet.
 */
export function decideEscalation(input: EscalationInput): EscalationAction {
  const errors = input.findings.filter((f) => f.severity === 'error');
  const weak = input.findings.some(
    (f) => f.code === 'speculative' || f.code === 'many-speculative-assumptions',
  );
  const open = input.findings
    .filter((f) => f.severity !== 'info')
    .map((f) => `${f.code}: ${f.message}`);

  if (input.noResult) return { action: 'retry', reason: 'the session produced no usable result' };
  if (errors.length === 0 && !weak) return { action: 'accept', issues: open };

  const reason =
    errors.length > 0
      ? `${errors.length} validation error(s): ${[...new Set(errors.map((e) => e.code))].join(', ')}`
      : 'the model rated its result as speculative';
  if (input.escalationEnabled) {
    const next = nextTier(input.tier, input.table, input.available);
    if (next) return { action: 'escalate', tier: next, reason };
  }
  // Top of the ladder (or escalation off): repeat only with new information.
  const key = keyIssue(input.findings);
  const triedHere = input.history.filter((h) => h.tier === input.tier && h.outcome === 'rejected');
  const seen = triedHere.some((h) => h.issues.includes(key));
  if (errors.length > 0 && !seen && triedHere.length < 2) {
    return { action: 'retry', reason: `${reason}; the findings are new for this model` };
  }
  if (errors.length === 0) return { action: 'accept', issues: open };
  return { action: 'give-up', reason: `${reason}; no stronger model and no new information` };
}
