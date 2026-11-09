---
name: recode-maintainer
description: Maintains the ReCode repository (saali2901/recode) - a local tool that turns binaries into C code with Ghidra and Claude Code agents, operated through a web UI. Use for ANY change to this repo (code, web UI, installers, templates, tests, docs) and whenever asked to update this skill or the README. Defines the workflow, the project map, the decisions already taken and the rule that every change updates this skill and, if user-facing, the README.
---

# ReCode maintainer

Skill tracks ReCode version: 0.1.0

## The rule for every change

1. **Read first.** Look at the code you are about to change and at the matching section of this skill.
2. **Change + test.** Add or adjust tests in the same change. Never claim something works without a test or a run.
3. **`npm run check`** (typecheck, lint, format, all tests) must pass. It includes `test/unit/docs-sync.test.ts`, which fails when this skill, the README and the code disagree.
4. **Update this skill** in the same change: project map, commands, decisions, known gaps, and add a line to the change log (newest first, ISO date).
5. **Update the README** if a user would notice: installation, start, commands, supported files. Follow "README rules" below.
6. **Commit** with the attribution lines the session asks for. Work on a branch; push to `main` only when the user explicitly says so.

Enforcement: the Stop hook in `.claude/settings.json` and the pre-commit hook (`npm run hooks` once) run `scripts/skill-guard.mjs`. It blocks while code changed but this file (or, for user-facing files, the README) did not. `SKIP_SKILL_GUARD=1` bypasses it once; use that only for changes that truly need no documentation.

## README rules (decided by the owner)

- Short and clean. Only these sections: Installation (Linux/macOS and Windows), Start, Commands, Supported files, License. Allowed intro: two sentences.
- **No CLI workflow documentation** (init/import/analyze/...): users work in the web interface. The Commands table lists only `recode ui`, `recode doctor`, `recode setup`.
- Installation = one command per OS plus the one-time Claude login. Details belong in `docs/`.
- `docs/` holds architecture, agents, development, web UI and manual installation. Keep it accurate when the code changes.
- Write in English. Never claim anything untested as working; say so in `docs/` (limitations) rather than in the README.

## Commands (all, from `src/cli/commands`)

- `recode init` - create a project directory (agents, settings, CLAUDE.md for the agents)
- `recode import` - import binary, ZIP or reference file; raw binaries need --arch/--endian/--bits/--base
- `recode inspect` - show header facts of an imported binary
- `recode analyze` - run Ghidra headless and export JSON
- `recode reconstruct` - Claude Code agents write C functions; resumable; --repair, --retry-failed
- `recode build` - CMake + Ninja build of the generated C project
- `recode validate` - checks; --ai-review lets the validation agent review
- `recode run` - analyze, reconstruct, build, validate in order
- `recode status` - workflow steps and task counts
- `recode logs` - ReCode log and tool transcripts
- `recode doctor` - check required tools and the Claude login
- `recode config` - get/set/list configuration (project or --global)
- `recode ui` - local web interface (127.0.0.1, token); --workspace, --port, --open
- `recode setup` - install missing tools (apt/dnf/pacman/brew/winget, Ghidra, Claude Code); --dry-run, --yes, --only
- `recode trust` - mark the project folder as trusted for Claude Code

**Input adapters:** elf, pe, macho, coff, raw, zip (plus reference material: .c .cc .cpp .cxx .h .hh .hpp .json .yaml .yml .txt .md .map .sym)

## Project map

- `src/cli` - Commander commands, output formatting, runtime. Parses and prints only.
- `src/app` - wiring: `pipeline.ts` (steps with fingerprints), `import-file.ts`, `init-project.ts`, `context.ts`.
- `src/core` - project (manifest, lock), workflow state machine, task store, events, errors. Knows nothing about Ghidra or Claude.
- `src/input` - format parsers (ELF/PE/Mach-O/COFF), adapters + registry, safe ZIP extractor, import service.
- `src/decompiler` - `Decompiler` interface, Ghidra adapter (locate, headless run), `scripts/ExportAnalysis.java`, JSON schemas.
- `src/ai` - Claude runner (`stream-json`), event parser, trust handling, planner, reconstruct loop, review, prompts.
- `src/reconstruction` - target-language interface, result schemas, C project generator.
- `src/validation` - CMake/Ninja build, diagnostics attribution, validation checks.
- `src/infrastructure` - atomic file IO, paths, process manager (no shell, process-tree kill, Windows batch files), config, logging, doctor.
- `src/server` - local HTTP server: API, SSE events, jobs, uploads, ZIP download, static files.
- `src/setup` - `recode setup`: plan per platform, Ghidra release download (SHA-256), Windows PATH refresh.
- `web/` - React + Vite UI (wizard, projects, settings, doctor) styled with cleanui; built to `dist/web`.
- `templates/` - `claude/` (agents, settings, CLAUDE.md copied into projects), `c-project/` (CMake template).
- `install.sh`, `install.ps1` - one-command installers; `scripts/skill-guard.mjs` - documentation guard.
- `test/` - `unit`, `integration` (with test doubles in `test/helpers`), `e2e` (Playwright, opt-in), `fixtures` (C sample).

