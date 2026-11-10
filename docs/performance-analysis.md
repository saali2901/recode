# Performance analysis of the original ReCode (phases 1 and 2)

This document describes the architecture **as it was before the `performance-updates` branch** and separates what was
_proven_ (by reading the code and by measurement), what is _plausible_ (follows from the code, magnitude unmeasured) and
what is only a _hypothesis_ that still has to be measured. Nothing here is a claim without one of those labels.

Baseline = commit `d781fa3`. Measurements use `scripts/bench.mjs` (see [development.md](development.md)): a deterministic
synthetic binary, an in-process fake session runner, no Ghidra, no Claude. They measure ReCode's own orchestration,
persistence and scheduling cost - **not** AI quality and **not** real API latency.

## 1. Architecture of the original

```
analyze        Ghidra headless, ExportAnalysis.java: ONE DecompInterface, functions decompiled one after another;
               writes functions/references/symbols/types/call-graph.json + decompiled/*.c + asm/*.asm
reconstruct    planTasks(): overview -> types -> function tasks, callees first (recursive DFS, back edges dropped)
               loop { ready = tasks whose dependencies are completed
                      batch = first `batchSize` ready function tasks
                      ONE `claude -p --agent recode-lead` session for the batch
                      lead delegates to subagents (parallelism = an instruction in the prompt)
                      validate result files structurally (Zod, ids, name defined, no #include)
                      TaskStore.update(...) -> rewrite + fsync the whole tasks.json }
               generate C project (all files rewritten) -> build -> validate
```

| Concern            | Original behaviour                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Ghidra integration | single decompiler instance, sequential; no basic blocks, no strings/imports/exports, no indirect-call information        |
| Dependency graph   | recursive DFS; callee completion is a **hard** prerequisite of the caller; cycles broken by dropping back edges           |
| Parallelism        | one Claude session at a time; subagent concurrency (`maxParallelAgents`) is only an instruction to the lead agent         |
| Model              | one global `claude.model` (or the CLI default) for overview, types and every function                                     |
| Context            | every batch lists `functions.json`, `symbols.json`, `types.json`, `call-graph.json`, `program.json` as shared files       |
| Persistence        | `tasks.json` rewritten with fsync on **every** status change; a changed function set discards **all** task state          |
| Caching            | none across runs/re-analysis (accepted results live only as the current result files)                                     |
| Validation         | structural result check; project build; "functional" and "fidelity" always `not-assessed`                                 |
| Errors             | per-task attempts (default 3) with the same model and the previous failure text; rate-limit and untrusted stop the run    |
| Build              | generator rewrites every generated file on each run -> new mtimes -> Ninja recompiles everything                          |
| Monitoring         | cost and turns per session in `.recode/sessions/<id>.jsonl`; no timings, tokens, cache or worker statistics               |

## 2. Findings

Legend: **proven** = shown by code and/or measurement, **plausible** = follows from the code, effect not measured,
**hypothesis** = needs a measurement we could not make here (no Ghidra, no Claude subscription in the build environment).

### CPU / I/O / memory

| #   | Finding                                                                                                                                                                                                                                                                      | Status                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 1   | `TaskStore.save()` serializes and fsyncs the whole task list on every `start`/`complete`/`fail`. Cost per update is O(tasks), the number of updates is O(tasks), so orchestration is **quadratic**. Measured with zero-latency sessions: 200 functions 0.8 s, 1000 → 6.9 s, 3000 → 40.2 s. | **proven (measured)**              |
| 2   | `planTasks` is recursive: a call chain of 5000 functions throws `RangeError: Maximum call stack size exceeded` (verified with the original planner).                                                                                                                         | **proven (measured)**, rare in practice |
| 3   | The final project generation filters with `plan.tasks.some(...)` inside `functions.filter(...)`: O(functions × tasks).                                                                                                                                                       | **proven (code)**, share not isolated |
| 4   | The generator rewrites all files each run, so every file gets a new mtime and Ninja rebuilds the whole library after any repair.                                                                                                                                             | **proven (code)**, build time not measured |
| 5   | `references.json` (all references of all functions) is parsed and Zod-validated as one document.                                                                                                                                                                            | plausible (large binaries)         |
| 6   | `ExportAnalysis.java` decompiles sequentially with one decompiler process; the Ghidra phase is therefore bound to one core.                                                                                                                                                  | proven (code); share of wall time **hypothesis** |

### API latency, redundant model calls, sequential processing

