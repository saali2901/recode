import { describe, expect, it } from 'vitest';
import {
  buildCmdInvocation,
  prepareSpawn,
  quoteForCmd,
} from '../../src/infrastructure/process/windows-command.js';
import { mergeWindowsPath, parseRegistryPaths } from '../../src/setup/windows-path.js';
import { planSetup, wingetInstall, type PlanInput } from '../../src/setup/plan.js';
import type { ToolId } from '../../src/infrastructure/tools/doctor.js';

describe('running batch files on Windows', () => {
  it('quotes arguments only when needed', () => {
    expect(quoteForCmd('--print')).toBe('--print');
    expect(quoteForCmd('C:\\a\\b.txt')).toBe('C:\\a\\b.txt');
    expect(quoteForCmd('Read,Glob,Edit(/reconstruction/x/**)')).toBe(
      '"Read,Glob,Edit(/reconstruction/x/**)"',
    );
    expect(quoteForCmd('with space')).toBe('"with space"');
    expect(quoteForCmd('a&b|c<d>e^f')).toBe('"a&b|c<d>e^f"');
  });

  it.each(['say "hi"', '%PATH%', 'line\nbreak', 'nul\0byte'])(
    'rejects argument %j instead of risking injection',
    (arg) => {
      expect(() => quoteForCmd(arg)).toThrowError(expect.objectContaining({ code: 'UNSAFE_PATH' }));
    },
  );

  it('wraps a batch file call in cmd.exe /d /s /c with verbatim arguments', () => {
    const target = buildCmdInvocation(
      'C:\\Program Files\\Ghidra\\support\\analyzeHeadless.bat',
      ['C:\\proj dir', 'recode', '-import', 'a&b.exe'],
      'C:\\Windows\\System32\\cmd.exe',
    );
    expect(target.command).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(target.windowsVerbatimArguments).toBe(true);
    expect(target.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(target.args[3]).toBe(
      '""C:\\Program Files\\Ghidra\\support\\analyzeHeadless.bat" "C:\\proj dir" recode -import "a&b.exe""',
    );
  });

  it('rejects unsafe batch file names', () => {
    expect(() => buildCmdInvocation('C:\\x\\%evil%.bat', [])).toThrow(/Unsafe file name/);
  });

  it('leaves commands untouched on other platforms and for executables', async () => {
    expect(await prepareSpawn('node', ['-v'], {}, 'linux')).toEqual({
      command: 'node',
      args: ['-v'],
      windowsVerbatimArguments: false,
    });
  });
});

describe('Windows PATH refresh', () => {
  it('merges registry and process PATH without duplicates (case-insensitive)', () => {
    const merged = mergeWindowsPath(
      'C:\\Windows;C:\\CMake\\bin',
      'C:\\Users\\me\\bin',
      'c:\\windows;C:\\Extra',
    );
    expect(merged.split(';')).toEqual([
      'C:\\Windows',
      'C:\\CMake\\bin',
      'C:\\Users\\me\\bin',
      'C:\\Extra',
    ]);
  });

  it('parses the two PATH lines from PowerShell', () => {
    expect(parseRegistryPaths('M1;M2\r\nU1\r\n')).toEqual({ machine: 'M1;M2', user: 'U1' });
    expect(parseRegistryPaths('')).toEqual({ machine: '', user: '' });
  });
});

describe('Windows setup plan', () => {
  const input = (missing: ToolId[], patch: Partial<PlanInput> = {}): PlanInput => ({
    platform: 'win32',
    packageManager: 'winget',
    isRoot: false,
    hasSudo: false,
    missing: new Set(missing),
    ...patch,
  });

  it('installs exactly the missing tools, one winget package each', () => {
    const plan = planSetup(input(['cmake', 'ninja', 'compiler', 'java']));
    expect(plan.steps.map((s) => (s.kind === 'command' ? s.spec.args[2] : s.kind))).toEqual([
      'Kitware.CMake',
      'Ninja-build.Ninja',
      'BrechtSanders.WinLibs.POSIX.UCRT',
      'Microsoft.OpenJDK.21',
    ]);
    expect(planSetup(input(['ninja'])).steps).toHaveLength(1);
    expect(
      plan.steps.every((s) => s.kind === 'command' && s.spec.command === 'winget' && !s.admin),
    ).toBe(true);
    expect(plan.manual.join()).toContain('UAC');
  });

  it('uses non-interactive, license-accepting winget flags', () => {
    expect(wingetInstall('X.Y').args).toEqual(
      expect.arrayContaining([
        '--silent',
        '--accept-package-agreements',
        '--accept-source-agreements',
        '--disable-interactivity',
      ]),
    );
  });

  it('still plans Ghidra and Claude Code, and explains a missing winget', () => {
    expect(planSetup(input(['ghidra', 'claude'])).steps.map((s) => s.kind)).toEqual([
      'ghidra',
      'claude',
    ]);
    const without = planSetup(input(['cmake'], { packageManager: undefined }));
    expect(without.steps).toEqual([]);
    expect(without.manual[0]).toContain('winget');
  });
});

describe('which() on Windows', () => {
  const makeFs = (opts: { statFails: boolean; known: string[] }) => ({
    access: async (file: string) => {
      if (!opts.known.includes(file)) throw new Error('ENOENT');
    },
    stat: async (file: string) => {
      if (opts.statFails) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      if (!opts.known.includes(file)) throw new Error('ENOENT');
      return { isFile: () => true };
    },
    lstat: async (file: string) => {
      if (!opts.known.includes(file)) throw new Error('ENOENT');
      return { isFile: () => false, isSymbolicLink: () => true };
    },
  });
  const env = {
    PATH: 'C:\\Windows;C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps',
    PATHEXT: '.EXE;.CMD',
  };
  const alias = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\winget.EXE';

  it('finds app execution aliases (winget.exe) even though stat() fails on them', async () => {
    const { which } = await import('../../src/infrastructure/process/which.js');
    expect(await which('winget', env, 'win32', makeFs({ statFails: true, known: [alias] }))).toBe(
      alias,
    );
  });

  it('does not accept entries that do not exist, nor use the alias fallback on other systems', async () => {
    const { which } = await import('../../src/infrastructure/process/which.js');
    expect(
      await which('winget', env, 'win32', makeFs({ statFails: true, known: [] })),
    ).toBeUndefined();
    expect(
      await which(
        'winget',
        { PATH: '/bin' },
        'linux',
        makeFs({ statFails: true, known: ['/bin/winget'] }),
      ),
    ).toBeUndefined();
  });

  it('finds regular executables via PATHEXT', async () => {
    const { which } = await import('../../src/infrastructure/process/which.js');
    const cmake = 'C:\\Windows\\cmake.EXE';
    expect(await which('cmake', env, 'win32', makeFs({ statFails: false, known: [cmake] }))).toBe(
      cmake,
    );
  });
});

describe('winget "already installed" results', () => {
  it('are accepted as success, other failures are not', async () => {
    const { runSetup } = await import('../../src/setup/setup.js');
    const { defaultConfig } = await import('../../src/infrastructure/config/config.js');
    const mk = async (exitCode: number) => {
      const calls: string[] = [];
      const refreshed: number[] = [];
      const checks = [
        { id: 'cmake' as const, label: 'cmake', status: 'fail' as const, detail: '' },
      ];
      const run = runSetup({
        platform: 'win32',
        config: defaultConfig(),
        out: {
          line: () => undefined,
          info: () => undefined,
          success: () => undefined,
          warn: () => undefined,
        },
        dataDir: '/tmp/x',
        checks: async () => {
          calls.push('checks');
          return checks;
        },
        refreshPath: async () => void refreshed.push(calls.length),
        run: async () => ({
          exitCode,
          signal: null,
          timedOut: false,
          aborted: false,
          durationMs: 1,
          stdout: '',
          stderr: '',
          truncated: false,
        }),
        detectPackageManager: async () => 'winget',
        isRoot: false,
        hasSudo: false,
        confirm: async () => true,
        setConfig: async () => undefined,
        dryRun: false,
        yes: true,
      });
      return { run, refreshed };
    };
    for (const code of [0, 2316632107, 2316632161]) {
      const { run, refreshed } = await mk(code);
      await expect(run).resolves.toMatchObject({ executed: ['packages'] });
      expect(refreshed[0]).toBe(0); // PATH is refreshed before the first check
    }
    await expect((await mk(1)).run).rejects.toMatchObject({ code: 'TOOL_FAILED' });
  });
});
