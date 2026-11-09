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

| Module                    | Responsibility                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| `core/errors`             | `RecodeError` with stable codes → CLI exit codes                                           |
| `core/project`            | Project directory, `recode.json` manifest, binary registry (by SHA-256), lock file         |
| `core/workflow`           | Per-binary step state machine (`pending/running/completed/failed/cancelled`), fingerprints |
| `core/tasks`              | Persistent reconstruction task list with dependencies, attempts, crash recovery            |
| `core/events`             | Typed event bus consumed by the CLI progress output and the log                            |
| `input/parsers`           | Bounds-checked ELF, PE, Mach-O, COFF parsers on a random-access file view                  |
| `input/adapters`          | `InputAdapter` implementations + `AdapterRegistry`                                         |
| `input/extractors/zip.ts` | Own safe ZIP reader (stored/deflate) with all limits                                       |
| `input/import-service.ts` | Detect → prepare → register in the project                                                 |
| `decompiler/interfaces`   | `Decompiler` interface, Zod schemas of the analysis files                                  |
| `decompiler/ghidra`       | Installation lookup, headless invocation, language IDs, staging + atomic swap of results   |
| `decompiler/scripts`      | `ExportAnalysis.java` – runs inside Ghidra, writes the JSON files                          |
| `ai/claude`               | `claude -p` runner and tolerant `stream-json` event parser                                 |
| `ai/orchestration`        | Planner (task DAG), batch files, reconstruct loop, review, session log                     |
| `ai/prompts`              | Prompt builders and batch file schema                                                      |
| `reconstruction`          | `TargetLanguage` interface, result schemas, C project generator (`templates/c-project`)    |
| `validation`              | CMake/Ninja build, diagnostics parser/attribution, registered validation checks            |

## Data flow and project layout

```
project/
├── recode.json                 manifest: binaries (metadata, sha256), references, config layer
├── input/  reference/          imported files (never overwritten); extracted archives below input/<name>/
├── analysis/<id>/              metadata.json  program.json  functions.json  references.json  symbols.json
│   ├── decompiled/function_<addr>.c   asm/function_<addr>.asm        types.json  call-graph.json
├── reconstruction/<id>/        overview.md  batches/*.json  results/<task>.json  reviews/<task>.json  validation.json
├── source/<id>/                include/recode_types.h  include/recode_functions.h  src/<name>.c
│                               CMakeLists.txt  RECONSTRUCTION.md  .recode-generated.json
├── build/<id>/                 CMake/Ninja tree, diagnostics.json, build-report.json
├── .claude/                    agents/*.md, settings.json   (copied from templates/claude at init)
├── CLAUDE.md                   rules for the agents (untrusted data, boundaries, confidence vocabulary)
└── .recode/                    workflow/<id>.json  tasks/<id>.json  sessions/<id>.jsonl  logs/  lock
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

## Reconstruction and agents

See [agents.md](agents.md) for roles and rules. In short, ReCode owns the **task DAG** (`overview → types → functions,
callees before callers; recursion cycles broken`), writes a **batch file** per session, runs **one Claude Code session
at a time** and lets Claude's native subagents do the parallel work. ReCode — not the agents — validates results
(Zod schema, task id and address match, function defined in code, no `#include` in code, unique names) and only then
marks a task completed. The C project is **generated by ReCode** from accepted results, so agents never write shared
files (headers, CMake) and cannot conflict.

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

- Ghidra export script not yet executed against a real Ghidra by the author (see README); Ghidra language IDs for raw
  binaries (`decompiler/ghidra/language.ts`) may need adjusting for your Ghidra release.
- No functional or fidelity validation; no comparison with a reference executable (the interface point is
  `VALIDATION_CHECKS` / `CheckInput.hasExecutableComparator`).
- Parallel subagent limit is an instruction to the lead agent. Hard limits are `batchSize` (tasks per session) and
  one session at a time.
- Dependency waves: a function is only reconstructed after its callees, so deep call chains need many small sessions
  (this is slower, but yields better prototypes for callers).
- C only. The target language is behind the `TargetLanguage` interface but no second language exists.
- Parsers: no PE import table, no Mach-O function starts, ZIP64/nested archives/encrypted entries unsupported,
  symbol lists capped at 20,000 entries.
- The generated project is a static library (`recode_<id>`); an executable target is offered only if a `main` was
  reconstructed and is opt-in (`EXCLUDE_FROM_ALL`), because partial reconstructions rarely link.
- The interactive prompt for raw-binary metadata works on terminals only; otherwise use the options.
- Large binaries: all functions get tasks (up to `ghidra.maxFunctions`); cost and duration scale with function count.
- Windows is untested; `.bat`/`.cmd` launchers (Ghidra, `claude.cmd`) cannot be started without a shell.
- Interrupt handling: Ctrl+C stops child processes and keeps all state; a hard kill of ReCode may leave an orphaned
  child process (the next run recovers state but does not kill it).
