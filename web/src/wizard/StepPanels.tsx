import { useEffect, useRef, useState } from 'react';
import { ApiError, api, projectPath, urlWithToken } from '../api';
import { ErrorAlert, StatusTag } from '../components/common';
import { JobPanel } from '../components/JobPanel';
import { estimateRemaining, formatDuration } from '../format';
import { useNow, useResource, type StreamState } from '../hooks';
import type {
  BinarySummary,
  DependencyMode,
  PerfReport,
  RunOptions,
  StepName,
  TaskItem,
  ValidationReport,
} from '../types';
import { formatCount } from '../format';

interface RunProps {
  project: string;
  binary: BinarySummary;
  stream: StreamState;
  /** True while any job of the project runs. */
  busy: boolean;
  onStarted: () => void;
}

function useStart(project: string, binary: BinarySummary, onStarted: () => void) {
  const [error, setError] = useState<Error>();
  async function start(step: string, extra: Record<string, unknown> = {}): Promise<void> {
    setError(undefined);
    try {
      await api.post(`${projectPath(project)}/jobs`, { step, binaryId: binary.id, ...extra });
      onStarted();
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    }
  }
  async function cancel(): Promise<void> {
    try {
      await api.post(`${projectPath(project)}/jobs/cancel`);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    }
  }
  return { error, start, cancel };
}

function jobFor(stream: StreamState, step: string): StreamState {
  const relevant = stream.job && (stream.job.step === step || stream.job.step === 'run');
  return relevant ? stream : { ...stream, job: null, lines: [] };
}

function runLabel(state: BinarySummary['steps'], step: StepName): string {
  const status = state?.[step]?.status;
  if (status === 'completed') return 'Run again';
  if (status === 'failed' || status === 'cancelled') return 'Resume';
  return 'Start';
}

function StepSummary({ binary, step }: { binary: BinarySummary; step: StepName }) {
  const state = binary.steps?.[step];
  if (!state) return null;
  return (
    <div className="cluster gap-3">
      <StatusTag status={state.status} />
      {state.summary && <span className="text-sm">{state.summary}</span>}
      {state.error && state.status !== 'completed' && (
        <span className="text-sm text-muted">{state.error}</span>
      )}
    </div>
  );
}

function RunControls({
  running,
  busy,
  label,
  onStart,
  onCancel,
  extra,
}: {
  running: boolean;
  busy: boolean;
  label: string;
  onStart: (force: boolean) => void;
  onCancel: () => void;
  extra?: React.ReactNode;
}) {
  const [force, setForce] = useState(false);
  return (
    <div className="cluster gap-4">
      {running ? (
        <button className="btn btn--danger" type="button" onClick={onCancel}>
          Cancel
        </button>
      ) : (
        <button
          className="btn btn--primary"
          type="button"
          disabled={busy}
          onClick={() => onStart(force)}
        >
          {label}
        </button>
      )}
      {extra}
      {!running && (
        <label className="choice">
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />{' '}
          Force re-run
        </label>
      )}
    </div>
  );
}

export function SimpleStepPanel({
  step,
  description,
  ...props
}: RunProps & { step: 'analyze' | 'build'; description: string }) {
  const { error, start, cancel } = useStart(props.project, props.binary, props.onStarted);
  const stream = jobFor(props.stream, step);
  const running = stream.job?.status === 'running';
  return (
    <div className="stack gap-4">
      <p>{description}</p>
      <StepSummary binary={props.binary} step={step} />
      <RunControls
        running={running}
        busy={props.busy}
        label={runLabel(props.binary.steps, step)}
        onStart={(force) => void start(step, { force })}
        onCancel={() => void cancel()}
      />
      {error && <ErrorAlert error={error} title="Cannot start" />}
      <JobPanel stream={stream} label={step} project={props.project} />
    </div>
  );
}

