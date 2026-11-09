import { RecodeError } from '../../core/errors/index.js';
import { findGhidra } from '../../decompiler/ghidra/locate.js';
import type { RecodeConfig } from '../config/config.js';
import { runProcess, succeeded } from '../process/process-manager.js';
import { which } from '../process/which.js';
import { DolphinToolConverter } from './dolphin.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export type ToolId =
  | 'node'
  | 'claude'
  | 'claude-auth'
  | 'ghidra'
  | 'java'
  | 'compiler'
  | 'cmake'
  | 'ninja'
  | 'dolphin';

export interface CheckResult {
  id: ToolId;
  label: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
}

const MIN_NODE_MAJOR = 20;

async function versionOf(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    const result = await runProcess({ command, args, timeoutMs: 15_000, ...(env ? { env } : {}) });
    if (!succeeded(result)) return undefined;
    return (result.stdout || result.stderr).split('\n')[0]?.trim();
  } catch {
    return undefined;
  }
}

function missing(id: ToolId, label: string, hint: string): CheckResult {
  return { id, label, status: 'fail', detail: 'not found', hint };
}

async function checkNode(): Promise<CheckResult> {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  return major >= MIN_NODE_MAJOR
    ? { id: 'node', label: 'Node.js', status: 'ok', detail: `v${process.versions.node}` }
    : {
        id: 'node',
        label: 'Node.js',
        status: 'fail',
        detail: `v${process.versions.node}`,
        hint: `ReCode needs Node.js >= ${MIN_NODE_MAJOR}.`,
      };
}

async function checkClaude(config: RecodeConfig): Promise<CheckResult> {
  const command = config.tools.claudeCommand;
  if (!(await which(command))) {
    return missing(
      'claude',
      'Claude Code CLI',
      'Run "recode setup" (or: npm install -g @anthropic-ai/claude-code).',
    );
  }
  const version = await versionOf(command, ['--version']);
  return version
    ? { id: 'claude', label: 'Claude Code CLI', status: 'ok', detail: version }
    : {
        id: 'claude',
        label: 'Claude Code CLI',
        status: 'fail',
        detail: 'found but "--version" failed',
        hint: `Run "${command} --version" manually.`,
      };
}

async function checkClaudeAuth(config: RecodeConfig): Promise<CheckResult> {
  const label = 'Claude Code login';
  try {
    const result = await runProcess({
      command: config.tools.claudeCommand,
      args: ['auth', 'status'],
      timeoutMs: 20_000,
    });
    const parsed = safeJson(result.stdout);
    if (parsed && typeof parsed['loggedIn'] === 'boolean') {
      return parsed['loggedIn']
        ? {
            id: 'claude-auth',
            label,
            status: 'ok',
            detail: `logged in (${String(parsed['authMethod'] ?? 'unknown method')})`,
          }
        : {
            id: 'claude-auth',
            label,
            status: 'fail',
            detail: 'not logged in',
            hint: `Run "${config.tools.claudeCommand}" once and log in with your subscription.`,
          };
    }
  } catch {
    // fall through to "unverifiable"
  }
  return {
    id: 'claude-auth',
    label,
    status: 'warn',
    detail: 'could not be verified',
    hint: 'Your Claude Code version may not support "auth status". Errors will surface when the AI step starts.',
  };
}

