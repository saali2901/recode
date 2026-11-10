# Validation

A successful compiler run is not evidence that a reconstruction behaves like the original. ReCode therefore validates in
stages and states plainly what each stage can and cannot show. Everything that was not checked is reported as
`not-assessed`, never as passed.

| Stage                   | When                      | What it checks                                                                                                                                                                                                                                                                     | Where                                     |
| ----------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 0 structural            | right after each session  | result JSON schema, task id and address, function defined in code, no `#include`, unique names                                                                                                                                                                                     | `ResultBook.inspect` (reconstruct.ts)     |
| 1 static                | right after each session  | balanced delimiters, a top-level definition with a body, prototype ↔ definition (return type, parameter count and types), leftover Ghidra placeholder types, TODO markers, dropped loops/branches/calls compared with the original's measured metrics, self-reported `speculative` | `validation/static/function-validator.ts` |
| 2a per-function compile | right after each session  | `-fsyntax-only -Wall` of the single function against the shared types and the prototypes of its reconstructed callees (seconds, not a project build); the shared types header is compiled on its own                                                                               | `validation/static/compile-check.ts`      |
| 2b project build        | `recode build`            | CMake configure, Ninja build (incremental: unchanged generated files keep their mtime), compiler warnings/errors, linker errors, attribution of diagnostics to the responsible function                                                                                            | `validation/build`                        |
| 3 behaviour             | `recode validate`, opt-in | return values and buffer contents of reconstructed functions against user-supplied reference source on edge-value and pseudo-random vectors                                                                                                                                        | `validation/differential/differential.ts` |
| 4 targeted repair       | on findings               | stage 0-2a findings escalate the single function to a stronger model with the previous result and the findings; build errors are attributed to functions and only those are re-run (`recode run` does up to `validation.autoRepairRounds` rounds)                                  | `reconstruct.ts`, `app/pipeline.ts`       |

Findings of stages 0-2a drive the **escalation** (see [optimization-report.md](optimization-report.md)): errors and
`speculative` results move the function to the next stronger model; the strongest model gets one more attempt only if
the findings are new to it; then the function is marked failed (and left out of the project) instead of shipping code
that is known not to compile. Warnings that could not be resolved stay on the task (`openIssues`), appear in
`reconstruction/<id>/quality.json` and in the validation report (`static` check) - they are never hidden.

## Differential testing (stage 3)

Binaries are never executed by ReCode. Stage 3 needs **reference source** that you supply - the original source of a
benchmark, a clean-room implementation, or a trusted re-implementation of a few functions. ReCode compiles that source
and the reconstructed static library into one test runner and executes only that runner, locally, with a timeout, and
only when a spec is configured. Use it in an environment where running the code under test is authorized.

```bash
recode config set validation.differentialSpec reference/diff.json
recode validate --force
```

`reference/diff.json` (path relative to the project; the reference source must lie inside the project):

```json
{
  "referenceSource": "reference/ref.c",
  "referenceFlags": [],
  "cases": [
    { "function": "add_ints", "returns": "int", "params": [{ "type": "int" }, { "type": "int" }] },
    {
      "function": "checksum",
      "reference": "orig_checksum",
      "returns": "uint32_t",
      "params": [{ "type": "buffer", "size": 64 }, { "type": "uint32_t" }],
      "vectors": [[0, 0]],
      "random": { "count": 200, "seed": 7 }
    }
  ]
}
```

- Parameter types: C integer types (`int`, `unsigned long`, `uint8_t` ... `size_t`), `float`, `double`, and
  `{ "type": "buffer", "size": N }` (a pointer to N bytes; both implementations get identical random content and the
  content afterwards is compared too). Pointers to structs and other types are not supported - such functions are
  reported `not-assessed`, not skipped silently.
- Vectors: your explicit `vectors`, a capped product of edge values (0, 1, -1, min, max, off-by-one ...), and
  `random.count` seeded pseudo-random vectors. Floating-point results must match bit for bit (NaN equals NaN).
- Functions that were not reconstructed are `not-assessed`. A reference that does not compile, a runner that does not
  link, a timeout or a crash make the check `not-assessed` or `failed` with the reason - never `passed`.
- A pass means "identical on these vectors". It does not prove equivalence for all inputs, and it says nothing about
  functions without a case.

## Metrics of the validation

`recode perf` shows, per run: functions accepted/failed, escalations, retries, per-function compile checks and the
number of compile errors they found.
