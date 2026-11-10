# Optimization report (`performance-updates`)

Baseline: ReCode at commit `d781fa3`. Analysis of the baseline: [performance-analysis.md](performance-analysis.md).
Goal: best possible reconstruction quality **and** speed - not minimal token use. Where the two pull apart, the choice
is stated.

> **What was and was not measured.** The build environment had no Ghidra and no Claude Code subscription. All timings
> below come from `scripts/bench.mjs`: the real reconstruction loop (planner, scheduler, task store, cache, validators,
> project generation) against a deterministic synthetic binary with an in-process fake session runner that answers after
> a fixed simulated latency. They show orchestration cost and the effect of concurrency. They do **not** show AI
> quality, real API latency, token use or rate-limit behaviour, and nothing in this report claims they do. Quality
> claims below are limited to what the tests prove (defect detection, escalation logic, parity of generated sources with
> the mock).

## 1. Architecture before and after

Before: see [performance-analysis.md](performance-analysis.md) section 1.

After (details in [architecture.md](architecture.md)):

```
analyze  Ghidra (+ facts.json: basic blocks, indirect calls, data refs, strings, imports, exports; optional threads)
   |
analysis store   one pass over all functions -> dossier per function (metrics, callees, strings, globals, types, content hash)
   |
planner   SCC condensation (Tarjan) -> groups for mutual recursion, soft callee dependencies, critical-path priority
   |
router    difficulty score + failure history -> tier fast | standard | advanced | expert -> model string from config
   |
scheduler AIMD limiter, per-tier caps, tier-pure batches sized by context budget, groups together, relaxed starts when idle
   |   +-- cache lookup (content hash + prompt fingerprint + callee prototypes) -> no model call on a hit
   |   +-- session: lead (standard tier) -> specialists (routed tier via CLAUDE_CODE_SUBAGENT_MODEL), context file per task
   v
judge     structural check -> static validator -> per-function compile check -> accept | escalate | retry | give up
   |
generate  write-if-changed C project -> build (incremental) -> repair rounds -> validate (+ differential test if configured)
   |
metrics   .recode/metrics/<id>/<run>.json  ->  recode perf
```

## 2. Bottlenecks found

See [performance-analysis.md](performance-analysis.md) section 2 (20 findings, each labelled proven / plausible /
hypothesis). The three that dominate the measurements below:

1. quadratic task-store persistence (proven, measured),
2. one Claude session at a time (proven, measured),
3. hard callee-first waves that serialize call chains (proven, measured).

## 3. Changes

| Area          | Change                                                                                                                                                                                                                                              |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persistence   | `TaskStore`: indexed lookups, coalesced and throttled atomic writes (`flush()` at the end and on errors), per-task `inputHash` so a changed function resets only itself, attempt history. Derived files (context, cache) skip fsync.                |
| Dependencies  | `core/graph`: iterative Tarjan SCC, condensation, depth/height, Kahn. Planner: groups for mutual recursion (split at `scheduler.maxGroupSize`), soft/hard/no callee dependencies, critical-path priority, no recursion (50 000-deep chains tested). |
| Parallelism   | `AdaptiveLimiter` (AIMD, load/RAM guard, hard cap), concurrent sessions, per-tier `maxConcurrent`, tier-pure batches limited by `batchSize` and a share of the context window, relaxed starts only for idle workers.                                |
| Model routing | `ai/routing`: about 20 measured inputs → score 0-100 → tier; tiers → models from configuration (aliases `haiku`/`sonnet`/`opus` by default); daily availability probe with fallback; failure history of similar functions raises the score.         |
| Escalation    | Static validator + per-function compile check; `decideEscalation`: accept / escalate (next _different_ model, previous result + findings as input) / retry only with new findings / give up honestly.                                               |
| Ghidra        | `facts.json` (basic blocks, indirect calls/jumps, no-return, stack frame, data refs, strings, imports, exports) with soft failure; optional multi-threaded decompilation (default 1). Both unverified against a real Ghidra.                        |
| Context       | Analysis store dossiers; one context file per function task (callee prototypes, strings, globals, relevant types, group, earlier findings) instead of the five whole-program files in every batch.                                                  |
| Cache         | Content-addressed result cache; entries record the callee prototypes they were written against; weaker-tier, torn or stale entries are misses; prompt fingerprint covers agent definitions and `CLAUDE.md`.                                         |
| Build         | Generator writes only changed files (Ninja stays incremental); alias macros for Ghidra default names; `recode run` / UI "run" do up to `validation.autoRepairRounds` targeted repair rounds.                                                        |
| Validation    | See [validation.md](validation.md): stages 0-4, differential tests against reference source, `static` check in the validation report.                                                                                                               |
| Monitoring    | `MetricsCollector`: per-session records (tier, model, tokens, cost, queue wait, concurrency), counters (accepted, rejected, escalations, retries, cache, compile errors), phases; `recode perf`, `--compare`.                                       |
| Compatibility | `--legacy` / `scheduler.mode: legacy` (original planner, one session, one model, no routing/cache/validators); a pinned `claude.model` keeps working and disables routing.                                                                          |

