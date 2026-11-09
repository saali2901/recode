import os from 'node:os';
import path from 'node:path';
import { RecodeError } from '../core/errors/index.js';
import type { RecodeConfig } from '../infrastructure/config/config.js';
import { succeeded, type RunResult } from '../infrastructure/process/process-manager.js';
import { which } from '../infrastructure/process/which.js';
import type { CheckResult, ToolId } from '../infrastructure/tools/doctor.js';
import { fetchLatestRelease, installGhidra } from './ghidra-release.js';
import {
  planSetup,
  type CommandSpec,
  type PackageManager,
  type SetupPlan,
  type SetupStep,
} from './plan.js';

export interface SetupOutput {
  line(text?: string): void;
  info(text: string): void;
  success(text: string): void;
  warn(text: string): void;
}

export interface SetupDeps {
  platform: NodeJS.Platform;
  config: RecodeConfig;
  out: SetupOutput;
  /** Directory for tools installed by ReCode (Ghidra, Claude Code). */
  dataDir: string;
  checks: () => Promise<CheckResult[]>;
  run: (spec: CommandSpec) => Promise<RunResult>;
  detectPackageManager: () => Promise<PackageManager | undefined>;
  isRoot: boolean;
  hasSudo: boolean;
  confirm: (question: string) => Promise<boolean | undefined>;
  setConfig: (key: string, value: unknown) => Promise<void>;
  /** Windows: re-reads PATH after installations so new tools are found without a new terminal. */
  refreshPath?: () => Promise<void>;
  fetchImpl?: typeof fetch;
  releaseApi?: string;
  dryRun: boolean;
  yes: boolean;
  /** Restrict to some steps (ids: packages, ghidra, claude). */
  only?: readonly string[];
}

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env['XDG_DATA_HOME'] ?? path.join(os.homedir(), '.local', 'share'), 'recode');
}

export async function detectPackageManager(
  platform: NodeJS.Platform,
): Promise<PackageManager | undefined> {
  const candidates: PackageManager[] =
    platform === 'darwin' ? ['brew'] : platform === 'win32' ? ['winget'] : ['apt', 'dnf', 'pacman'];
  for (const manager of candidates) {
    const binary = manager === 'apt' ? 'apt-get' : manager;
    if (await which(binary)) return manager;
  }
  return undefined;
}

/** Tools that `recode doctor` reports as missing or too old (the login is handled separately). */
export function missingTools(checks: readonly CheckResult[]): Set<ToolId> {
  const missing = new Set<ToolId>();
  for (const check of checks) {
    if (check.id === 'claude-auth' || check.id === 'node') continue;
    if (check.status === 'fail' || (check.id === 'java' && check.status === 'warn'))
      missing.add(check.id);
  }
  return missing;
}

function formatStep(step: SetupStep): string {
  if (step.kind === 'command') {
    const text = [step.spec.command, ...step.spec.args].join(' ');
    return `${step.title}\n      $ ${text}`;
  }
  return step.title;
}

export interface SetupResult {
  plan: SetupPlan;
  executed: string[];
  remaining: string[];
  /** True when tools are still missing although the user wanted them installed (not for dry runs or a "no"). */
  incomplete: boolean;
}

