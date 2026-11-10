import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { RecodeError } from '../../core/errors/index.js';
import { pathExists, readJson, writeJsonAtomic } from '../filesystem/files.js';

const GIB = 1024 ** 3;

const TierSchema = z
  .object({
    /** Model alias or ID passed to `claude --model`. Empty = Claude Code's default model. */
    model: z.string().min(1).optional(),
    /** Maximum number of concurrent sessions that use this tier (model capacity / rate limits). */
    maxConcurrent: z.number().int().min(1).max(16).optional(),
    /** Context window of the model in tokens; batches are sized to stay well below it. */
    contextTokens: z.number().int().min(8_000).optional(),
    /** Maximum number of function tasks per session at this tier. */
    batchSize: z.number().int().min(1).max(50).optional(),
  })
  .strict();

const RoutingSchema = z
  .object({
    /** `auto`: every task gets the tier its measured difficulty needs. `fixed`: one model for everything. */
    mode: z.enum(['auto', 'fixed']).default('auto'),
    tiers: z
      .object({
        /** Trivial functions: getters, wrappers, tiny arithmetic. */
        fast: TierSchema.default({ model: 'haiku', contextTokens: 200_000, batchSize: 12 }),
        /** Ordinary reconstruction. */
        standard: TierSchema.default({ model: 'sonnet', contextTokens: 200_000 }),
        /** Complex algorithms, heavy pointer arithmetic, indirect calls, recursion. */
        advanced: TierSchema.default({ model: 'opus', contextTokens: 200_000, batchSize: 3 }),
        /** Review and last resort for functions that failed at lower tiers. */
        expert: TierSchema.default({ model: 'opus', contextTokens: 200_000, batchSize: 1 }),
      })
      .strict()
      .default({
        fast: { model: 'haiku', contextTokens: 200_000, batchSize: 12 },
        standard: { model: 'sonnet', contextTokens: 200_000 },
        advanced: { model: 'opus', contextTokens: 200_000, batchSize: 3 },
        expert: { model: 'opus', contextTokens: 200_000, batchSize: 1 },
      }),
    /** Difficulty score (0-100) from which a function needs the tier. */
    thresholds: z
      .object({
        standard: z.number().min(0).max(100).default(15),
        advanced: z.number().min(0).max(100).default(45),
        expert: z.number().min(0).max(100).default(80),
      })
      .strict()
      .default({ standard: 15, advanced: 45, expert: 80 }),
    /** Check once per day that each configured model answers; unavailable tiers fall back to the next higher one. */
    verifyModels: z.boolean().default(true),
    /** Re-run weak results with the next tier, handing over the previous result and findings. */
    escalation: z.boolean().default(true),
  })
  .strict()
  .default({
    mode: 'auto',
    tiers: {
      fast: { model: 'haiku', contextTokens: 200_000, batchSize: 12 },
      standard: { model: 'sonnet', contextTokens: 200_000 },
      advanced: { model: 'opus', contextTokens: 200_000, batchSize: 3 },
      expert: { model: 'opus', contextTokens: 200_000, batchSize: 1 },
    },
    thresholds: { standard: 15, advanced: 45, expert: 80 },
    verifyModels: true,
    escalation: true,
  });

const SchedulerSchema = z
  .object({
    /** Dependency handling: see `DependencyMode`. `legacy` reproduces the original sequential behaviour. */
    mode: z.enum(['adaptive', 'complete', 'signatures', 'legacy']).default('adaptive'),
    /** Upper bound of concurrent Claude Code sessions. The scheduler adapts between 1 and this value. */
    maxSessions: z.number().int().min(1).max(16).default(4),
    /** Concurrency at the start of a run. */
    initialSessions: z.number().int().min(1).max(16).default(2),
    /** Largest group of mutually recursive functions handled in one session. */
    maxGroupSize: z.number().int().min(2).max(100).default(24),
    /** Stop adding sessions while the 1-minute load average per CPU exceeds this value. */
    maxLoadPerCpu: z.number().min(0.1).max(4).default(0.9),
    /** Stop adding sessions while less than this fraction of RAM is free. */
    minFreeMemoryFraction: z.number().min(0).max(0.9).default(0.1),
  })
  .strict()
  .default({
    mode: 'adaptive',
    maxSessions: 4,
    initialSessions: 2,
    maxGroupSize: 24,
    maxLoadPerCpu: 0.9,
    minFreeMemoryFraction: 0.1,
  });

