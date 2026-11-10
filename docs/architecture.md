# Architecture

## Overview

```
                ┌──────────────────────────── recode CLI (Commander) ────────────────────────────┐
                │ init import inspect analyze reconstruct build validate run status logs doctor config │
                └───────────────────────────────────────┬─────────────────────────────────────────┘
                                                        │ src/cli  (parsing + printing only)
                                          src/app/pipeline.ts  (wires steps, fingerprints, prerequisites)
        ┌────────────┬───────────────┬───────────────┬──────────────────┬──────────────────┬────────────┐
        │ input/     │ decompiler/   │ ai/           │ reconstruction/  │ validation/      │ core/      │
        │ detection  │ Ghidra adapter│ Claude runner │ C project        │ CMake/Ninja,     │ project,   │
        │ adapters   │ + Java script │ events, agents│ generator        │ diagnostics,     │ workflow,  │
        │ ZIP        │ + JSON schemas│ orchestration │                  │ checks           │ tasks, ... │
        └────────────┴───────────────┴───────────────┴──────────────────┴──────────────────┴────────────┘
                                  infrastructure/: filesystem (atomic JSON), process, config, logging, tools
```

Dependency rule: `core` and `infrastructure` know nothing about Ghidra, Claude or C. `app/pipeline.ts` is the only
place that connects the layers. External programs (Ghidra, Claude Code, CMake) are reached only through
`infrastructure/process/process-manager.ts`.

## Modules