/** Installs what `recode doctor` finds missing. Everything user-visible goes through `deps.out`. */
export async function runSetup(deps: SetupDeps): Promise<SetupResult> {
  const { out } = deps;
  const before = await deps.checks();
  const missing = missingTools(before);
  const authMissing = before.some((c) => c.id === 'claude-auth' && c.status === 'fail');

  let plan = planSetup({
    platform: deps.platform,
    packageManager: await deps.detectPackageManager(),
    isRoot: deps.isRoot,
    hasSudo: deps.hasSudo,
    missing,
  });
  if (deps.only) plan = { ...plan, steps: plan.steps.filter((s) => deps.only?.includes(s.id)) };

  if (missing.size === 0) {
    out.success('All required tools are already installed.');
    if (authMissing)
      out.warn(
        'Claude Code is not logged in yet: run "claude" once and sign in with your subscription.',
      );
    return { plan, executed: [], remaining: [], incomplete: false };
  }

  out.info(`Missing: ${[...missing].join(', ')}`);
  if (plan.steps.length > 0) {
    out.line('The following will be installed:');
    plan.steps.forEach((step, i) => out.line(`  ${i + 1}. ${formatStep(step)}`));
  }
  for (const note of plan.manual) out.warn(note);
  if (plan.steps.length === 0)
    return { plan, executed: [], remaining: [...missing], incomplete: true };

  if (deps.dryRun) {
    out.info('Dry run: nothing was changed.');
    return { plan, executed: [], remaining: [...missing], incomplete: false };
  }
  if (!deps.yes) {
    const answer = await deps.confirm('Continue? [y/N]');
    if (answer === undefined) {
      throw new RecodeError(
        'USAGE',
        'Setup needs confirmation, but this is not an interactive terminal.',
        {
          hint: 'Re-run with --yes to accept the plan above, or --dry-run to only show it.',
        },
      );
    }
    if (!answer) {
      out.info('Cancelled. Nothing was changed.');
      return { plan, executed: [], remaining: [...missing], incomplete: false };
    }
  }

  const executed: string[] = [];
  for (const step of plan.steps) {
    out.info(step.title);
    await executeStep(step, deps);
    if (deps.platform === 'win32') await deps.refreshPath?.();
    if (!executed.includes(step.id)) executed.push(step.id);
    out.success(`Done: ${step.id}`);
  }

  const after = await deps.checks();
  const remaining = [...missingTools(after)];
  if (remaining.length === 0) out.success('Everything required is installed.');
  else
    out.warn(
      `Still missing: ${remaining.join(', ')}. You may need to open a new terminal so that PATH changes apply.`,
    );
  if (
    after.some((c) => c.id === 'claude-auth' && c.status === 'fail') ||
    executed.includes('claude')
  ) {
    out.warn('Last step for you: run "claude" once and log in with your Claude subscription.');
  }
  return { plan, executed, remaining, incomplete: remaining.length > 0 };
}

async function executeStep(step: SetupStep, deps: SetupDeps): Promise<void> {
  if (step.kind === 'command') {
    const result = await deps.run(step.spec);
    if (!succeeded(result)) {
      throw new RecodeError(
        'TOOL_FAILED',
        `"${step.spec.command}" failed with exit code ${result.exitCode}.`,
        {
          hint: result.stderr.trim().split('\n').slice(-6).join('\n'),
        },
      );
    }
    return;
  }
  if (step.kind === 'ghidra') {
    const release = await fetchLatestRelease(deps.fetchImpl, deps.releaseApi);
    deps.out.info(
      `Ghidra ${release.version} (${release.name}), SHA-256 ${release.sha256.slice(0, 12)}…`,
    );
    let lastPercent = -1;
    const installation = await installGhidra(release, path.join(deps.dataDir, 'ghidra'), {
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      onProgress: (received, total) => {
        if (!total) return;
        const percent = Math.floor((received / total) * 10) * 10;
        if (percent !== lastPercent) {
          lastPercent = percent;
          deps.out.line(`  download ${percent}%`);
        }
      },
    });
    await deps.setConfig('tools.ghidraInstallDir', installation.installDir);
    deps.out.info(`Ghidra ${installation.version} installed at ${installation.installDir}`);
    return;
  }
  const npm = await which('npm');
  if (!npm) throw new RecodeError('PREREQUISITE', 'npm was not found in PATH.');
  const prefix = path.join(deps.dataDir, 'npm');
  const result = await deps.run({
    command: npm,
    args: ['install', '-g', '--prefix', prefix, '@anthropic-ai/claude-code'],
  });
  if (!succeeded(result)) {
    throw new RecodeError('TOOL_FAILED', `npm install failed with exit code ${result.exitCode}.`, {
      hint: result.stderr.trim().split('\n').slice(-6).join('\n'),
    });
  }
  // npm puts the launcher into <prefix>/bin on Unix, but directly into <prefix> (as claude.cmd) on Windows.
  const binary =
    deps.platform === 'win32'
      ? path.join(prefix, 'claude.cmd')
      : path.join(prefix, 'bin', 'claude');
  await deps.setConfig('tools.claudeCommand', binary);
  deps.out.info(`Claude Code installed at ${binary}`);
}
