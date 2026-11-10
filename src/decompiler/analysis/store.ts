import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { HexSchema } from '../../input/interfaces/types.js';
import { mapLimit } from '../../infrastructure/concurrency.js';
import {
  pathExists,
  readJson,
  sha256Text,
  writeFileAtomic,
} from '../../infrastructure/filesystem/files.js';
import { ANALYSIS_FILES } from '../extraction/analysis-files.js';
import {
  FactsFileSchema,
  ReferencesFileSchema,
  SymbolsFileSchema,
  type FactsFile,
  type FunctionFacts,
  type FunctionInfo,
  type TypeInfo,
} from '../interfaces/schemas.js';
import { METRICS_VERSION, computeMetrics, type FunctionMetrics } from './metrics.js';

export const FACTS_FILE = 'facts.json';
export const STORE_FILE = 'store.json';

const MAX_LIST = 40;
const MAX_STRING = 160;

const CalleeSchema = z.object({
  address: HexSchema,
  name: z.string(),
  signature: z.string(),
  external: z.boolean(),
  thunk: z.boolean(),
});

/** Everything ReCode knows about one function before any model sees it. Derived data, never source of truth. */
export const DossierSchema = z.object({
  address: HexSchema,
  name: z.string(),
  signature: z.string(),
  returnType: z.string().optional(),
  callingConvention: z.string().nullish(),
  parameterCount: z.number().int().optional(),
  size: z.number().int(),
  /** Characters of decompiler text plus assembly the model has to read (basis for batch sizing). */
  inputChars: z.number().int(),
  /** Hash of the signature, decompiler text, assembly and call targets: identity for caching/invalidation. */
  contentHash: z.string(),
  metrics: z.custom<FunctionMetrics>(),
  callees: z.array(CalleeSchema),
  callerCount: z.number().int(),
  callers: z.array(HexSchema),
  strings: z.array(z.object({ address: HexSchema, value: z.string() })),
  globals: z.array(z.object({ address: HexSchema, name: z.string().optional() })),
  usedTypes: z.array(z.string()),
  /** Short machine-written flags describing what the decompiler could not resolve. */
  uncertainty: z.array(z.string()),
});
export type Dossier = z.infer<typeof DossierSchema>;

export interface AnalysisStore {
  dossiers: Map<string, Dossier>;
  facts: FactsFile | undefined;
  stats: { functions: number; buildMs: number; withGhidraFacts: number };
}

export async function loadFacts(dir: string): Promise<FactsFile | undefined> {
  const file = path.join(dir, FACTS_FILE);
  return (await pathExists(file)) ? readJson(file, FactsFileSchema) : undefined;
}

async function readText(file: string | null, dir: string): Promise<string | null> {
  if (!file) return null;
  return fs.readFile(path.join(dir, file), 'utf8').catch(() => null);
}

function uncertaintyFlags(m: FunctionMetrics): string[] {
  const flags: string[] = [];
  if (m.decompileFailed) flags.push('decompile-failed');
  if (m.decompilerWarnings > 0) flags.push(`decompiler-warnings:${m.decompilerWarnings}`);
  if (m.undefinedTypes > 0) flags.push(`undefined-types:${m.undefinedTypes}`);
  if (m.unresolvedVariables > 0) flags.push(`unresolved-variables:${m.unresolvedVariables}`);
  if (m.intrinsics > 0) flags.push(`unlifted-intrinsics:${m.intrinsics}`);
  if (m.indirectCalls > 0) flags.push(`indirect-calls:${m.indirectCalls}`);
  if (m.computedJumps > 0) flags.push(`computed-jumps:${m.computedJumps}`);
  if (m.gotos > 0) flags.push(`gotos:${m.gotos}`);
  return flags;
}

/**
 * Builds the dossier of every function: metrics from the decompiler text, structured facts from Ghidra (when the
 * export has them), callees, strings, globals and the program's types that the function mentions. Reads files with
 * bounded concurrency; one pass, so agents never have to assemble this themselves.
 */