export const ConfigSchema = z
  .object({
    tools: z
      .object({
        ghidraInstallDir: z.string().optional(),
        claudeCommand: z.string().min(1).default('claude'),
        cmakeCommand: z.string().min(1).default('cmake'),
        ninjaCommand: z.string().min(1).default('ninja'),
        cCompiler: z.string().optional(),
        javaCommand: z.string().min(1).default('java'),
        /** Dolphin's command-line tool; only needed for compressed GameCube discs (RVZ, WIA, ...). */
        dolphinToolCommand: z.string().min(1).optional(),
      })
      .strict()
      .default({
        claudeCommand: 'claude',
        cmakeCommand: 'cmake',
        ninjaCommand: 'ninja',
        javaCommand: 'java',
      }),
    claude: z
      .object({
        model: z.string().optional(),
        /** Maximum number of subagents the lead agent may run concurrently. */
        maxParallelAgents: z.number().int().min(1).max(8).default(2),
        /** Maximum number of function tasks handed to one lead-agent session. */
        batchSize: z.number().int().min(1).max(50).default(6),
        maxTurns: z.number().int().min(1).max(500).default(80),
        sessionTimeoutMinutes: z.number().min(1).max(720).default(45),
        maxAttempts: z.number().int().min(1).max(10).default(3),
      })
      .strict()
      .default({
        maxParallelAgents: 2,
        batchSize: 6,
        maxTurns: 80,
        sessionTimeoutMinutes: 45,
        maxAttempts: 3,
      }),
    ghidra: z
      .object({
        analysisTimeoutSeconds: z.number().int().min(30).default(1800),
        maxFunctions: z.number().int().min(1).default(20_000),
        /**
         * Decompiler threads inside Ghidra's export script (one decompiler process per thread). 1 = the original
         * sequential export. Values above 1 are experimental: the Java path was not run against a real Ghidra.
         */
        decompilerThreads: z.number().int().min(1).max(16).default(1),
      })
      .strict()
      .default({ analysisTimeoutSeconds: 1800, maxFunctions: 20_000, decompilerThreads: 1 }),
    routing: RoutingSchema,
    scheduler: SchedulerSchema,
    cache: z
      .object({
        /** Reuse accepted reconstructions across runs and re-analyses (content-addressed). */
        enabled: z.boolean().default(true),
      })
      .strict()
      .default({ enabled: true }),
    validation: z
      .object({
        /** Compile every accepted function on its own (syntax only) before the full build. */
        compileCheck: z.enum(['auto', 'off']).default('auto'),
        /** Build -> targeted repair rounds that `recode run` performs after the first build. */
        autoRepairRounds: z.number().int().min(0).max(5).default(2),
        /** JSON file describing a differential test against reference code (see docs/validation.md). */
        differentialSpec: z.string().min(1).optional(),
      })
      .strict()
      .default({ compileCheck: 'auto', autoRepairRounds: 2 }),
    archive: z
      .object({
        maxFiles: z.number().int().min(1).default(1000),
        maxTotalBytes: z
          .number()
          .int()
          .min(1)
          .default(1 * GIB),
        maxFileBytes: z
          .number()
          .int()
          .min(1)
          .default(512 * 1024 ** 2),
        maxCompressionRatio: z.number().min(1).default(200),
      })
      .strict()
      .default({
        maxFiles: 1000,
        maxTotalBytes: GIB,
        maxFileBytes: 512 * 1024 ** 2,
        maxCompressionRatio: 200,
      }),
    build: z
      .object({
        timeoutSeconds: z.number().int().min(10).default(600),
      })
      .strict()
      .default({ timeoutSeconds: 600 }),
    ui: z
      .object({
        /** Directory scanned for projects by "recode ui". */
        workspace: z.string().min(1).optional(),
      })
      .strict()
      .default({}),
    logging: z
      .object({ level: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info') })
      .strict()
      .default({ level: 'info' }),
  })
  .strict();

export type RecodeConfig = z.infer<typeof ConfigSchema>;

type Json = Record<string, unknown>;

function isPlainObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep-merges config layers; later layers win. */
export function mergeLayers(...layers: Json[]): Json {
  const result: Json = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      const existing = result[key];
      result[key] =
        isPlainObject(value) && isPlainObject(existing) ? mergeLayers(existing, value) : value;
    }
  }
  return result;
}