New modules: `core/graph/graph.ts`, `decompiler/analysis/{metrics,store}.ts`, `ai/routing/{router,escalation,history,availability}.ts`,
`ai/orchestration/{scheduler,context}.ts`, `validation/static/{function-validator,compile-check}.ts`,
`validation/differential/differential.ts`, `infrastructure/{concurrency.ts,cache/content-cache.ts,monitoring/run-metrics.ts}`,
`cli/commands/perf.ts`, `scripts/bench.mjs`, `scripts/bench-matrix.mjs`.
Rewritten: `ai/orchestration/{reconstruct,planner}.ts`, `core/tasks/task-store.ts`. Changed: see `git diff --stat d781fa3..HEAD`.

## 4. Routing strategy

- **Inputs** (all measured from the decompiler text, assembly and Ghidra facts): code lines, cyclomatic complexity,
  basic blocks, nesting, gotos, pointer-arithmetic expressions, memory accesses, distinct struct offsets, direct and
  indirect calls, computed jumps, (mutual) recursion, `undefined` types, unresolved variables, unlifted intrinsics,
  decompiler warnings, decompilation failure, floating point, bit operations, failure history of similar functions.
  Each contribution is capped, so one extreme value cannot decide alone; the top reasons are stored with the task.
- **Tiers.** `fast`: only functions that are small (≤ 30 lines), flat (cyclomatic ≤ 5), fully lifted, without indirect
  calls/gotos/recursion - a 15-line function never gets the strongest model. `standard`: everything else below the
  `advanced` threshold (45). `advanced`: score ≥ 45. `expert`: score ≥ 80, and the last rung of the escalation ladder.
  Shared types use `advanced` (errors there cost every function), the overview uses `standard`.
- **Models** come from `routing.tiers.*.model`. The defaults are the Claude Code aliases `haiku`, `sonnet`, `opus`, not
  model IDs, so they follow the installed CLI. `advanced` and `expert` share `opus` by default, so escalation from
  `advanced` is a retry with new information, not a model change; configure a different model for `expert` to change that.
- **Availability.** Each distinct model gets a one-word probe request once a day; a model that does not answer makes its
  tier fall back to the nearest usable one, with a warning. A rate-limited or untrusted probe counts as available.
- **Not verified here:** the real behaviour of the aliases and of `CLAUDE_CODE_SUBAGENT_MODEL` with the installed CLI.

## 5. Parallelization strategy

- Independent work runs in parallel; ordering comes from the SCC condensation (no waiting cycles by construction).
- `adaptive` (default): callees are soft dependencies. While strictly ready work exists, it goes first (highest
  critical-path priority first). Only when a slot would stay idle do callers start against the callee's Ghidra
  signature. `complete` waits for callees (best prototypes, least parallelism), `signatures` never waits.
