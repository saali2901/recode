import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { RecodeError } from '../../core/errors/index.js';
import { pathExists, readJson, writeJsonAtomic } from '../filesystem/files.js';

const GIB = 1024 ** 3;

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
      })
      .strict()
      .default({ analysisTimeoutSeconds: 1800, maxFunctions: 20_000 }),
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
