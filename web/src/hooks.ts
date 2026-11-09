import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { urlWithToken } from './api';
import type { JobInfo } from './types';

export interface Resource<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => void;
}

/** Loads data when `key` changes and exposes a reload function. */
export function useResource<T>(load: () => Promise<T>, key: string): Resource<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadRef
      .current()
      .then((value) => {
        if (cancelled) return;
        setData(value);
        setError(undefined);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [key, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { data, error, loading, reload };
}

export type Route =
  | { name: 'projects' }
  | { name: 'project'; project: string }
  | { name: 'settings' }
  | { name: 'doctor' };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'projects' && parts[1]) return { name: 'project', project: parts[1] };
  if (parts[0] === 'settings') return { name: 'settings' };
  if (parts[0] === 'doctor') return { name: 'doctor' };
  return { name: 'projects' };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = (): void => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export interface LogLine {
  id: number;
  kind: 'tool' | 'event';
  source: string;
  text: string;
}

export interface Activity {
  id: number;
  agent: string;
  summary: string;
}

export interface StreamState {
  connected: boolean;
  job: JobInfo | null;
  lines: LogLine[];
  activity: Activity[];
  /** Increments on every task or step event so views can refresh their data. */
  progressTick: number;
}

type StreamAction =
  | { type: 'connected'; value: boolean }
  | { type: 'job'; job: JobInfo }
  | { type: 'log'; id: number; file: string; line: string }
  | { type: 'event'; id: number; event: Record<string, unknown> };

const MAX_LINES = 1500;

export function describeEvent(event: Record<string, unknown>): string | undefined {
  const text = (key: string): string => String(event[key] ?? '');
  switch (event['type']) {
    case 'step-started':
      return `▶ ${text('step')} started`;
    case 'step-completed':
      return `■ ${text('step')} ${event['skipped'] ? 'up to date, skipped' : 'done'}`;
    case 'step-failed':
      return `■ ${text('step')} failed: ${text('message')}`;
    case 'task-completed':
      return `✓ ${text('label')}`;
    case 'task-failed':
      return `✗ ${text('label')}: ${text('message')}`;
    case 'info':
    case 'warning':
      return text('message');
    default:
      return undefined;
  }
}

export function streamReducer(state: StreamState, action: StreamAction): StreamState {
  switch (action.type) {
    case 'connected':
      return { ...state, connected: action.value };
    case 'job': {
      const isNewRun = action.job.status === 'running' && state.job?.id !== action.job.id;
      return {
        ...state,
        job: action.job,
        lines: isNewRun ? [] : state.lines,
        activity: isNewRun ? [] : state.activity,
        progressTick: state.progressTick + 1,
      };
    }
    case 'log':
      return {
        ...state,
        lines: [
          ...state.lines,
          { id: action.id, kind: 'tool' as const, source: action.file, text: action.line },
        ].slice(-MAX_LINES),
      };
    case 'event': {
      const type = String(action.event['type']);
      const text = describeEvent(action.event);
      const lines = text
        ? [...state.lines, { id: action.id, kind: 'event' as const, source: 'recode', text }].slice(
            -MAX_LINES,
          )
        : state.lines;
      const activity =
        type === 'agent-activity'
          ? [
              ...state.activity,
              {
                id: action.id,
                agent: String(action.event['agent']),
                summary: String(action.event['summary']),
              },
            ].slice(-200)
          : state.activity;
      const progress = type.startsWith('task-') || type.startsWith('step-');
      return { ...state, lines, activity, progressTick: state.progressTick + (progress ? 1 : 0) };
    }
  }
}

export const initialStream: StreamState = {
  connected: false,
  job: null,
  lines: [],
  activity: [],
  progressTick: 0,
};

/** Subscribes to the server's event stream for a project; EventSource reconnects and replays automatically. */
export function useProjectStream(project: string): StreamState {
  const [state, dispatch] = useReducer(streamReducer, initialStream);
  useEffect(() => {
    const source = new EventSource(
      urlWithToken(`/api/projects/${encodeURIComponent(project)}/events`),
    );
    source.onopen = () => dispatch({ type: 'connected', value: true });
    source.onerror = () => dispatch({ type: 'connected', value: false });
    const parse = (event: MessageEvent<string>): unknown => JSON.parse(event.data);
    const id = (event: MessageEvent<string>): number => Number.parseInt(event.lastEventId, 10) || 0;
    source.addEventListener('job', (event) =>
      dispatch({ type: 'job', job: parse(event as MessageEvent<string>) as JobInfo }),
    );
    source.addEventListener('log', (event) => {
      const data = parse(event as MessageEvent<string>) as { file: string; line: string };
      dispatch({
        type: 'log',
        id: id(event as MessageEvent<string>),
        file: data.file,
        line: data.line,
      });
    });
    source.addEventListener('event', (event) =>
      dispatch({
        type: 'event',
        id: id(event as MessageEvent<string>),
        event: parse(event as MessageEvent<string>) as Record<string, unknown>,
      }),
    );
    return () => source.close();
  }, [project]);
  return state;
}

/** Re-renders every second while `active`, returning the current time. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
