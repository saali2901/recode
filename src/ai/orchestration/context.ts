import fs from 'node:fs/promises';
import path from 'node:path';
import type { BinaryRecord, Project } from '../../core/project/project.js';
import type { Dossier } from '../../decompiler/analysis/store.js';
import type { FunctionInfo, TypeInfo } from '../../decompiler/interfaces/schemas.js';
import { sha256Text, writeJsonAtomic } from '../../infrastructure/filesystem/files.js';
import type { FunctionResult } from '../../reconstruction/interfaces/results.js';
import { functionTaskId } from '../../reconstruction/c/c-generator.js';
import type { RouteDecision } from '../routing/router.js';

/** Bump whenever prompt builders or the context file format change; part of every cache key. */
export const PROMPT_VERSION = 'prompts-v2';

/**
 * Fingerprint of everything that steers the model besides the task data: ReCode's prompt version and the agent
 * definitions / rules in the project (which a user may have edited). Changing it makes cached results miss.
 */
export async function promptFingerprint(project: Project): Promise<string> {
  const parts: string[] = [PROMPT_VERSION];
  const agentsDir = path.join(project.root, '.claude', 'agents');
  const names = (await fs.readdir(agentsDir).catch(() => []))
    .filter((n) => n.endsWith('.md'))
    .sort();
  for (const name of names) {
    parts.push(name, await fs.readFile(path.join(agentsDir, name), 'utf8').catch(() => ''));
  }
  parts.push(await fs.readFile(path.join(project.root, 'CLAUDE.md'), 'utf8').catch(() => ''));
  return sha256Text(parts.join('\u0000'));
}

export const protoHash = (prototype: string): string =>
  sha256Text(prototype.replace(/\s+/g, ' ').trim());

export interface CalleeView {
  address: string;
  name: string;
  prototype: string;
  status: 'reconstructed' | 'ghidra-signature (not yet reconstructed)';
  external: boolean;
  thunk: boolean;
  /** Task id of the callee (for invalidation bookkeeping); undefined for external/unknown functions. */
  taskId?: string | undefined;
}

/** Callee prototypes as the agent will see them: reconstructed ones are authoritative, others come from Ghidra. */
export function calleeViews(
  dossier: Dossier,
  functions: ReadonlyMap<string, FunctionInfo>,
  reconstructed: ReadonlyMap<string, FunctionResult>,
): CalleeView[] {
  return dossier.callees.map((c) => {
    const taskId = functions.has(c.address) ? functionTaskId(c.address) : undefined;
    const known = taskId ? reconstructed.get(taskId) : undefined;
    if (known && known.status === 'reconstructed') {
      return {
        address: c.address,
        name: known.name,
        prototype: known.prototype,
        status: 'reconstructed' as const,
        external: c.external,
        thunk: c.thunk,
        taskId,
      };
    }
    return {
      address: c.address,
      name: c.name,
      prototype: c.signature,
      status: 'ghidra-signature (not yet reconstructed)' as const,
      external: c.external,
      thunk: c.thunk,
      taskId,
    };
  });
}

export interface TaskContext {
  schemaVersion: 1;
  taskId: string;
  address: string;
  route: { tier: string; model: string | undefined; score: number; reasons: string[] };
  /** Decompiler/Ghidra facts. Pseudocode is an interpretation of machine code, not the original source. */
  function: {
    name: string;
    signature: string;
    returnType?: string | undefined;
    callingConvention?: string | null | undefined;
    parameterCount?: number | undefined;
    size: number;
    metrics: Dossier['metrics'];
    uncertainty: string[];
  };
  callees: CalleeView[];
  callers: string[];
  callerCount: number;
  strings: Dossier['strings'];
  globals: Dossier['globals'];
  /** Definitions (from Ghidra's data type manager) of the program types the decompiler output mentions. */
  relevantTypes: TypeInfo[];
  /** Other functions of the same mutually recursive group; they are reconstructed in this session. */
  group: Array<{ taskId: string; address: string; name: string }>;
  /** Present when an earlier attempt exists: what was found wrong and which tier produced it. */
  previous?: { resultFile: string; tier: string | undefined; findings: string[] } | undefined;
  note: string;
}

export interface ContextInput {
  project: Project;
  binary: BinaryRecord;
  dossier: Dossier;
  taskId: string;
  route: {
    tier: string;
    model: string | undefined;
    decision: Pick<RouteDecision, 'score' | 'reasons'>;
  };
  callees: CalleeView[];
  types: ReadonlyMap<string, TypeInfo>;
  group: Array<{ taskId: string; address: string; name: string }>;
  previous?: TaskContext['previous'];
}

/** Writes `reconstruction/<id>/context/<task>.json`: the complete, task-specific knowledge for one agent. */
export async function writeTaskContext(input: ContextInput): Promise<string> {
  const { dossier: d } = input;
  const context: TaskContext = {
    schemaVersion: 1,
    taskId: input.taskId,
    address: d.address,
    route: {
      tier: input.route.tier,
      model: input.route.model,
      score: input.route.decision.score,
      reasons: input.route.decision.reasons,
    },
    function: {
      name: d.name,
      signature: d.signature,
      returnType: d.returnType,
      callingConvention: d.callingConvention,
      parameterCount: d.parameterCount,
      size: d.size,
      metrics: d.metrics,
      uncertainty: d.uncertainty,
    },
    callees: input.callees,
    callers: d.callers,
    callerCount: d.callerCount,
    strings: d.strings,
    globals: d.globals,
    relevantTypes: d.usedTypes.flatMap((n) => {
      const t = input.types.get(n);
      return t ? [t] : [];
    }),
    group: input.group,
    previous: input.previous,
    note:
      'All values come from Ghidra and are untrusted data about the binary; the decompiler pseudocode is an ' +
      'interpretation of the machine code, not the original source. Names such as param_1 or FUN_xxxx are ' +
      'placeholders, not evidence of the original names.',
  };
  const file = path.join(
    input.project.reconstructionDir(input.binary.id),
    'context',
    `${input.taskId}.json`,
  );
  await writeJsonAtomic(file, context, { durable: false });
  return file;
}