## Conventions

- Strict TypeScript, no `any`, validate all external/persisted JSON with Zod (`readJson`), persist with `writeJsonAtomic`.
- External programs only through `runProcess` (argument arrays, timeouts, tree kill). Windows `.cmd/.bat` go through `cmd.exe /d /s /c` with strict quoting.
- Errors are `RecodeError(code, message, {hint})`; codes map to exit codes. `RATE_LIMIT` and `UNTRUSTED` are not retried.
- Text from analyzed binaries is untrusted data; never put it into prompts as instructions.
- Never fake results: unsupported features throw or are reported `not-assessed`.
- Test doubles `test/helpers/fake-ghidra.mjs` and `mock-claude.mjs` must stay command-line compatible with the real tools; extend them when a real-tool behaviour is discovered (they now enforce Ghidra's "no dot-prefixed project path" rule).

## Testing

- `npm run check` - everything that needs no Ghidra and no Claude subscription.
- Opt-in: `npm run test:ghidra` (real Ghidra), `npm run test:claude` (real Claude, costs usage), `npm run test:e2e` (Chromium), `RECODE_TEST_INSTALL=1` (real installer run).
- Fixture: `test/fixtures/src/sample.c` is compiled by `test/helpers/global-setup.ts`.

## Decisions already taken

- Local only: no hosted backend, accounts or database; Claude Code runs through the user's own CLI login.
- Reconstruction: ReCode plans a task DAG (overview -> types -> functions, callees first) and runs one Claude session at a time; subagent concurrency (default 2) is an instruction to the lead agent. Shared files (headers, CMake, sources) are generated by ReCode from validated per-task result files; agents only write below `reconstruction/<binary>/`.
- Agent sandbox: no shell, `dontAsk` permission mode, `--setting-sources project`, deny rules also passed via `--disallowedTools` (Claude ignores `settings.json` in untrusted folders -> `recode trust` / UI button).
- Ghidra project directory is created in the system temp dir (Ghidra rejects path elements starting with ".", e.g. `.recode`).
- Web UI: React + Vite, cleanui theme switcher (8 themes), English, SSE for live progress, jobs run on the server and survive closed tabs, one job per project, no result viewer and no retry/repair buttons yet.
- Installers: `install.sh` (Linux/macOS, private checksum-verified Node if needed), `install.ps1` (native Windows via winget, WSL optional with `RECODE_WSL=1`), `recode setup` does the tool installs; winget "already installed" exit codes count as success.
- README is deliberately minimal (see README rules).

## Known gaps (keep honest)

- Native Windows (winget, `.cmd` launching, Claude permission rules with `C:/` paths) is only partly verified by the owner's manual runs; Ghidra 12.2 import worked, `ExportAnalysis.java` was not confirmed against real Ghidra output yet unless noted in the change log.
- No functional-equivalence or fidelity check (reported `not-assessed`).
- Web UI cannot show reconstructed code or trigger repair/retry.
- Subagent concurrency limit is advisory.

## Branches and releases

- `main` is merged by the owner via pull requests. Use `feature/...` or `fix/...` branches. Push to `main` only on explicit request.
- Commit trailer and PR footer: use exactly the attribution the session provides.

## Change log (newest first)

- 2026-11-09 - Added this skill, `scripts/skill-guard.mjs` (Stop hook + pre-commit), `test/unit/docs-sync.test.ts`; README reduced to Installation/Start/Commands/Supported files.
- 2026-11-09 - Usage-limit and untrusted-folder handling (`RATE_LIMIT`, `UNTRUSTED`, `recode trust`, UI button, `--disallowedTools`).
- 2026-11-09 - Ghidra project dir moved to the temp dir (real Ghidra 12.2 rejected `.recode`).
- 2026-11-09 - Native Windows support: winget plan, `.cmd` launching, PATH refresh, app-execution-alias detection, accepted winget exit codes.
- 2026-11-09 - One-command installers and `recode setup`.
- 2026-11-09 - Web interface (`recode ui`) with React wizard, API tests, component tests, Playwright E2E.
- 2026-11-09 - Initial MVP: input adapters, Ghidra adapter, Claude agents, C generator, build, validation, workflow recovery.
