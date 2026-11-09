import { useEffect, useRef, useState } from 'react';
import { api, projectPath, urlWithToken } from '../api';
import { ErrorAlert, StatusTag } from '../components/common';
import { JobPanel } from '../components/JobPanel';
import { estimateRemaining, formatDuration } from '../format';
import { useNow, useResource, type StreamState } from '../hooks';
import type { BinarySummary, StepName, TaskItem, ValidationReport } from '../types';

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
      <JobPanel stream={stream} label={step} />
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
              </td>
              <td>
                <StatusTag status={task.status} />
              </td>
              <td className="num">{task.attempts}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ReconstructPanel(props: RunProps) {
  const { project, binary } = props;
  const { error, start, cancel } = useStart(project, binary, props.onStarted);
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
        onStart={(force) => void start('reconstruct', { force })}
        onCancel={() => void cancel()}
      />
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
      <JobPanel stream={stream} label="reconstruct" />
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
      <JobPanel stream={stream} label="validate" showLog={aiReview || running} />
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
