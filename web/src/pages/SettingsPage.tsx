import { useState } from 'react';
import { api } from '../api';
import { ErrorAlert } from '../components/common';
import { useResource } from '../hooks';
import type { ConfigResponse, ProjectListItem } from '../types';

/** Optional keys do not appear in the effective configuration until they are set. */
const OPTIONAL_KEYS = ['tools.ghidraInstallDir', 'tools.cCompiler', 'claude.model'];

export function flatten(value: unknown, prefix = ''): Array<[string, string]> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      flatten(v, prefix ? `${prefix}.${k}` : k),
    );
  }
  return [[prefix, typeof value === 'string' ? value : JSON.stringify(value)]];
}

function WorkspaceSection() {
  const info = useResource(
    () => api.get<{ workspace: string; workspaceFixed: boolean }>('/api/info'),
    'info',
  );
  const [value, setValue] = useState<string>();
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();

  async function save(): Promise<void> {
    try {
      await api.put('/api/workspace', { path: value });
      setMessage({ ok: true, text: 'Workspace saved.' });
      info.reload();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  }

  if (!info.data) return info.error ? <ErrorAlert error={info.error} /> : null;
  return (
    <section className="card">
      <div className="card__body stack gap-3">
        <h2 className="card__title">Workspace</h2>
        <div className="field">
          <label className="field__label" htmlFor="workspace">
            Directory containing your projects
          </label>
          <div className="cluster gap-2">
            <input
              id="workspace"
              className="input"
              value={value ?? info.data.workspace}
              disabled={info.data.workspaceFixed}
              onChange={(e) => setValue(e.target.value)}
              aria-describedby="workspace-hint"
            />
            <button
              className="btn btn--primary"
              type="button"
              disabled={info.data.workspaceFixed || value === undefined}
              onClick={() => void save()}
            >
              Save
            </button>
          </div>
          <p className="field__hint" id="workspace-hint">
            {info.data.workspaceFixed
              ? 'Fixed by --workspace when the server was started.'
              : 'Absolute path. Created when you add the first project.'}
          </p>
        </div>
        {message && (
          <p role="status" className={message.ok ? 'text-success' : 'text-danger'}>
            {message.text}
          </p>
        )}
      </div>
    </section>
  );
}

function ConfigSection() {
  const projects = useResource(
    () => api.get<{ projects: ProjectListItem[] }>('/api/projects'),
    'settings-projects',
  );
  const [scope, setScope] = useState('user');
  const query = scope === 'user' ? '' : `?project=${encodeURIComponent(scope)}`;
  const config = useResource(
    () => api.get<ConfigResponse>(`/api/config${query}`),
    `config-${scope}`,
  );
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();

  async function save(key: string): Promise<void> {
    try {
      await api.put(`/api/config${query}`, {
        scope: scope === 'user' ? 'user' : 'project',
        key,
        value: edits[key] ?? '',
      });
      setEdits((all) => Object.fromEntries(Object.entries(all).filter(([k]) => k !== key)));
      setMessage({ ok: true, text: `Saved ${key}.` });
      config.reload();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  }

  const rows = new Map(flatten(config.data?.effective));
  for (const key of OPTIONAL_KEYS) if (!rows.has(key)) rows.set(key, '');
  rows.delete('ui.workspace');
  const layer = scope === 'user' ? config.data?.user : config.data?.project;
  const overridden = new Set(flatten(layer ?? {}).map(([k]) => k));

  return (
    <section className="card">
      <div className="card__body stack gap-4">
        <div className="cluster cluster--between">
          <h2 className="card__title">Configuration</h2>
          <div className="field field--inline">
            <label className="field__label" htmlFor="config-scope">
              Applies to
            </label>
            <select
              id="config-scope"
              className="select"
              value={scope}
              onChange={(e) => {
                setScope(e.target.value);
                setEdits({});
                setMessage(undefined);
              }}
            >
              <option value="user">All projects (user level)</option>
              {(projects.data?.projects ?? []).map((p) => (
                <option key={p.name} value={p.name}>
                  Project: {p.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        {config.error && <ErrorAlert error={config.error} />}
        {message && (
          <p role="status" className={message.ok ? 'text-success' : 'text-danger'}>
            {message.text}
          </p>
        )}
        <div className="table-wrap">
          <table className="table--compact">
            <thead>
              <tr>
                <th>Setting</th>
                <th>Value</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {[...rows.entries()].map(([key, current]) => (
                <tr key={key}>
                  <td>
                    <code>{key}</code>
                    {overridden.has(key) && (
                      <span className="tag tag--small tag--accent config-tag">set here</span>
                    )}
                  </td>
                  <td>
                    <input
                      className="input"
                      aria-label={key}
                      value={edits[key] ?? current}
                      onChange={(e) => setEdits({ ...edits, [key]: e.target.value })}
                    />
                  </td>
                  <td>
                    <button
                      className="btn btn--small"
                      type="button"
                      disabled={edits[key] === undefined || edits[key] === current}
                      onClick={() => void save(key)}
                    >
                      Save
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-sm text-muted">
          Values are JSON where possible (<code>3</code>, <code>true</code>) and text otherwise.
          Invalid values are rejected.
        </p>
      </div>
    </section>
  );
}

export function SettingsPage() {
  return (
    <div className="stack gap-6">
      <h1>Settings</h1>
      <WorkspaceSection />
      <ConfigSection />
    </div>
  );
}