- Concurrency starts at `scheduler.initialSessions` (2), grows by one after as many healthy sessions as the current
  limit, halves after a failed session or a rate limit, never exceeds `scheduler.maxSessions` (4), and pauses growth
  while load per CPU or free RAM is out of bounds. Per-tier `maxConcurrent` bounds a single model's use.
- Session size: tier-pure, ≤ tier `batchSize` functions (fast 12, standard `claude.batchSize` 6, advanced 3, expert 1)
  and ≤ 35 % of the tier's context window of estimated task input; a mutually recursive group is never split below
  `maxGroupSize` (24).
- Ghidra: unchanged by default (1 decompiler); `ghidra.decompilerThreads` opts in to one decompiler process per thread.
- Cost note: more, smaller sessions means more model calls than before (see the "sessions" column below). That is the
  deliberate trade for accuracy (right-sized models, groups together) and speed (concurrency).

## 6. Caching strategy

- Key: SHA-256 of prompt fingerprint (agent definitions, `CLAUDE.md`, prompt version) + function content hash
  (signature, call targets, decompiler text, assembly) + hash of the shared types header. Entry: result file content,
  tier, model, and the prototype hashes of the reconstructed callees it was written against.
- Valid when the cached tier ≥ the requested tier and each recorded callee is reconstructed with the same prototype now.
  Only clean results are cached (no validator errors, nothing speculative/suspicious).
- Task state survives changes per task: a changed function resets only its own task; a changed accepted callee
  prototype reopens only the callers that were written against the old one; everything else is kept. Lost task files
  are rebuilt from the cache without a model call (tested), which is also the crash-recovery path for the throttled store.
- Model/prompt changes: prompts and agent definitions are part of the key. Concrete model versions behind an alias are
  recorded per session (`resolvedModel`) but do not invalidate entries; run with `--no-cache` or change a prompt to
  force new results.

## 7. Validation system

See [validation.md](validation.md). Summary of what is checked and when, how findings drive escalation, and what the
differential test can and cannot prove.

## 8. Benchmark results

Machine: 4 vCPU Xeon 2.1 GHz container, Node 22.23, `scripts/bench-matrix.mjs`. "base" = the original code (commit
`d781fa3`, built to a separate `dist`); the other rows are this branch. "legacy" runs the original scheduling semantics
on the new persistence code. Synthetic binaries (seeded), fake runner with the stated simulated session latency.
Single runs, no repetitions - treat differences below ~10 % as noise.

**Orchestration overhead (zero latency, "layered" call graph):**

| Functions | base wall | optimized wall (adaptive) | sessions base → new |
| --------- | --------- | ------------------------- | ------------------- |
| 200       | 0.8 s     | 0.6 s                     | 39 → 41             |
| 1000      | 6.9 s     | 2.6 s                     | 170 → 217           |
| 3000      | 40.2 s    | 8.6 s                     | 504 → 627           |

Base time grows quadratically (0.8 → 6.9 → 40.2 s for 200 → 1000 → 3000), the new code roughly linearly
(0.6 → 2.6 → 8.6 s). Phases at 3000 functions (new): analysis store 0.9 s, planning 0.06 s, loop 5.2 s, generation 2.3 s.

**Effect of concurrency (simulated 300 ms per session):**

| Case                                     | base   | legacy (new persistence) | complete | adaptive (default) | signatures |
| ---------------------------------------- | ------ | ------------------------ | -------- | ------------------ | ---------- |
| layered, 1000 functions (max 4 sessions) | 59.5 s | 59.4 s                   | 33.3 s   | 23.4 s             | 15.6 s     |
| sessions                                 | 170    | 187                      | 290      | 265                | 162        |
| chain, 300 functions (max 4 sessions)    | -      | 92.1 s                   | 93.6 s   | 6.8 s              | 5.4 s      |
| sessions                                 | -      | 302                      | 302      | 63                 | 50         |

