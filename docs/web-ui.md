# Web interface

`recode ui` starts a local web interface for the same workflow as the CLI. It is a normal part of the Node process:
no hosted backend, no accounts, no cloud.

```bash
npm run build                 # builds the server and the web UI (dist/web)
recode ui                     # prints http://127.0.0.1:<port>/?token=…  (add --open to launch a browser)
recode ui --workspace ~/work  # project directory (default: ~/recode-projects, changeable in Settings)
```

## What it does

| Page      | Function                                                                                                                                                        |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Projects  | Lists the projects of the workspace, creates new ones.                                                                                                          |
| Wizard    | Import → Analyze → Reconstruct → Build → Validate → Download. One binary at a time (selectable in Import).                                                      |
| Import    | Drag and drop or choose files (binaries, ZIPs, reference files). Headerless files open a form for architecture, endianness, bits, base address and entry point. |
| Live view | Task list with status, progress bar with time estimate, agent activity (subagents started), log with filters (Events, Ghidra, Claude, Build).                   |
| Validate  | Optional AI review; shows what passed, failed and was **not assessed**.                                                                                         |
| Download  | The generated C project as a ZIP.                                                                                                                               |
| Settings  | Workspace and configuration (user level or per project, validated like `recode config set`).                                                                    |
| Doctor    | Tool status with hints.                                                                                                                                         |

Themes: the eight cleanui themes can be switched in the header (stored in the browser).

Steps run **on the server**: closing the tab does not stop them. Reopen the project and the page reconnects, replays the
recent log and shows the current state. "Cancel" (or stopping `recode ui`) stops the step; progress stays resumable.
Not in this version: viewing reconstructed code in the browser, buttons for `--retry-failed`/`--repair` (use the CLI),
and sliders for parallelism (use `recode config set claude.maxParallelAgents`).

## Security

- Binds to `127.0.0.1` only. Every `/api` request needs the random token (header or `?token=`), compared in constant time.
  The token is read from the start URL, kept in `sessionStorage` for the tab and removed from the address bar.
- Requests whose `Host` header is not the loopback address are rejected (DNS rebinding); state-changing requests with a
  foreign `Origin` are rejected (CSRF).
- Strict Content-Security-Policy (`default-src 'self'`), `nosniff`, no framing.
- Uploads are streamed to a temporary directory below the project, limited to 2 GiB, names are reduced to a base name, and
  archives go through the same safe extraction as the CLI. The project lock prevents uploads while a job runs.
- Keep the URL private: whoever has the token can start analyses and read project data.

## Architecture

`src/server/` – `server.ts` (HTTP routes, static files, SSE), `jobs.ts` (one background job per project, uses
`app/pipeline.ts` like the CLI), `event-log.ts` (replayable event history), `log-tailer.ts` (streams tool transcripts),
`zip-writer.ts` (download). `web/` – React + Vite app styled with [cleanui](https://github.com/saali2901/cleanui);
built to `dist/web` and served by the CLI. API: `GET/POST /api/projects`, `PUT /api/projects/:p/files`,
`POST /api/projects/:p/jobs[/cancel]`, `GET /api/projects/:p/events` (Server-Sent Events), `GET /api/projects/:p/binaries/:id/{tasks,validation,download}`,
`GET /api/doctor`, `GET/PUT /api/config`, `PUT /api/workspace`.

## Development and tests

```bash
npm run dev          # server compiler in watch mode
npm run dev:web      # Vite dev server (proxies /api to 127.0.0.1:7878; start "recode ui --port 7878")
npm test             # includes API tests (test/integration/server.test.ts) and React component tests (web/src)
npm run test:e2e     # builds, then drives Chromium through the whole wizard (Playwright)
```
