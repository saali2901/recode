import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { ErrorAlert, StatusTag } from '../components/common';
import { useResource } from '../hooks';
import type { ProjectListItem } from '../types';

interface ProjectsResponse {
  workspace: string;
  projects: ProjectListItem[];
}

export function ProjectsPage() {
  const projects = useResource(() => api.get<ProjectsResponse>('/api/projects'), 'projects');
  const [name, setName] = useState('');
  const [error, setError] = useState<Error>();
  const [busy, setBusy] = useState(false);

  async function create(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.post('/api/projects', { name: name.trim() });
      window.location.hash = `#/projects/${encodeURIComponent(name.trim())}`;
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setBusy(false);
    }
  }

  const list = projects.data?.projects ?? [];
  return (
    <div className="stack gap-6">
      <div className="stack gap-1">
        <h1>Projects</h1>
        {projects.data && (
          <p className="text-muted">
            Workspace: <code>{projects.data.workspace}</code> · <a href="#/settings">change</a>
          </p>
        )}
      </div>

      {projects.error && <ErrorAlert error={projects.error} title="Cannot load projects" />}

      <form className="card card--subtle" onSubmit={create}>
        <div className="card__body stack gap-3">
          <div className="field">
            <label className="field__label" htmlFor="project-name">
              New project
            </label>
            <div className="cluster gap-2">
              <input
                id="project-name"
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-project"
                autoComplete="off"
                aria-describedby="project-name-hint"
              />
              <button
                className="btn btn--primary"
                type="submit"
                disabled={busy || name.trim() === ''}
              >
                Create project
              </button>
            </div>
            <p className="field__hint" id="project-name-hint">
              Letters, digits, “.”, “_” and “-”.
            </p>
          </div>
          {error && <ErrorAlert error={error} title="Cannot create project" />}
        </div>
      </form>

      {projects.data && list.length === 0 && (
        <div className="empty-state empty-state--bordered">
          <p className="empty-state__title">No projects yet</p>
          <p className="empty-state__text">
            Create a project above, then import a binary to analyze.
          </p>
        </div>
      )}

      <ul className="grid grid--3 gap-4 project-grid">
        {list.map((project) => (
          <li key={project.name}>
            <a
              className="card card--interactive"
              href={`#/projects/${encodeURIComponent(project.name)}`}
            >
              <div className="card__body stack gap-2">
                <div className="cluster cluster--between">
                  <span className="card__title">{project.name}</span>
                  {project.running && <StatusTag status="running" label={project.running} />}
                </div>
                <p className="text-sm text-muted">
                  {project.binaries} {project.binaries === 1 ? 'binary' : 'binaries'} ·{' '}
                  {project.references} reference {project.references === 1 ? 'file' : 'files'}
                </p>
                {project.error && <p className="text-sm">{project.error}</p>}
              </div>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function errorOf(e: unknown): Error {
  return e instanceof ApiError || e instanceof Error ? e : new Error(String(e));
}
