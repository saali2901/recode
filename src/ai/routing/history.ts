import { z } from 'zod';
import type { Dossier } from '../../decompiler/analysis/store.js';
import { readJsonIfExists, writeJsonAtomic } from '../../infrastructure/filesystem/files.js';

const HistorySchema = z.object({
  schemaVersion: z.literal(1),
  /** bucket -> tier -> { runs, weak } where "weak" counts results that needed escalation or failed validation. */
  buckets: z.record(
    z.string(),
    z.record(z.string(), z.object({ runs: z.number(), weak: z.number() })),
  ),
});
type History = z.infer<typeof HistorySchema>;

/** Coarse feature bucket of a function: similar functions share a bucket. */
export function bucketOf(d: Dossier): string {
  const m = d.metrics;
  const size = m.codeLines <= 30 ? 's' : m.codeLines <= 120 ? 'm' : 'l';
  const ptr = m.pointerArithmetic + m.distinctOffsets > 8 ? 'p' : '-';
  return [
    size,
    ptr,
    m.indirectCalls > 0 ? 'i' : '-',
    m.selfRecursive ? 'r' : '-',
    m.decompilerWarnings > 0 ? 'w' : '-',
  ].join('');
}

const MIN_RUNS = 4;

/**
 * Remembers how often functions of a bucket needed escalation at a tier ("similar functions failed before").
 * Persisted per project so later runs start routing with the experience of earlier ones.
 */
export class RoutingHistory {
  private data: History = { schemaVersion: 1, buckets: {} };
  private dirty = false;

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    this.data =
      (await readJsonIfExists(this.file, HistorySchema).catch(() => undefined)) ?? this.data;
  }

  record(bucket: string, tier: string, weak: boolean): void {
    const byTier = (this.data.buckets[bucket] ??= {});
    const entry = (byTier[tier] ??= { runs: 0, weak: 0 });
    entry.runs++;
    if (weak) entry.weak++;
    this.dirty = true;
  }

  /** Extra difficulty (0-25) if functions like this one were often weak at the given tier. */
  boost(bucket: string, tier: string): number {
    const entry = this.data.buckets[bucket]?.[tier];
    if (!entry || entry.runs < MIN_RUNS) return 0;
    const rate = entry.weak / entry.runs;
    return Math.round(Math.max(0, Math.min(1, (rate - 0.25) / 0.5)) * 25);
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    await writeJsonAtomic(this.file, this.data);
  }
}
