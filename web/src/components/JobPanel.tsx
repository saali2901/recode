import { useEffect, useRef, useState } from 'react';
import { api, projectPath } from '../api';
import { formatDuration } from '../format';
import { useNow, type LogLine, type StreamState } from '../hooks';
import type { JobInfo } from '../types';
import { StatusTag } from './common';

const FILTERS: Array<{ id: string; label: string; match: (line: LogLine) => boolean }> = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'events', label: 'Events', match: (l) => l.kind === 'event' },
  { id: 'ghidra', label: 'Ghidra', match: (l) => l.source.startsWith('analyze-') },
  { id: 'claude', label: 'Claude', match: (l) => l.source.startsWith('claude-') },
  { id: 'build', label: 'Build', match: (l) => l.source.startsWith('build-') },
];

export function LogView({ lines }: { lines: LogLine[] }) {
  const [filter, setFilter] = useState('all');
  const box = useRef<HTMLPreElement>(null);
  const visible = lines.filter(FILTERS.find((f) => f.id === filter)?.match ?? (() => true));

  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible.length]);

  return (
    <div className="stack gap-2">
      <div className="cluster cluster--between">
        <h3 className="log-heading">Log</h3>
        <div role="group" aria-label="Log filter" className="cluster gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className="btn btn--small btn--ghost"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
      <pre className="log-view" ref={box} tabIndex={0} aria-label="Live log" aria-live="off">
        {visible.length === 0 ? '(no output yet)' : visible.map((l) => `${l.text}\n`).join('')}
      </pre>
    </div>
  );
}

export function JobStatus({
  job,
  label,
  project,
}: {
  job: JobInfo | null;
  label: string;
  project?: string | undefined;
}) {
  const [trusted, setTrusted] = useState<string>();
  const running = job?.status === 'running';
  const now = useNow(running);
  if (!job) return null;
  const end = job.finishedAt ? Date.parse(job.finishedAt) : now;
  return (
    <div className="stack gap-2">
      <div className="cluster gap-3">
        <StatusTag status={job.status} />
        <span className="text-sm text-muted">
          {label} · {formatDuration(end - Date.parse(job.startedAt))}
        </span>
      </div>
      {job.status === 'completed' && job.summary && <p className="text-sm">{job.summary}</p>}
      {(job.status === 'failed' || job.status === 'cancelled') && job.error && (
        <div
          className={`alert ${job.status === 'failed' && job.errorCode !== 'RATE_LIMIT' ? 'alert--danger' : 'alert--warning'}`}
          role="alert"
        >
          <div className="alert__content">
            <p className="alert__title">
              {job.errorCode === 'RATE_LIMIT'
                ? 'Claude usage limit reached'
                : job.errorCode === 'UNTRUSTED'
                  ? 'Claude Code does not trust this project folder'
                  : job.status === 'failed'
                    ? 'Step failed'
                    : 'Cancelled'}
            </p>
            <p>{job.error}</p>
            {job.hint && <pre className="hint-block">{job.hint}</pre>}
            {job.status === 'cancelled' && <p>Progress is saved. Run the step again to resume.</p>}
            {job.errorCode === 'UNTRUSTED' && project && (
              <div className="stack gap-2">
                <p className="text-sm">
                  This marks the folder as trusted in Claude Code&apos;s own settings (the same as
                  accepting its trust dialog).
                </p>
                <div>
                  <button
                    className="btn btn--primary btn--small"
                    type="button"
                    onClick={() => {
                      api
                        .post(`${projectPath(project)}/trust`)
                        .then(() => setTrusted('Trusted. Start the step again.'))
                        .catch((e: unknown) =>
                          setTrusted(e instanceof Error ? e.message : String(e)),
                        );
                    }}
                  >
                    Trust this project
                  </button>
                </div>
                {trusted && <p role="status">{trusted}</p>}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Job status plus live log for the current stream; shown below the controls of a step. */
export function JobPanel({
  stream,
  label,
  project,
  showLog = true,
}: {
  stream: StreamState;
  label: string;
  project?: string;
  showLog?: boolean;
}) {
  return (
    <div className="stack gap-4">
      <JobStatus job={stream.job} label={label} project={project} />
      {showLog && stream.job && <LogView lines={stream.lines} />}
    </div>
  );
}