export async function buildAnalysisStore(options: {
  analysisDir: string;
  functions: FunctionInfo[];
  types: TypeInfo[];
  concurrency?: number;
}): Promise<AnalysisStore> {
  const started = performance.now();
  const { analysisDir: dir, functions } = options;
  const facts = await loadFacts(dir);
  const factsByAddress = new Map<string, FunctionFacts>(
    (facts?.functions ?? []).map((f) => [f.address, f]),
  );
  const symbolNames = new Map<string, string>();
  if (await pathExists(path.join(dir, ANALYSIS_FILES.symbols))) {
    const { symbols } = await readJson(path.join(dir, ANALYSIS_FILES.symbols), SymbolsFileSchema);
    for (const s of symbols) if (!symbolNames.has(s.address)) symbolNames.set(s.address, s.name);
  }
  // Without Ghidra facts the data references have to come from references.json.
  const dataRefsFallback = new Map<string, Set<string>>();
  if (!facts && (await pathExists(path.join(dir, ANALYSIS_FILES.references)))) {
    const { references } = await readJson(
      path.join(dir, ANALYSIS_FILES.references),
      ReferencesFileSchema,
    );
    for (const r of references) {
      if (!r.fromFunction || !/DATA|READ|WRITE/i.test(r.type)) continue;
      const set = dataRefsFallback.get(r.fromFunction) ?? new Set<string>();
      set.add(r.to);
      dataRefsFallback.set(r.fromFunction, set);
    }
  }
  const stringAt = new Map((facts?.strings ?? []).map((s) => [s.address, s.value]));
  const byAddress = new Map(functions.map((f) => [f.address, f]));
  const typeNames = new Set(options.types.map((t) => t.name));

  const entries = await mapLimit(functions, options.concurrency ?? 32, async (info) => {
    const [decompiled, assembly] = await Promise.all([
      readText(info.decompiledFile, dir),
      readText(info.disassemblyFile, dir),
    ]);
    const fnFacts = factsByAddress.get(info.address);
    const metrics = computeMetrics({ info, decompiled, assembly, facts: fnFacts });
    const refs = fnFacts ? fnFacts.dataRefs : [...(dataRefsFallback.get(info.address) ?? [])];
    const strings = refs
      .filter((r) => stringAt.has(r))
      .slice(0, MAX_LIST)
      .map((address) => ({ address, value: (stringAt.get(address) ?? '').slice(0, MAX_STRING) }));
    const globals = refs
      .filter((r) => !stringAt.has(r) && !byAddress.has(r))
      .slice(0, MAX_LIST)
      .map((address) => {
        const name = symbolNames.get(address);
        return { address, ...(name ? { name } : {}) };
      });
    const usedTypes: string[] = [];
    if (decompiled && typeNames.size > 0) {
      const seen = new Set<string>();
      for (const token of decompiled.matchAll(/\b[A-Za-z_]\w*\b/g)) {
        const word = token[0];
        if (typeNames.has(word) && !seen.has(word)) {
          seen.add(word);
          if (usedTypes.length < MAX_LIST) usedTypes.push(word);
        }
      }
    }
    const callees = [...new Set(info.calls)].map((target) => {
      const callee = byAddress.get(target);
      return {
        address: target,
        name: callee?.name ?? symbolNames.get(target) ?? `FUN_${target.slice(2)}`,
        signature: callee?.signature ?? '',
        external: callee?.isExternal ?? false,
        thunk: callee?.isThunk ?? false,
      };
    });
    const dossier: Dossier = {
      address: info.address,
      name: info.name,
      signature: info.signature,
      ...(info.returnType !== undefined ? { returnType: info.returnType } : {}),
      ...(info.callingConvention !== undefined
        ? { callingConvention: info.callingConvention }
        : {}),
      ...(info.parameterCount !== undefined ? { parameterCount: info.parameterCount } : {}),
      size: info.size,
      inputChars: (decompiled?.length ?? 0) + (assembly?.length ?? 0),
      contentHash: sha256Text(
        [info.signature, info.calls.join(','), decompiled ?? '<none>', assembly ?? '<none>'].join(
          '\n--\n',
        ),
      ),
      metrics,
      callees,
      callerCount: info.calledBy.length,
      callers: info.calledBy.slice(0, MAX_LIST),
      strings,
      globals,
      usedTypes,
      uncertainty: uncertaintyFlags(metrics),
    };
    return dossier;
  });

  const dossiers = new Map(entries.map((d) => [d.address, d]));
  const store: AnalysisStore = {
    dossiers,
    facts,
    stats: {
      functions: dossiers.size,
      buildMs: Math.round(performance.now() - started),
      withGhidraFacts: factsByAddress.size,
    },
  };
  await persistStoreSummary(dir, store);
  return store;
}

/** Writes the compact, human-inspectable summary `store.json` (only when it changed, to keep mtimes stable). */
async function persistStoreSummary(dir: string, store: AnalysisStore): Promise<void> {
  const summary = {
    schemaVersion: 1,
    metricsVersion: METRICS_VERSION,
    functionCount: store.stats.functions,
    ghidraFactsFor: store.stats.withGhidraFacts,
    functions: [...store.dossiers.values()].map((d) => ({
      address: d.address,
      name: d.name,
      contentHash: d.contentHash,
      cyclomatic: d.metrics.cyclomatic,
      codeLines: d.metrics.codeLines,
      basicBlocks: d.metrics.basicBlocks,
      indirectCalls: d.metrics.indirectCalls,
      uncertainty: d.uncertainty,
    })),
  };
  const text = `${JSON.stringify(summary)}\n`;
  const file = path.join(dir, STORE_FILE);
  const existing = await fs.readFile(file, 'utf8').catch(() => undefined);
  if (existing !== text) await writeFileAtomic(file, text);
}