export function TaskList({ tasks }: { tasks: TaskItem[] }) {
  if (tasks.length === 0) return <p className="text-sm text-muted">No tasks planned yet.</p>;
  return (
    <div className="table-wrap task-table">
      <table className="table--compact">
        <caption className="sr-only">Reconstruction tasks</caption>
        <thead>
          <tr>
            <th>Task</th>
            <th>Status</th>
            <th>Model tier</th>
            <th className="num">Attempts</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr key={task.id}>
              <td>
                {task.title}
                {task.lastError && task.status !== 'completed' && (
                  <div className="text-sm text-muted">{task.lastError}</div>
                )}
                {task.openIssues && task.openIssues.length > 0 && (
                  <div className="text-sm text-muted">
                    Open findings: {task.openIssues.slice(0, 2).join(' | ')}
                  </div>
                )}
              </td>
              <td>
                <StatusTag status={task.status} />
              </td>
              <td>
                {task.tier ? <span className="tag">{task.tier}</span> : '–'}
                {task.escalations ? ` ↑${task.escalations}` : ''}
                {task.fromCache ? ' (cache)' : ''}
              </td>
              <td className="num">{task.attempts}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const DEPENDENCY_LABELS: Record<DependencyMode, string> = {
  adaptive: 'Adaptive (fast; callers may start before their callees are done)',
  complete: 'Complete (callees first; best prototypes, slower)',
  signatures: 'Signatures only (fastest; no waiting for callees)',
  legacy: 'Original behaviour (one session, one model, no routing)',
};

function without(options: RunOptions, key: keyof RunOptions): RunOptions {
  return Object.fromEntries(Object.entries(options).filter(([k]) => k !== key)) as RunOptions;
}

/** Per-run scheduler settings. Defaults come from the project configuration (Settings). */
export function RunOptionsForm({
  value,
  onChange,
  disabled,
}: {
  value: RunOptions;
  onChange: (next: RunOptions) => void;
  disabled: boolean;
}) {
  return (
    <details className="stack gap-2">
      <summary>Run options</summary>
      <div className="grid grid--2 gap-4">
        <div className="field">
          <label className="field__label" htmlFor="run-sessions">
            Concurrent sessions (maximum)
          </label>
          <input
            id="run-sessions"
            className="input"
            type="number"
            min={1}
            max={16}
            placeholder="from settings"
            disabled={disabled}
            value={value.sessions ?? ''}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10);
              const rest = without(value, 'sessions');
              onChange(
                Number.isFinite(n) ? { ...rest, sessions: Math.min(16, Math.max(1, n)) } : rest,
              );
            }}
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="run-dependencies">
            Function dependencies
          </label>
          <select
            id="run-dependencies"
            className="select"
            disabled={disabled}
            value={value.dependencies ?? ''}
            onChange={(e) => {
              const rest = without(value, 'dependencies');
              onChange(
                e.target.value ? { ...rest, dependencies: e.target.value as DependencyMode } : rest,
              );
            }}
          >
            <option value="">From settings (adaptive)</option>
            {(Object.keys(DEPENDENCY_LABELS) as DependencyMode[]).map((mode) => (
              <option key={mode} value={mode}>
                {DEPENDENCY_LABELS[mode]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <label className="choice">
        <input
          type="checkbox"
          disabled={disabled}
          checked={value.noCache === true}
          onChange={(e) => onChange({ ...value, noCache: e.target.checked })}
        />{' '}
        Ignore the result cache in this run
      </label>
      <p className="text-sm text-muted">
        Models per tier and the other limits are set in Settings (routing.* and scheduler.*).
      </p>
    </details>
  );
}

function pct(value: number): string {
  return `${(value * 100).toFixed(0)} %`;
}

/** Metrics of the latest reconstruction run (from the same files `recode perf` reads). */
export function PerformancePanel({ report }: { report: PerfReport | undefined }) {
  if (!report) {
    return <p className="text-sm text-muted">No finished run yet - metrics appear after a run.</p>;
  }
  const s = report.summary;
  return (
    <div className="stack gap-3">
      <p className="text-sm text-muted">
        Run {report.runId} · mode <strong>{report.mode}</strong>
        {report.analysis
          ? ` · Ghidra ${(report.analysis.ghidraMs / 1000).toFixed(1)} s, ${report.analysis.functions} functions`
          : ''}
      </p>
      <dl className="grid grid--2 gap-2" aria-label="Run summary">
        <div>
          <dt className="text-sm text-muted">Duration</dt>
          <dd>{formatDuration(s.wallSeconds * 1000)}</dd>
        </div>
        <div>
          <dt className="text-sm text-muted">Model sessions</dt>
          <dd>{formatCount(s.modelCalls)}</dd>
        </div>
        <div>
          <dt className="text-sm text-muted">Concurrent sessions (max / average)</dt>
          <dd>
            {s.workersMax} / {s.workersAverage}
          </dd>
        </div>
        <div>
          <dt className="text-sm text-muted">Mean queue wait</dt>
          <dd>{s.meanQueueWaitSeconds.toFixed(1)} s</dd>
        </div>
        <div>
          <dt className="text-sm text-muted">Accepted / failed</dt>
          <dd>
            {formatCount(s.accepted)} / {formatCount(s.failed)}
          </dd>
        </div>
        <div>
          <dt className="text-sm text-muted">Escalations / retries</dt>
          <dd>
            {s.escalations} / {s.retries}
          </dd>
        </div>
        <div>
          <dt className="text-sm text-muted">Cache hit rate</dt>
          <dd>{pct(s.cacheHitRate)}</dd>
        </div>
        <div>
          <dt className="text-sm text-muted">Compile errors found before the build</dt>
          <dd>{s.compileErrors}</dd>
        </div>
      </dl>
      <div className="table-wrap">
        <table className="table--compact">
          <caption className="sr-only">Sessions per model tier</caption>
          <thead>
            <tr>
              <th>Tier</th>
              <th>Model</th>
              <th className="num">Sessions</th>
              <th className="num">Seconds</th>
              <th className="num">Input tokens</th>
              <th className="num">Output tokens</th>
              <th className="num">Failed</th>
            </tr>
          </thead>
          <tbody>
            {s.perModel.map((m) => (
              <tr key={`${m.tier}|${m.model}`}>
                <td>{m.tier}</td>
                <td>{m.model}</td>
                <td className="num">{m.calls}</td>
                <td className="num">{m.seconds.toFixed(1)}</td>
                <td className="num">{formatCount(m.inputTokens)}</td>
                <td className="num">{formatCount(m.outputTokens)}</td>
                <td className="num">{m.failures}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-sm text-muted">
        Tokens and cost are reported by the Claude Code CLI and stay 0 if the installed version does
        not report them. Timings of this tool, not a measure of reconstruction quality.
      </p>
    </div>
  );
}

export function ReconstructPanel(props: RunProps) {
  const { project, binary } = props;
  const { error, start, cancel } = useStart(project, binary, props.onStarted);
  const [options, setOptions] = useState<RunOptions>({});
  const perf = useResource(
    () =>
      api
        .get<PerfReport>(`${projectPath(project)}/binaries/${encodeURIComponent(binary.id)}/perf`)
        .catch((e: unknown) => {
          if (e instanceof ApiError && e.status === 404) return undefined;
          throw e;
        }),
    `${binary.id}:perf:${props.stream.progressTick}`,
  );
  const stream = jobFor(props.stream, 'reconstruct');
  const running = stream.job?.status === 'running';
  const tasks = useResource(
    () =>
      api.get<{ tasks: TaskItem[] }>(
        `${projectPath(project)}/binaries/${encodeURIComponent(binary.id)}/tasks`,
      ),
    `${binary.id}:${props.stream.progressTick}`,
  );
  const list = tasks.data?.tasks ?? [];
  const completed = list.filter((t) => t.status === 'completed').length;
  const failed = list.filter((t) => t.status === 'failed').length;
  const now = useNow(running);

  const baseline = useRef<{ jobId: string; completed: number } | undefined>(undefined);
  useEffect(() => {
    if (stream.job?.status === 'running' && baseline.current?.jobId !== stream.job.id) {
      baseline.current = { jobId: stream.job.id, completed };
    }
  }, [stream.job, completed]);

  const elapsed = stream.job ? now - Date.parse(stream.job.startedAt) : 0;
  const doneThisRun = completed - (baseline.current?.completed ?? 0);
  const leftTasks = list.length - completed;
  const eta = running
    ? estimateRemaining(elapsed, doneThisRun, doneThisRun + leftTasks)
    : undefined;

  const agents = stream.activity.reduce<Record<string, number>>(
    (acc, a) => ({ ...acc, [a.agent]: (acc[a.agent] ?? 0) + 1 }),
    {},
  );

  return (
    <div className="stack gap-4">
      <p>
        A lead agent splits the work into tasks and delegates them to specialist subagents (binary
        analyst, structure analyst, function analyst, C reconstructor). Progress is saved after
        every task, so you can stop and resume at any time.
      </p>
      <StepSummary binary={binary} step="reconstruct" />
      <RunControls
        running={running}
        busy={props.busy}
        label={runLabel(binary.steps, 'reconstruct')}
        onStart={(force) => void start('reconstruct', { force, options })}
        onCancel={() => void cancel()}
      />
      <RunOptionsForm value={options} onChange={setOptions} disabled={running || props.busy} />
      {error && <ErrorAlert error={error} title="Cannot start" />}

      {list.length > 0 && (
        <div className="stack gap-2">
          <div className="progress-label">
            <span>
              {completed} of {list.length} tasks completed{failed > 0 ? `, ${failed} failed` : ''}
            </span>
            <span>
              {running && eta !== undefined
                ? `about ${formatDuration(eta)} left`
                : running
                  ? 'estimating…'
                  : ''}
              {running && stream.job ? ` · ${formatDuration(elapsed)} elapsed` : ''}
            </span>
          </div>
          <progress
            className={`progress${failed > 0 ? ' progress--warning' : ''}`}
            value={completed}
            max={list.length}
            aria-label="Reconstruction progress"
          />
        </div>
      )}

      <div className="grid grid--2 gap-6">
        <div className="stack gap-2">
          <h3>Tasks</h3>
          {tasks.error ? <ErrorAlert error={tasks.error} /> : <TaskList tasks={list} />}
        </div>
        <div className="stack gap-2">
          <h3>Agent activity</h3>
          {Object.keys(agents).length === 0 ? (
            <p className="text-sm text-muted">No subagents started in this run.</p>
          ) : (
            <ul className="stack gap-1" aria-label="Agent activity summary">
              {Object.entries(agents).map(([agent, count]) => (
                <li key={agent}>
                  <span className="tag">{agent}</span> started {count}×
                </li>
              ))}
            </ul>
          )}
          <ul className="activity-list" aria-label="Recent agent activity">
            {stream.activity.slice(-8).map((a) => (
              <li key={a.id} className="text-sm text-muted">
                {a.agent}: {a.summary}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="stack gap-2">
        <h3>Performance of the last run</h3>
        {perf.error ? <ErrorAlert error={perf.error} /> : <PerformancePanel report={perf.data} />}
      </div>
      <JobPanel stream={stream} label="reconstruct" project={project} />
    </div>
  );
}

export function ValidatePanel(props: RunProps) {
  const { project, binary } = props;
  const { error, start, cancel } = useStart(project, binary, props.onStarted);
  const stream = jobFor(props.stream, 'validate');
  const running = stream.job?.status === 'running';
  const [aiReview, setAiReview] = useState(false);
  const done = binary.steps?.validate.status === 'completed';
  const report = useResource(
    () =>
      done
        ? api.get<ValidationReport>(
            `${projectPath(project)}/binaries/${encodeURIComponent(binary.id)}/validation`,
          )
        : Promise.resolve(undefined),
    `${binary.id}:${done}:${props.stream.progressTick}`,
  );

  return (
    <div className="stack gap-4">
      <p>
        Validation reports what was checked and what was <strong>not</strong>. A successful build
        does not mean the reconstruction behaves like the original program.
      </p>
      <StepSummary binary={binary} step="validate" />
      <RunControls
        running={running}
        busy={props.busy}
        label={runLabel(binary.steps, 'validate')}
        onStart={(force) => void start('validate', { force, aiReview })}
        onCancel={() => void cancel()}
        extra={
          <label className="choice">
            <input
              type="checkbox"
              role="switch"
              checked={aiReview}
              onChange={(e) => setAiReview(e.target.checked)}
            />{' '}
            AI review (uses Claude Code)
          </label>
        }
      />
      {error && <ErrorAlert error={error} title="Cannot start" />}
      <JobPanel stream={stream} label="validate" project={project} showLog={aiReview || running} />
      {report.data && (
        <div className="stack gap-3">
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Validation results</caption>
              <thead>
                <tr>
                  <th>Check</th>
                  <th>Result</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {report.data.checks.map((check) => (
                  <tr key={check.id}>
                    <td>
                      {check.title}
                      <div className="text-sm text-muted">{check.level}</div>
                    </td>
                    <td>
                      <StatusTag
                        status={
                          check.outcome === 'failed'
                            ? 'failed'
                            : check.outcome === 'passed'
                              ? 'passed'
                              : 'not-assessed'
                        }
                        label={check.outcome}
                      />
                    </td>
                    <td>{check.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-sm text-muted">{report.data.disclaimer}</p>
        </div>
      )}
    </div>
  );
}

export function DownloadPanel({ project, binary }: { project: string; binary: BinarySummary }) {
  const ready = binary.steps?.reconstruct.status === 'completed';
  const href = urlWithToken(
    `${projectPath(project)}/binaries/${encodeURIComponent(binary.id)}/download`,
  );
  return (
    <div className="stack gap-4">
      <p>
        The generated C project (sources, headers, <code>CMakeLists.txt</code> and{' '}
        <code>RECONSTRUCTION.md</code> with the confidence and assumptions of every function) is
        ready as a ZIP archive.
      </p>
      {ready ? (
        <div>
          <a className="btn btn--primary" href={href} download>
            Download C project (.zip)
          </a>
        </div>
      ) : (
        <p className="text-muted">Run the reconstruction first.</p>
      )}
      <p className="text-sm text-muted">
        To build it yourself: unzip, then{' '}
        <code>cmake -S . -B build -G Ninja &amp;&amp; cmake --build build</code>.
      </p>
    </div>
  );
}