Reading: with a pure call chain nothing can run in parallel without relaxing dependencies (`complete` = `legacy`);
`adaptive` is 13.5× faster there, **because callers start with the callee's decompiler signature** - the accuracy
trade-off described in section 5. `complete` keeps callee-first prototypes and still gains from concurrency on branching
graphs (1.8× on `layered`). Fewer sessions for `signatures` come from larger batches; more sessions for `adaptive`/`complete`
than `legacy` come from tier-pure batches and group handling.

**Other shapes (zero latency, 1000 functions, adaptive):** chain 4.0 s (base 14.2 s, 1002 → 366 sessions), wide 3.2 s
(base 7.8 s), cycles 3.3 s (base 8.4 s). Memory growth during the run is the same as base (±10 MiB).

Not measured: Ghidra time (no Ghidra), real session latency/tokens/cost, per-function compile-check cost (with
gcc here the loop for 300 functions grew from 0.49 s to 2.14 s, i.e. ≈ 5.5 ms of wall time per function with four
checks in parallel; negligible against model latency but not free), effect of tiers on token use.

## 9. Performance improvements (what is demonstrated)

- Orchestration overhead no longer grows quadratically: 40.2 s → 8.6 s at 3000 functions (4.7×), measured.
- Independent sessions overlap: 59.5 s → 15.6-33.3 s for 1000 functions at 300 ms per session depending on the
  dependency mode (1.8-3.8×), measured with simulated latency; real gains depend on API latency and rate limits and
  are bounded by `scheduler.maxSessions`.
- Re-runs after lost task state or `--force` need no model calls for unchanged functions (tested); a prototype change
  re-runs only its direct callers (tested).
- Incremental builds: unchanged generated files are no longer rewritten (tested for content; Ninja behaviour follows
  from mtimes, build time not measured).

## 10. Quality improvements (what is demonstrated)

All of these are properties verified by tests with the Claude test double - they show that the mechanisms work, not how
much better real reconstructions are:

- A function whose code does not compile is found right after its session (per-function compile check), escalated to a
  stronger model with the previous result and the compiler message, and never reaches the project build; without the
  check the same defect needs a build → repair cycle (both paths tested).
- Prototype/definition mismatches, `undefined4` leftovers, unbalanced delimiters and results far simpler than the
  original (dropped loops/branches/calls) are reported instead of accepted silently (unit tests).
- A `speculative` result escalates to the next tier once; the same model is not asked again without new findings.
- A broken shared types header is caught before 100s of functions depend on it.
- Differential testing can compare reconstructed functions with reference source (return values, buffer contents), and a
  deliberately different reference is reported as `failed` (tested). Without reference source, functional equivalence
  stays `not-assessed`.
- The generated C sources of `--legacy` and the optimized mode are identical for the mock reconstructions (test), i.e.
  the new orchestration does not change what is written to the project for the same agent output.

## 11. Remaining limitations

- Everything involving a real Claude Code CLI or a real Ghidra is untested here (see the boxed note above): tier defaults,
  `CLAUDE_CODE_SUBAGENT_MODEL`, token fields in the result event, the new Java export parts, multi-threaded decompilation.
- The difficulty score weights and thresholds are reasoned defaults, not calibrated on real binaries. The router's
  history (`routing-history.json`) is the mechanism to adapt them per project; there is no offline calibration tool.
- `adaptive` trades some prototype quality for speed (relaxed starts). Use `--dependencies complete` when accuracy matters
  more than wall time. The per-function compile check, alias macros, repair rounds and callee-change invalidation limit
  but do not remove the risk.
- More and smaller sessions: model calls (and per-session overhead tokens) increase relative to the original.
- Compile checks are syntax-only; they do not prove semantics. Static "dropped logic" heuristics can produce false
  warnings; they never block, but `speculative` and compile errors do.
- Differential testing needs reference source, supports scalar/buffer signatures only, and proves agreement on the tested
  vectors only.
- Not done: latency-aware (EWMA) ordering, skipping the lead agent for single-function sessions, streaming parsing of
  `references.json`, a performance view in the web UI, Windows verification of the new code paths.
