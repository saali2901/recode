# Development

## Environment

- Node.js ≥ 20.11, npm. TypeScript (strict, ESM, `NodeNext`), Vitest, ESLint, Prettier.
- For the full test suite you additionally need a C compiler, CMake and Ninja (the build tests are real).
  Ghidra and a Claude subscription are **not** needed for the default tests.

```bash
npm install
npm run check        # typecheck + eslint + prettier --check + tests
npm run build        # tsc → dist/
npm run dev          # tsc --watch
```

Run the CLI from source after `npm run build`: `node dist/index.js --help`.

## Project structure

See [architecture.md](architecture.md). Source layout: `src/{cli,app,core,input,decompiler,ai,reconstruction,validation,infrastructure}`;
templates in `templates/` (`c-project/` for the generated CMake project, `claude/` for agents, settings and `CLAUDE.md`
copied into new projects); tests in `test/{unit,integration,fixtures,helpers}`.

## Tests

| Command                    | What it runs                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `npm test`                 | all unit and integration tests                                                                                           |
| `npm run test:unit`        | parsers, adapters, ZIP safety, paths, atomic files, process manager, config, workflow, tasks, events, planner, generator |
| `npm run test:integration` | CLI end-to-end flows against test doubles + real compiler/CMake/Ninja                                                    |
| `npm run test:ghidra`      | **optional**: real Ghidra on the sample (`GHIDRA_INSTALL_DIR=… `)                                                        |
| `npm run test:claude`      | **optional**: real Claude Code session (uses your subscription, several minutes)                                         |

Fixture: `test/fixtures/src/sample.c` (arithmetic, struct, enum, dependent functions). `test/helpers/global-setup.ts`
compiles it with `gcc -O0 -no-pie` into `test/fixtures/build/` (git-ignored) when missing; set `CC` to use another compiler.

Test doubles (`test/helpers`): `fake-ghidra.mjs` validates the `analyzeHeadless` command line and writes the same JSON
files as `ExportAnalysis.java`; `mock-claude.mjs` implements `--version`, `auth status` and the `stream-json` protocol,
reads the batch file named in the prompt and writes result files from a fixed table (no AI). Modes (`MOCK_CLAUDE_MODE`,
`FAKE_GHIDRA_MODE`) simulate crashes, hangs, malformed output and compile errors. Keep the doubles command-line
compatible with the real tools whenever you change an invocation.

## Conventions

- No `any`; validate external/persisted data with Zod; use `readJson`/`writeJsonAtomic`.
- Never use a shell. Use `runProcess` (argument arrays, timeout, abort, logging).
- Errors: throw `RecodeError(code, message, { hint })`; the CLI maps codes to exit codes.
- Do not report success you did not verify; unsupported features must fail or be `not-assessed`.

## Adding an input format

1. Write a parser in `src/input/parsers/` that returns `BinaryMetadata` and throws `TruncatedError` for malformed
   input (use `FileView`/`Cursor`; they are bounds-checked).
2. Add an adapter. For self-describing formats extend `SelfDescribingBinaryAdapter` (`matchesMagic`, `parse`);
   otherwise implement `InputAdapter` directly (see `RawBinaryAdapter`, `ZipAdapter`).
3. Register it in `createDefaultRegistry` (`src/input/adapters/registry.ts`).
4. Add parser tests with a synthetic builder in `test/helpers/binaries.ts` and a detection test.
5. If Ghidra needs a loader hint for the format, extend `GhidraDecompiler.buildArguments`.

## Adding a decompiler, target language or validation check

- Decompiler: implement `Decompiler` (`src/decompiler/interfaces/decompiler.ts`) so that it produces the files
  validated by `validateAnalysisDirectory`; pass it to the pipeline (`PipelineDeps.decompiler`).
- Target language: implement `TargetLanguage` (`src/reconstruction/interfaces/target-language.ts`), add agent
  instructions for that language.
- Validation: add a function to `VALIDATION_CHECKS` returning `ValidationCheckResult[]`; use `not-assessed` when you
  cannot decide.

## Changing the Ghidra export script

`src/decompiler/scripts/ExportAnalysis.java` is compiled by Ghidra at run time (Java, Ghidra API only). After a change,
run `npm run test:ghidra` against a real installation, and keep the JSON in sync with
`src/decompiler/interfaces/schemas.ts` and `test/helpers/fake-ghidra.mjs`.

## Keeping documentation current

The project skill (`.claude/skills/recode-maintainer/SKILL.md`) is the maintainer's handbook: workflow, project map, commands,
decisions, known gaps and a change log. Update it in every change, and the README when installation, start, commands or
supported files change (the README stays short and has no CLI usage). Enforcement:

- `test/unit/docs-sync.test.ts` (part of `npm test`) compares the skill and README with the real CLI commands, input adapters
  and `src/` directories.
- `scripts/skill-guard.mjs` is a Claude Code Stop hook (`.claude/settings.json`) and a git pre-commit check
  (`npm run hooks` enables `.githooks`). `SKIP_SKILL_GUARD=1` bypasses it once.
