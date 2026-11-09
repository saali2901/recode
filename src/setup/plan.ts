import type { ToolId } from '../infrastructure/tools/doctor.js';

export type PackageManager = 'apt' | 'dnf' | 'pacman' | 'brew' | 'winget';

export interface CommandSpec {
  command: string;
  args: string[];
  /** Exit codes besides 0 that mean "nothing to do, already fine". */
  okExitCodes?: number[];
}

/** winget: 0x8A15002B (no applicable update) and 0x8A150061 (package already installed), unsigned and signed. */
export const WINGET_ALREADY_INSTALLED = [2316632107, 2316632161, -1978335189, -1978335135];

export type SetupStep =
  | { kind: 'command'; id: string; title: string; spec: CommandSpec; admin: boolean }
  | { kind: 'ghidra'; id: string; title: string }
  | { kind: 'claude'; id: string; title: string };

export interface SetupPlan {
  steps: SetupStep[];
  /** Things the user has to do by hand, with the reason. */
  manual: string[];
}

export interface PlanInput {
  platform: NodeJS.Platform;
  packageManager: PackageManager | undefined;
  isRoot: boolean;
  hasSudo: boolean;
  /** Tools reported as missing (or too old) by `recode doctor`. */
  missing: ReadonlySet<ToolId>;
}

interface PackageSet {
  /** Packages for a C compiler, CMake and Ninja. */
  build: string[];
  java: string[];
}

const PACKAGES: Record<PackageManager, PackageSet> = {
  apt: { build: ['build-essential', 'cmake', 'ninja-build'], java: ['openjdk-21-jdk'] },
  dnf: { build: ['gcc', 'cmake', 'ninja-build'], java: ['java-21-openjdk-devel'] },
  pacman: { build: ['base-devel', 'cmake', 'ninja'], java: ['jdk21-openjdk'] },
  brew: { build: ['cmake', 'ninja'], java: ['openjdk@21'] },
  winget: {
    build: ['Kitware.CMake', 'Ninja-build.Ninja', 'BrechtSanders.WinLibs.POSIX.UCRT'],
    java: ['Microsoft.OpenJDK.21'],
  },
};

/** winget packages per missing tool (each tool maps to exactly one package). */
const WINGET_BY_TOOL: Partial<Record<ToolId, string>> = {
  cmake: 'Kitware.CMake',
  ninja: 'Ninja-build.Ninja',
  compiler: 'BrechtSanders.WinLibs.POSIX.UCRT',
  java: 'Microsoft.OpenJDK.21',
};

export function wingetInstall(id: string): CommandSpec {
  return {
    command: 'winget',
    args: [
      'install',
      '--id',
      id,
      '-e',
      '--silent',
      '--disable-interactivity',
      '--accept-package-agreements',
      '--accept-source-agreements',
    ],
  };
}

const INSTALL_ARGS: Record<PackageManager, string[]> = {
  apt: ['apt-get', 'install', '-y'],
  dnf: ['dnf', 'install', '-y'],
  pacman: ['pacman', '-S', '--needed', '--noconfirm'],
  brew: ['brew', 'install'],
  winget: [],
};

function installCommand(
  input: PlanInput,
  manager: PackageManager,
  packages: string[],
): { spec: CommandSpec; admin: boolean } {
  const [command, ...rest] = INSTALL_ARGS[manager];
  const admin = manager !== 'brew';
  const needsSudo = admin && !input.isRoot;
  return {
    admin,
    spec: needsSudo
      ? { command: 'sudo', args: [command as string, ...rest, ...packages] }
      : { command: command as string, args: [...rest, ...packages] },
  };
}

/** Decides what has to be installed. Pure: no I/O, so it can be tested for every platform. */
export function planSetup(input: PlanInput): SetupPlan {
  const steps: SetupStep[] = [];
  const manual: string[] = [];
  const { missing } = input;

  const wantsBuild = ['compiler', 'cmake', 'ninja'].some((t) => missing.has(t as ToolId));
  const wantsJava = missing.has('java');

  if (wantsBuild || wantsJava) {
    const manager = input.packageManager;
    if (input.platform === 'win32') {
      if (manager !== 'winget') {
        manual.push(
          'winget (Windows Package Manager) was not found. Install "App Installer" from the Microsoft Store, or install CMake, Ninja, a JDK 21 and MinGW-w64 (gcc) yourself.',
        );
      } else {
        for (const tool of ['cmake', 'ninja', 'compiler', 'java'] as const) {
          const id = WINGET_BY_TOOL[tool];
          if (!missing.has(tool) || !id) continue;
          steps.push({
            kind: 'command',
            id: 'packages',
            title: `Install ${id} with winget`,
            spec: wingetInstall(id),
            admin: false,
          });
        }
        manual.push(
          'Windows may ask for administrator confirmation (UAC) during the installation.',
        );
      }
    } else if (!manager) {
      manual.push(
        'No supported package manager found (apt, dnf, pacman, Homebrew). Install a C compiler, CMake, Ninja and a JDK 21+ yourself.',
      );
    } else if (manager !== 'brew' && !input.isRoot && !input.hasSudo) {
      manual.push(
        `Administrator rights are needed to install packages with ${manager}, but "sudo" is not available. Run as root or install: ${[
          ...(wantsBuild ? PACKAGES[manager].build : []),
          ...(wantsJava ? PACKAGES[manager].java : []),
        ].join(' ')}`,
      );
    } else {
      const packages = [
        ...(wantsBuild ? PACKAGES[manager].build : []),
        ...(wantsJava ? PACKAGES[manager].java : []),
      ];
      const { spec, admin } = installCommand(input, manager, packages);
      steps.push({
        kind: 'command',
        id: 'packages',
        title: `Install ${packages.join(', ')} with ${manager}`,
        spec,
        admin,
      });
      if (input.platform === 'darwin' && wantsBuild) {
        manual.push(
          'macOS also needs the Xcode command line tools for the C compiler: run "xcode-select --install" and confirm the dialog.',
        );
      }
    }
  }

  if (missing.has('ghidra')) {
    steps.push({
      kind: 'ghidra',
      id: 'ghidra',
      title: 'Download and verify the latest Ghidra release',
    });
  }
  if (missing.has('claude')) {
    steps.push({ kind: 'claude', id: 'claude', title: 'Install Claude Code (npm, user-level)' });
  }
  return { steps, manual };
}
