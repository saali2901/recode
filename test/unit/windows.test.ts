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