export function parseConfig(layer: Json): RecodeConfig {
  const parsed = ConfigSchema.safeParse(layer);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new RecodeError('INVALID_INPUT', `Invalid configuration: ${details}`);
  }
  return parsed.data;
}

export function defaultConfig(): RecodeConfig {
  return parseConfig({});
}

/** Directory holding the user-level configuration. Overridable via RECODE_HOME. */
export function userConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env['RECODE_HOME'] ??
    path.join(env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config'), 'recode')
  );
}

export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(userConfigDir(env), 'config.json');
}

const RawLayerSchema = z.record(z.string(), z.unknown());

export async function readLayer(file: string): Promise<Json> {
  if (!(await pathExists(file))) return {};
  return readJson(file, RawLayerSchema);
}

/** Environment overrides for the most important tool locations. */
export function envLayer(env: NodeJS.ProcessEnv = process.env): Json {
  const tools: Json = {};
  if (env['GHIDRA_INSTALL_DIR']) tools['ghidraInstallDir'] = env['GHIDRA_INSTALL_DIR'];
  if (env['RECODE_CLAUDE_COMMAND']) tools['claudeCommand'] = env['RECODE_CLAUDE_COMMAND'];
  return Object.keys(tools).length > 0 ? { tools } : {};
}

/** Loads defaults < user config < project config < environment. */
export async function loadConfig(options: {
  projectLayer?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
}): Promise<RecodeConfig> {
  const env = options.env ?? process.env;
  const user = await readLayer(userConfigPath(env));
  return parseConfig(mergeLayers(user, options.projectLayer ?? {}, envLayer(env)));
}

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/** Returns a copy of `layer` with a dotted key set; validates the resulting configuration. */
export function withConfigValue(layer: Json, dottedKey: string, rawValue: string): Json {
  const keys = dottedKey.split('.');
  const next: Json = structuredClone(layer);
  let cursor: Json = next;
  for (const key of keys.slice(0, -1)) {
    const child = cursor[key];
    if (isPlainObject(child)) {
      cursor = child;
    } else {
      const created: Json = {};
      cursor[key] = created;
      cursor = created;
    }
  }
  const last = keys[keys.length - 1];
  if (last === undefined || last === '') {
    throw new RecodeError('INVALID_INPUT', 'Empty configuration key.');
  }
  cursor[last] = parseValue(rawValue);
  parseConfig(next);
  return next;
}

/** Sets a dotted key in a user-level config file. */
export async function setUserConfigValue(
  file: string,
  dottedKey: string,
  rawValue: string,
): Promise<void> {
  await writeJsonAtomic(file, withConfigValue(await readLayer(file), dottedKey, rawValue));
}

export function getConfigValue(config: RecodeConfig, dottedKey: string): unknown {
  let cursor: unknown = config;
  for (const key of dottedKey.split('.')) {
    if (!isPlainObject(cursor) || !(key in cursor)) {
      throw new RecodeError('INVALID_INPUT', `Unknown configuration key: ${dottedKey}`);
    }
    cursor = cursor[key];
  }
  return cursor;
}
