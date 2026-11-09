import type { ReactNode } from 'react';
import { ApiError } from '../api';
import type { Status } from '../types';

export function ErrorAlert({
  error,
  title = 'Something went wrong',
}: {
  error: Error;
  title?: string;
}) {
  const hint = error instanceof ApiError ? error.hint : undefined;
  return (
    <div className="alert alert--danger" role="alert">
      <div className="alert__content">
        <p className="alert__title">{title}</p>
        <p>{error.message}</p>
        {hint && <pre className="hint-block">{hint}</pre>}
      </div>
    </div>
  );
}

const STATUS_TAG: Record<Status | 'not-assessed' | 'passed' | 'ok' | 'warn' | 'fail', string> = {
  pending: 'tag',
  running: 'tag tag--accent',
  completed: 'tag tag--success',
  failed: 'tag tag--danger',
  cancelled: 'tag tag--warning',
  passed: 'tag tag--success',
  'not-assessed': 'tag',
  ok: 'tag tag--success',
  warn: 'tag tag--warning',
  fail: 'tag tag--danger',
};

export function StatusTag({ status, label }: { status: keyof typeof STATUS_TAG; label?: string }) {
  return (
    <span className={STATUS_TAG[status] ?? 'tag'}>
      {status === 'running' && <span className="spinner spinner--small" aria-hidden="true" />}
      {label ?? status}
    </span>
  );
}

export function Section({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="card">
      <div className="card__body stack gap-4">
        <div className="cluster cluster--between">
          <h2 className="card__title">{title}</h2>
          {actions}
        </div>
        {children}
      </div>
    </section>
  );
}
