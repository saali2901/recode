# ReCode

ReCode turns a binary into buildable C code. [Ghidra](https://ghidra-sre.org/) analyzes the file, [Claude Code](https://code.claude.com/) agents reconstruct the functions, and CMake/Ninja build and check the result. Everything runs on your own machine and is operated through a web interface.

The result is a best-effort reconstruction, not the original source. Each function is marked as certain, probable or speculative, and the validation report states what could not be verified.

## Installation

One command installs ReCode and everything it needs (Node.js, JDK 21, C compiler, CMake, Ninja, Ghidra, Claude Code). It shows its plan and asks once before changing anything.

**Linux / macOS**

```bash
curl -fsSL https://raw.githubusercontent.com/saali2901/recode/main/install.sh | bash
```

**Windows** (PowerShell)

```powershell
irm https://raw.githubusercontent.com/saali2901/recode/main/install.ps1 | iex
```

Afterwards, log in to Claude Code once with your own subscription:

```bash
claude
```

## Start

```bash
recode ui --open
```

The web interface opens in your browser. Create a project, drop in your file and follow the steps: **Import → Analyze → Reconstruct → Build → Validate → Download**. Steps keep running when you close the tab, and an interrupted run can be resumed.

## Commands

| Command         | Purpose                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------- |
| `recode ui`     | Start the web interface (`--open` opens the browser, `--workspace <dir>` sets the project folder) |
| `recode doctor` | Check that all required tools are installed and Claude Code is logged in                          |
| `recode setup`  | Install missing tools (`--dry-run` only shows the plan, `--yes` skips the question)               |

## Supported files

| Input                                                            | Support                                                          |
| ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| ELF (executables, shared libraries, objects)                     | yes                                                              |
| PE (EXE, DLL)                                                    | yes                                                              |
| Mach-O (including universal binaries)                            | yes                                                              |
| COFF object files (`.obj`)                                       | yes                                                              |
| Raw binaries (`.bin`)                                            | yes, you provide architecture, endianness, bits and base address |
| ZIP archives                                                     | yes, extracted safely; contained binaries are imported           |
| Reference files (`.c` `.cpp` `.h` `.json` `.yaml` `.txt` `.map`) | stored as reference material, never executed                     |

Target language: C.

## License

MIT