| Module                    | Responsibility                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `core/errors`             | `RecodeError` with stable codes → CLI exit codes                                                                                      |
| `core/project`            | Project directory, `recode.json` manifest, binary registry (by SHA-256), lock file                                                    |
| `core/workflow`           | Per-binary step state machine (`pending/running/completed/failed/cancelled`), fingerprints                                            |
| `core/tasks`              | Persistent reconstruction task list with dependencies, attempts, crash recovery                                                       |
| `core/events`             | Typed event bus consumed by the CLI progress output and the log                                                                       |
| `core/graph`              | Iterative Tarjan SCC, condensation (depth/height), Kahn topological order - no recursion                                              |
| `input/parsers`           | Bounds-checked ELF, PE, Mach-O, COFF, DOL and GameCube disc parsers on a random-access file view                                      |
| `input/adapters`          | `InputAdapter` implementations + `AdapterRegistry`                                                                                    |
| `input/extractors/zip.ts` | Own safe ZIP reader (stored/deflate) with all limits                                                                                  |
| `input/import-service.ts` | Detect → prepare → register in the project                                                                                            |
| `decompiler/interfaces`   | `Decompiler` interface, Zod schemas of the analysis files                                                                             |
| `decompiler/ghidra`       | Installation lookup, headless invocation, language IDs, per-platform import plan (`import-plan.ts`), staging + atomic swap of results |
| `decompiler/analysis`     | Metrics from decompiler text + Ghidra facts, the per-function dossiers (analysis store)                                              |
| `decompiler/scripts`      | `ExportAnalysis.java` (writes the JSON files) and `ImportDol.java` (rebuilds a DOL's memory map) – run inside Ghidra                  |
| `ai/claude`               | `claude -p` runner and tolerant `stream-json` event parser                                                                            |
| `ai/orchestration`        | Planner (SCC task DAG), scheduler (limiter, batch picker), reconstruct loop, context files, batch files, review, session log         |
| `ai/routing`              | Difficulty score and tier router, escalation policy, routing history, model availability probe                                        |
| `ai/prompts`              | Prompt builders and batch file schema                                                                                                 |
| `reconstruction`          | `TargetLanguage` interface, result schemas, C project generator (`templates/c-project`)                                               |
| `validation`              | CMake/Ninja build, diagnostics parser/attribution, static function validator, per-function compile check, differential tests, checks |
| `infrastructure/cache`    | Content-addressed result cache                                                                                                        |
| `infrastructure/monitoring` | Run metrics collector, summaries and comparison                                                                                     |

## Data flow and project layout

```
project/
├── recode.json                 manifest: binaries (metadata, sha256), references, config layer
├── input/  reference/          imported files (never overwritten); extracted archives below input/<name>/
├── analysis/<id>/              metadata.json  program.json  functions.json  references.json  symbols.json
│   ├── decompiled/function_<addr>.c   asm/function_<addr>.asm        types.json  call-graph.json
│   └── facts.json (optional, Ghidra)  store.json (derived: metrics + content hash per function)
├── reconstruction/<id>/        overview.md  batches/*.json  context/<task>.json  results/<task>.json  reviews/<task>.json
│                               quality.json  validation.json
├── source/<id>/                include/recode_types.h  include/recode_functions.h  src/<name>.c
│                               CMakeLists.txt  RECONSTRUCTION.md  .recode-generated.json
├── build/<id>/                 CMake/Ninja tree, diagnostics.json, build-report.json
├── .claude/                    agents/*.md, settings.json   (copied from templates/claude at init)
├── CLAUDE.md                   rules for the agents (untrusted data, boundaries, confidence vocabulary)
└── .recode/                    workflow/<id>.json  tasks/<id>.json  sessions/<id>.jsonl  logs/  lock
                                cache/results/<aa>/<key>.json   metrics/<id>/<run>.json  routing-history.json  models.json
```

1. **import** – the registry asks every adapter to `detect()` by magic bytes and structure; the highest confidence
   wins. The adapter's `prepare()` copies (or extracts) files into `input/` without overwriting and returns
   `PreparedBinary` records with parsed `BinaryMetadata`. Re-importing identical content is a no-op.
2. **analyze** – `GhidraDecompiler` runs `analyzeHeadless -import <file> -overwrite -deleteProject -scriptPath … -postScript
ExportAnalysis.java <stagingDir> …`. Output goes to a staging directory, is validated with Zod and swapped in
   atomically, so a failed run never leaves a half-written `analysis/`.
3. **reconstruct** – see below.
4. **build** – `cmake -G Ninja` + `cmake --build -- -k 0` (collect all errors). Diagnostics are parsed and mapped to
   the responsible task via `.recode-generated.json`.
5. **validate** – registered checks evaluate stored artifacts and write `reconstruction/<id>/validation.json`.

## Adapter system and extension points

New formats implement `InputAdapter` (`detect`, `prepare`, `getMetadata`) and are registered in
`createDefaultRegistry`; no workflow code changes. The same pattern applies to `Decompiler` (a second backend only
needs to produce the files described by the schemas), `TargetLanguage` (generator for another language) and
validation (`VALIDATION_CHECKS` is a list of functions). There is deliberately no dynamic plugin loading yet.

**Python workers (future):** tools such as angr, LIEF or Capstone can be added as isolated external programs that read
a binary and write JSON files in the same schemas, started through `runProcess` like Ghidra. Nothing in the TypeScript
core assumes Ghidra; the core only consumes `analysis/<id>/*.json`.

## Platforms (GameCube first)

`BinaryMetadata.platform` marks binaries built for a console. It is set by the input adapters and consumed in exactly
two places: `decompiler/ghidra/import-plan.ts` (how Ghidra loads the file) and the reconstruction step, which copies
`templates/platforms/<platform>.md` next to the results and lists it as `platformNotes` in every batch file.

**GameCube.** A DOL has no magic number, so `DolAdapter` accepts a file only if the whole header is consistent
(section bounds, alignment, MEM1 range, no overlaps, entry inside a text section). `GcmAdapter` reads the disc header
(game ID, title, region, boot DOL offset), copies the boot DOL into `input/` as `<gameId>-boot.dol` and records the game
in the metadata. Compressed containers (RVZ, WIA, CISO, GCZ, WBFS) are converted to a temporary ISO with Dolphin's `dolphin-tool`
(found on PATH or via `tools.dolphinToolCommand`; the ISO is deleted right after the boot DOL was read). Without
Dolphin they are rejected with a hint; `recode doctor` shows the tool as an optional check. Wii discs are recognized and rejected.

Ghidra has no DOL loader. ReCode imports the file with `BinaryLoader` and runs `ImportDol.java` as `-preScript`: it
removes the single block, creates one block per DOL section (text `r-x`, data `rw-`, `.bss` uninitialized) from the
same file bytes, and labels the entry `__start`. If the startup code loads the small-data anchors r2/r13 (found by a
narrow scan in `ppc-startup.ts`), the script fixes both registers to those constants in all code, so the decompiler
shows `DAT_8001aa80` instead of `*(int *)(unaff_r13 + -0x7f8c)`. The language is `PowerPC:BE:32:Gekko_Broadway` when the installed
Ghidra defines it (found by reading its `.ldefs` files); otherwise generic PowerPC is used and a warning is emitted.

**Adding a platform** (PS1, SNES, Wii, ...): add adapter(s) that set `platform` and the real architecture facts, add a
branch to `planImport` (language, loader, optional pre-script), add `templates/platforms/<platform>.md`, extend
`PlatformSchema`, and test with synthetic fixtures like `buildDol`/`buildGcm` in `test/helpers/binaries.ts`.

## Workflow and recovery

`WorkflowManager` stores, per binary, the five steps `prepare → analyze → reconstruct → build → validate` in
`.recode/workflow/<id>.json` (atomic writes). Each step records status, attempts, timestamps, error and a
**fingerprint** of its inputs. Rules:

- A completed step with an unchanged fingerprint is skipped (`--force` overrides).
- A step needs its predecessor to be `completed`.
- Completing a step resets later steps to `pending` (their inputs changed).
- On load, steps left in `running` by a crashed process become `failed` ("Interrupted") and can be re-run.
- The project lock (`.recode/lock`, PID based) prevents concurrent runs; locks of dead processes are taken over.

Reconstruction state is per task (`.recode/tasks/<id>.json`): `pending → running → completed | failed`. A task left
`running` after a crash becomes `pending` again; a changed analysis (different function set) discards old task state.
Every accepted agent result stays on disk in `reconstruction/<id>/results/`, so progress is never lost.

## Reconstruction, routing and scheduling

See [agents.md](agents.md) for roles and rules and [optimization-report.md](optimization-report.md) for the measured
effects. In short:

1. **Analysis store.** Before any model runs, `buildAnalysisStore` reads every function once (bounded concurrency) and
   derives a dossier: measured properties (lines, cyclomatic complexity, basic blocks, pointer arithmetic, distinct
   struct offsets, indirect calls, decompiler warnings, `undefined` types, ...), callees with signatures, referenced
   strings and globals, program types the decompiler output mentions, and a **content hash**. When `facts.json` exists
   (exported by `ExportAnalysis.java`), basic blocks, indirect calls and data references come from Ghidra's program
   database; otherwise they are estimated from the text. Decompiler pseudocode is treated as an interpretation of
   the machine code - nothing in the dossier claims original names, types or structure.
2. **Planner.** `planTasks` condenses the call graph into strongly connected components (Tarjan). Members of a
   component (mutual recursion) form a **group** that is reconstructed in one session with consistent prototypes. The
   condensation is a DAG, so no waiting cycles exist. Calls to other components are _soft_ dependencies in the default
   `adaptive` mode, hard ones in `complete`, absent in `signatures`; `legacy` keeps the original planner. Every task gets a
   critical-path priority.
3. **Router.** Each function gets a difficulty score (0-100) from its measured properties, mutual recursion and the
   failure history of similar functions, and a tier: `fast` (trivial, small, flat, fully lifted), `standard`, `advanced`,
   `expert`. Tiers map to models in the configuration (`routing.tiers.*.model`, defaults are the Claude Code aliases
   `haiku`, `sonnet`, `opus`); a pinned `claude.model` disables routing. Models are probed once a day with a one-word
   request; an unusable tier falls back to the nearest usable one.
4. **Scheduler.** An AIMD limiter (start `scheduler.initialSessions`, +1 after as many healthy sessions as the current
   limit, halve on failure, hard cap `scheduler.maxSessions`, no new session while load per CPU or free RAM is out of
   bounds) runs independent sessions concurrently. A session is one tier, at most the tier's batch size in functions,
   limited by a share of the tier's context window; groups travel together. If no function is strictly ready and a
   slot is free, functions whose only open dependencies are _soft_ start with the callee's Ghidra signature
   (`relaxed starts`, counted in the metrics).
5. **Agents.** The lead agent runs on the standard tier (it only coordinates and verifies); the specialists run on the
   routed tier through `CLAUDE_CODE_SUBAGENT_MODEL`. Function agents get a task-specific **context file** instead of the
   whole-program JSON files.
6. **Validation and escalation.** Each result passes the structural check, the static validator and the per-function
   compile check (see [validation.md](validation.md)). Findings escalate the function to the next stronger model _with_
   the previous result and the findings; the same model is only repeated when the findings are new to it.
7. **Cache.** Accepted clean results are stored content-addressed (`cache/results`). A task is served from the cache
   when function content, prompts (agent definitions, `CLAUDE.md`, prompt version) and shared types are unchanged, the
   cached tier is at least the requested one and every reconstructed callee still has the prototype the entry was
   written against. A changed function resets only its own task; a changed callee prototype reopens only its callers.

ReCode - not the agents - validates results and only then marks a task completed. The C project is **generated by
ReCode** from accepted results, so agents never write shared files (headers, CMake) and cannot conflict.
Generated files are only rewritten when their content changed, so Ninja rebuilds only what is affected.

## Security

- **Binaries are never executed.** Agents have no shell; ReCode only runs Ghidra, Claude Code, CMake, Ninja, the compiler.
- **Process execution**: `spawn` with argument arrays, `shell: false`, own process group, timeouts, `AbortSignal`,
  process-tree kill (SIGTERM, then SIGKILL; `taskkill /T` on Windows), bounded output capture, transcripts under `.recode/logs/`.
- **Paths**: `safeJoin` rejects absolute paths, drive letters, NUL and traversal; archive extraction additionally
  rejects symlinked parents, never overwrites (`wx`), skips symlink/encrypted entries and enforces limits
  (`archive.maxFiles`, `maxTotalBytes`, `maxFileBytes`, `maxCompressionRatio`), CRC and size checks.
- **Claude Code sandbox**: `--tools` excludes Bash/web tools; `--permission-mode dontAsk` (anything not pre-approved is
  denied); allowed writes only `Edit(/reconstruction/<binary>/**)`; `--setting-sources project` ignores user-level
  settings; `--strict-mcp-config` (no MCP servers); the project's `.claude/settings.json` additionally denies Bash and
  edits to everything else. The prompt goes via stdin and contains file references, never binary-derived text.
- **Prompt injection**: all binary-derived text is declared untrusted in `CLAUDE.md` and in every agent definition.
  This lowers, but cannot eliminate, the risk; the technical restrictions above are the real boundary.
- **Data**: nothing leaves the machine except what Claude Code itself sends to Anthropic when agents read the
  analysis files (decompiled code, assembly, strings). Do not use ReCode on binaries you may not share with that service.

## Limitations

- The new parts of `ExportAnalysis.java` (facts export, optional multi-threaded decompilation) were compiled only against
  stubs of the Ghidra API, never run against a real Ghidra. Facts sections fail soft (warnings in `facts.json`);
  threads default to 1.
- Ghidra export script of the original release was verified by the author only partly (see README); Ghidra language IDs for raw
  binaries (`decompiler/ghidra/language.ts`) may need adjusting for your Ghidra release.
- Functional validation exists only against user-supplied reference _source_ (differential test, opt-in); there is no
  comparison with the original executable and no fidelity measurement.
- The subagent limit (`claude.maxParallelAgents`) is an instruction to the lead agent and applies per session; the number of
  concurrent sessions is a hard limit (`scheduler.maxSessions`), so up to `maxSessions × maxParallelAgents` subagents can
  run at once. `CLAUDE_CODE_SUBAGENT_MODEL` is the documented way to choose the subagent model; its effect with the
  installed CLI is verified by the model probe only for the main thread (see optimization-report.md).
- In `adaptive` mode a caller may be reconstructed against the decompiler signature of a callee that is still being
  reconstructed. A mismatch is caught by the per-function compile check, the alias macros in the generated header,
  the project build and the repair rounds - not prevented. Use `--dependencies complete` to forbid it.
- GameCube: `ImportDol.java` was verified with Ghidra 12.2 on one homebrew DOL only. Ghidra 12.2 has no Gekko language, so
  paired-singles code decodes incorrectly (generic PowerPC fallback). Only the boot DOL of a disc is extracted (no `.rel` modules or other disc files). The r2/r13 scan only
  recognizes straight `lis`/`addi`/`ori` loads near the entry point; other startup code leaves them unresolved. Discs inside a ZIP are limited by
  `archive.maxFileBytes` (default 512 MiB), so import ISOs directly (uploads up to 2 GiB).
- C only. The target language is behind the `TargetLanguage` interface but no second language exists.
- Parsers: no PE import table, no Mach-O function starts, ZIP64/nested archives/encrypted entries unsupported,
  symbol lists capped at 20,000 entries.
- The generated project is a static library (`recode_<id>`); an executable target is offered only if a `main` was
  reconstructed and is opt-in (`EXCLUDE_FROM_ALL`), because partial reconstructions rarely link.
- The interactive prompt for raw-binary metadata works on terminals only; otherwise use the options.
- Large binaries: all functions get tasks (up to `ghidra.maxFunctions`); cost and duration scale with function count.
- Windows support is new and untested on real Windows: `.bat`/`.cmd` launchers (Ghidra, `claude.cmd`) are started through `cmd.exe /d /s /c` with strict argument quoting (arguments containing `"` or `%` are rejected); Claude's permission rules with Windows paths are unverified.
- Interrupt handling: Ctrl+C stops child processes and keeps all state; a hard kill of ReCode may leave an orphaned
  child process (the next run recovers state but does not kill it).