| #   | Finding                                                                                                                                                                                                                                               | Status                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| 7   | Exactly one Claude session runs at a time. With a simulated 300 ms session latency, 1000 functions take 59.5 s of which 51 s are the 170 sessions waiting one behind the other.                                                                        | **proven (measured)**       |
| 8   | Hard callee-first dependencies serialize chains: a 1000-function call chain needs 1002 sessions (one per function) and 14.2 s of pure overhead without any latency.                                                                                    | **proven (measured)**       |
| 9   | The same model is used for a 5-line getter and for a 400-line state machine. Cost/latency of trivial functions is that of the strongest chosen model; hard functions get no more reasoning than trivial ones.                                          | **proven (code)**           |
| 10  | A failed or weak result is retried with the **same** model (attempt counter, same prompt plus the previous error). A result that is syntactically fine but low confidence (`speculative`) is accepted without any second look.                          | **proven (code)**           |
| 11  | Any change to the function list discards the state of **all** tasks (`planFingerprint`), re-running every model call even for unchanged functions.                                                                                                     | **proven (code)**           |
| 12  | No reuse of earlier AI results across `--force`, lost task files or re-analysis.                                                                                                                                                                       | **proven (code)**           |
| 13  | Every batch names the whole-program JSON files as shared inputs; agents can end up reading them for each function.                                                                                                                                     | plausible (depends on the agents) |
| 14  | The lead agent is an extra model layer even for a batch of one function.                                                                                                                                                                                | plausible; extra cost **hypothesis** |

### Sources of reconstruction errors

| #   | Finding                                                                                                                                               | Status                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 15  | A syntax error in one function is only found by the project build, after all other work; attribution then costs a full repair cycle.                  | **proven (test `break-multiply`)**   |
| 16  | Prototype/definition mismatches, leftover Ghidra types (`undefined4`) and obviously dropped logic are not checked at all before the build.            | proven (code)                        |
| 17  | Functional equivalence is never assessed.                                                                                                             | proven (code)                        |
| 18  | Decompiler uncertainty (warnings, `undefined` types, unresolved variables, unrecovered jump tables) is available but not used to decide effort.      | proven (code)                        |
| 19  | Whether stronger models actually fix more of these than the same model retried with the error text.                                                    | **hypothesis** (needs real runs)     |
| 20  | Optimal session concurrency under the user's real rate limits.                                                                                         | **hypothesis**                       |

## 3. Prioritized list of optimizations

Ordered by (evidence × expected effect ÷ risk). "Done" items are described in [optimization-report.md](optimization-report.md).

| Prio | Optimization                                                                                              | Addresses | Status |
| ---- | --------------------------------------------------------------------------------------------------------- | --------- | ------ |
| 1    | Coalesced/throttled task-store writes, indexed lookups                                                     | 1         | done   |
| 2    | Concurrent Claude sessions with an adaptive limiter (AIMD), per-tier caps, critical-path ordering          | 7         | done   |
| 3    | Soft callee dependencies + SCC groups instead of hard waves                                                | 8         | done   |
| 4    | Per-task model routing from measured difficulty                                                            | 9, 18     | done   |
| 5    | Deterministic validators + per-function compile check; escalation with the previous result as input        | 10, 15, 16| done   |
| 6    | Content-addressed result cache, per-task invalidation by input hash and callee prototype                   | 11, 12    | done   |
| 7    | Iterative Tarjan SCC / topological algorithms (no recursion)                                               | 2         | done   |
| 8    | Write-if-changed generation, O(n) generation filter                                                        | 3, 4      | done   |
| 9    | Per-task context files instead of whole-program shared files for function agents                           | 13        | done   |
| 10   | Ghidra facts export (basic blocks, indirect calls, data refs, strings, imports, exports)                   | 18        | done, **not run against real Ghidra** |
| 11   | Optional multi-threaded decompilation in `ExportAnalysis.java`                                             | 6         | done (opt-in), **not run against real Ghidra** |
| 12   | Differential testing against user-supplied reference source                                                | 17        | done (opt-in)                       |
| 13   | Structured metrics (`recode perf`) and A/B benchmark                                                       | all       | done   |
| 14   | Stream/limit `references.json` parsing                                                                     | 5         | open   |
| 15   | Skip the lead agent for single-function sessions                                                           | 14        | open (needs measurement)            |
| 16   | Latency-aware (EWMA) ordering of sessions by tier                                                          | 20        | open                                |
