import path from 'node:path';
import { z } from 'zod';
import { readJsonIfExists, sha256Text, writeJsonAtomic } from '../filesystem/files.js';

export const CachedResultSchema = z.object({
  schemaVersion: z.literal(1),
  key: z.string(),
  kind: z.enum(['overview', 'types', 'function']),
  /** Tier of the model that produced the payload; a request for a weaker tier may reuse it. */
  tier: z.string(),
  model: z.string().optional(),
  /** Concrete model the CLI reported, for the record. */
  resolvedModel: z.string().optional(),
  createdAt: z.string(),
  /**
   * Callee address -> hash of the reconstructed prototype the result was written against. The entry is only valid
   * while those callees still have exactly these prototypes.
   */
  deps: z.record(z.string(), z.string()).default({}),
  /** The exact content of the result file the agent wrote. */
  payload: z.string(),
});
export type CachedResult = z.infer<typeof CachedResultSchema>;
export type CachedResultInput = Omit<
  z.input<typeof CachedResultSchema>,
  'schemaVersion' | 'createdAt'
>;

/** Hash of the parts that decide whether a stored result is still valid. Order matters. */
export function cacheKey(parts: readonly string[]): string {
  return sha256Text(JSON.stringify(parts));
}

/**
 * Content-addressed store of accepted results (`.recode/cache/results/<aa>/<key>.json`). Entries are never
 * modified, only replaced by a result of a stronger tier; a corrupt entry is treated as a miss.
 */
export class ResultCache {
  hits = 0;
  misses = 0;
  stores = 0;

  constructor(
    private readonly directory: string,
    private readonly enabled = true,
  ) {}

  private fileFor(key: string): string {
    return path.join(this.directory, key.slice(0, 2), `${key}.json`);
  }

  async get(key: string): Promise<CachedResult | undefined> {
    if (!this.enabled) return undefined;
    const entry = await readJsonIfExists(this.fileFor(key), CachedResultSchema).catch(
      () => undefined,
    );
    if (entry && entry.key === key) {
      this.hits++;
      return entry;
    }
    this.misses++;
    return undefined;
  }

  async put(entry: CachedResultInput): Promise<void> {
    if (!this.enabled) return;
    await writeJsonAtomic(
      this.fileFor(entry.key),
      { schemaVersion: 1, createdAt: new Date().toISOString(), ...entry },
      { durable: false },
    );
    this.stores++;
  }

  get hitRate(): number {
    const total = this.hits + this.misses;
    return total === 0 ? 0 : this.hits / total;
  }
}
