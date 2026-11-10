import path from 'node:path';
import { z } from 'zod';
import type { Project } from '../../core/project/project.js';
import type { RecodeConfig } from '../../infrastructure/config/config.js';
import { readJsonIfExists, writeJsonAtomic } from '../../infrastructure/filesystem/files.js';
import { runClaude, type ClaudeRunOptions, type ClaudeRunResult } from '../claude/runner.js';
import { TIERS, buildModelTable, isFixedRouting, type Availability, type Tier } from './router.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const ProbeFileSchema = z.object({
  /** model string -> result of the last probe */
  models: z.record(
    z.string(),
    z.object({ ok: z.boolean(), at: z.string(), detail: z.string().optional() }),
  ),
});

export type ProbeRunner = (options: ClaudeRunOptions) => Promise<ClaudeRunResult>;

export interface ProbeResult {
  available: Availability;
  /** Human-readable notes (one per unusable tier / fallback). */
  warnings: string[];
  /** model string (or "default") -> usable */
  probed: Record<string, boolean>;
}

/**
 * Checks that every configured model really answers through the installed Claude Code, instead of assuming that an
 * alias exists. One tiny request per distinct model; results are cached for 24 h in `.recode/models.json`.
 * Rate limits and trust problems are not model problems: the model counts as available then.
 */
export async function probeModels(options: {
  project: Project;
  config: RecodeConfig;
  run?: ProbeRunner;
  now?: () => number;
  signal?: AbortSignal | undefined;
}): Promise<ProbeResult> {
  const { project, config } = options;
  const table = buildModelTable(config);
  const all = new Set<Tier>(TIERS);
  if (isFixedRouting(config) || !config.routing.verifyModels) {
    return { available: all, warnings: [], probed: {} };
  }
  const now = options.now ?? Date.now;
  const run = options.run ?? runClaude;
  const file = path.join(project.paths.state, 'models.json');
  const cached = (await readJsonIfExists(file, ProbeFileSchema).catch(() => undefined)) ?? {
    models: {},
  };

  const models = [...new Set(TIERS.map((t) => table[t].model ?? 'default'))];
  const probed: Record<string, boolean> = {};
  const warnings: string[] = [];
  for (const model of models) {
    const hit = cached.models[model];
    if (hit && now() - Date.parse(hit.at) < DAY_MS && hit.ok) {
      probed[model] = true;
      continue;
    }
    let ok = true;
    let detail: string | undefined;
    try {
      const result = await run({
        command: config.tools.claudeCommand,
        prompt: 'Reply with the single word: ok',
        cwd: project.root,
        agent: 'recode-binary-analyst',
        availableTools: ['Read'],
        allowedTools: ['Read'],
        ...(model !== 'default' ? { model } : {}),
        maxTurns: 1,
        timeoutMs: 120_000,
        signal: options.signal,
      });
      // A blocked session (limit, trust) says nothing about the model.
      if (!result.ok && !result.blocked) {
        ok = false;
        detail = result.failure?.slice(0, 200);
      }
    } catch (error) {
      if ((error as { code?: string }).code === 'CANCELLED') throw error;
      ok = false;
      detail = (error as Error).message.slice(0, 200);
    }
    probed[model] = ok;
    cached.models[model] = { ok, at: new Date(now()).toISOString(), ...(detail ? { detail } : {}) };
    if (!ok) warnings.push(`Model "${model}" did not answer: ${detail ?? 'no details'}.`);
  }
  await writeJsonAtomic(file, cached).catch(() => undefined);
  const available = new Set<Tier>(
    TIERS.filter((t) => probed[table[t].model ?? 'default'] !== false),
  );
  for (const tier of TIERS) {
    if (!available.has(tier))
      warnings.push(`Tier "${tier}" is unavailable; tasks fall back to the nearest usable tier.`);
  }
  return { available, warnings, probed };
}