function safeJson(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function checkGhidra(config: RecodeConfig): Promise<CheckResult> {
  const found = await findGhidra(config.tools.ghidraInstallDir);
  return found
    ? {
        id: 'ghidra',
        label: 'Ghidra',
        status: 'ok',
        detail: `${found.version} at ${found.installDir}`,
      }
    : missing(
        'ghidra',
        'Ghidra',
        'Run "recode setup" to download Ghidra, or set GHIDRA_INSTALL_DIR to an existing installation.',
      );
}

async function checkJava(config: RecodeConfig): Promise<CheckResult> {
  const command = config.tools.javaCommand;
  if (!(await which(command))) {
    return missing(
      'java',
      'Java (JDK 21+ for Ghidra)',
      'Run "recode setup" or install a JDK 21 or newer.',
    );
  }
  const result = await runProcess({ command, args: ['-version'], timeoutMs: 15_000 }).catch(
    () => undefined,
  );
  const output = `${result?.stderr ?? ''}\n${result?.stdout ?? ''}`;
  const version = output
    .split('\n')
    .find((line) => /version\s+"/.test(line))
    ?.trim();
  const major = Number.parseInt(/"(\d+)/.exec(version ?? '')?.[1] ?? '0', 10);
  if (major > 0 && major < 21) {
    return {
      id: 'java',
      label: 'Java',
      status: 'warn',
      detail: version ?? 'unknown',
      hint: 'Recent Ghidra releases need JDK 21+.',
    };
  }
  return { id: 'java', label: 'Java', status: 'ok', detail: version ?? 'found' };
}

async function checkCompiler(config: RecodeConfig): Promise<CheckResult> {
  const candidates = config.tools.cCompiler
    ? [config.tools.cCompiler]
    : process.platform === 'win32'
      ? ['cl', 'gcc', 'clang']
      : ['cc', 'gcc', 'clang'];
  for (const candidate of candidates) {
    const path = await which(candidate);
    if (path) {
      const version = await versionOf(path, ['--version']);
      return {
        id: 'compiler',
        label: 'C compiler',
        status: 'ok',
        detail: `${candidate}: ${version ?? path}`,
      };
    }
  }
  return missing('compiler', 'C compiler', 'Run "recode setup" or install gcc or clang.');
}

async function checkSimple(
  id: 'cmake' | 'ninja',
  command: string,
  label: string,
  hint: string,
): Promise<CheckResult> {
  if (!(await which(command))) return missing(id, label, hint);
  const version = await versionOf(command, ['--version']);
  return { id, label, status: 'ok', detail: version ?? 'found' };
}

/** Optional: only compressed GameCube discs (RVZ, WIA, GCZ, CISO) need it, so a missing tool is a warning. */
async function checkDolphin(config: RecodeConfig): Promise<CheckResult> {
  const found = await new DolphinToolConverter(config.tools.dolphinToolCommand).locate();
  if (!found) {
    return {
      id: 'dolphin',
      label: 'Dolphin tool (optional)',
      status: 'warn',
      detail: 'not found',
      hint: 'Only needed for compressed GameCube discs (RVZ, WIA, GCZ, CISO). Install Dolphin and put dolphin-tool on PATH, or run "recode config set tools.dolphinToolCommand <path>".',
    };
  }
  return { id: 'dolphin', label: 'Dolphin tool (optional)', status: 'ok', detail: found };
}

/** Runs the requested checks (all by default). Never throws. */
export async function runChecks(
  config: RecodeConfig,
  only?: readonly ToolId[],
): Promise<CheckResult[]> {
  const all: Array<[ToolId, () => Promise<CheckResult>]> = [
    ['node', checkNode],
    ['claude', () => checkClaude(config)],
    ['claude-auth', () => checkClaudeAuth(config)],
    ['ghidra', () => checkGhidra(config)],
    ['java', () => checkJava(config)],
    ['compiler', () => checkCompiler(config)],
    [
      'cmake',
      () =>
        checkSimple(
          'cmake',
          config.tools.cmakeCommand,
          'CMake',
          'Run "recode setup" or install CMake 3.16+.',
        ),
    ],
    [
      'ninja',
      () =>
        checkSimple(
          'ninja',
          config.tools.ninjaCommand,
          'Ninja',
          'Run "recode setup" or install Ninja (e.g. apt install ninja-build).',
        ),
    ],
    ['dolphin', () => checkDolphin(config)],
  ];
  const selected = all.filter(([id]) => !only || only.includes(id));
  return Promise.all(selected.map(([, run]) => run()));
}

/** Throws RecodeError(PREREQUISITE) listing every failed required tool. */
export async function requireTools(
  config: RecodeConfig,
  required: readonly ToolId[],
): Promise<void> {
  const results = await runChecks(config, required);
  const failed = results.filter((r) => r.status === 'fail');
  if (failed.length > 0) {
    throw new RecodeError(
      'PREREQUISITE',
      `Missing prerequisites: ${failed.map((f) => `${f.label} (${f.detail})`).join(', ')}.`,
      { hint: failed.map((f) => `${f.label}: ${f.hint ?? ''}`).join('\n') },
    );
  }
}
