import { useEffect, useRef, useState } from 'react';
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

export function JobStatus({ job, label }: { job: JobInfo | null; label: string }) {
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
          className={`alert ${job.status === 'failed' ? 'alert--danger' : 'alert--warning'}`}
          role="alert"
        >
          <div className="alert__content">
            <p className="alert__title">{job.status === 'failed' ? 'Step failed' : 'Cancelled'}</p>
            <p>{job.error}</p>
            {job.hint && <pre className="hint-block">{job.hint}</pre>}
            {job.status === 'cancelled' && <p>Progress is saved. Run the step again to resume.</p>}
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
  showLog = true,
}: {
  stream: StreamState;
  label: string;
  showLog?: boolean;
}) {
  return (
    <div className="stack gap-4">
      <JobStatus job={stream.job} label={label} />
      {showLog && stream.job && <LogView lines={stream.lines} />}
    </div>
  );
}
