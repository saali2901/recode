import { useEffect, useRef, useState } from 'react';
import { api, projectPath } from '../api';
import { ErrorAlert, StatusTag } from '../components/common';
import { useProjectStream, useResource } from '../hooks';
import type { ProjectDetail } from '../types';
import { ImportPanel } from '../wizard/ImportPanel';
import {
  DownloadPanel,
  ReconstructPanel,
  SimpleStepPanel,
  ValidatePanel,
} from '../wizard/StepPanels';
import { firstOpenStep, WIZARD_STEPS } from '../wizard/steps';

export function WizardPage({ project }: { project: string }) {
  const detail = useResource(() => api.get<ProjectDetail>(projectPath(project)), project);
  const stream = useProjectStream(project);
  const [binaryId, setBinaryId] = useState<string>();
  const [chosenStep, setChosenStep] = useState<number>();

  // Refresh project data whenever the server reports progress or a job changes state.
  const { reload } = detail;
  useEffect(() => {
    if (stream.progressTick === 0) return;
    const timer = setTimeout(reload, 250);
    return () => clearTimeout(timer);
  }, [stream.progressTick, reload]);

  const data = detail.data;
  const binary = data?.binaries.find((b) => b.id === binaryId) ?? data?.binaries[0];
  const reachable = firstOpenStep(data, binary);
  // Start at the first open step once; afterwards only the user moves between steps.
  const startStep = useRef<number | undefined>(undefined);
  if (data && startStep.current === undefined) startStep.current = reachable;
  const active = Math.min(chosenStep ?? startStep.current ?? reachable, reachable);
  const busy = stream.job?.status === 'running' || data?.job?.status === 'running';

  if (detail.error && !data) {
    return (
      <div className="stack gap-4">
        <ErrorAlert error={detail.error} title="Cannot open project" />
        <a href="#/">Back to projects</a>
      </div>
    );
  }
  if (!data) return <p className="text-muted">Loading…</p>;

  const step = WIZARD_STEPS[active];
  const common = binary
    ? { project, binary, stream, busy: busy === true, onStarted: reload }
    : undefined;

  return (
    <div className="stack gap-6">
      <div className="cluster cluster--between">
        <div className="stack gap-1">
          <p className="text-sm">
            <a href="#/">Projects</a> /
          </p>
          <h1>{data.name}</h1>
        </div>
        <div className="cluster gap-3">
          {busy && (
            <StatusTag
              status="running"
              label={`${stream.job?.step ?? data.job?.step ?? 'job'} running`}
            />
          )}
          {!stream.connected && <span className="tag tag--warning">reconnecting…</span>}
        </div>
      </div>

      {data.binaries.length > 1 && binary && (
        <div className="field">
          <label className="field__label" htmlFor="binary-select">
            Binary
          </label>
          <select
            id="binary-select"
            className="select"
            value={binary.id}
            onChange={(e) => setBinaryId(e.target.value)}
          >
            {data.binaries.map((b) => (
              <option key={b.id} value={b.id}>
                {b.fileName} ({b.format}, {b.architecture})
              </option>
            ))}
          </select>
        </div>
      )}

      <ol className="stepper" aria-label="Workflow">
        {WIZARD_STEPS.map((s, index) => (
          <li
            key={s.id}
            className="stepper__step"
            aria-current={index === active ? 'step' : undefined}
          >
            <span className="stepper__label">{s.label}</span>
            <span className="stepper__hint">{s.hint}</span>
          </li>
        ))}
      </ol>

      <section className="card" aria-labelledby="step-title">
        <div className="card__body stack gap-6">
          <h2 id="step-title" className="card__title">
            {active + 1}. {step?.label}
          </h2>
          {step?.id === 'import' && (
            <ImportPanel
              project={project}
              binaries={data.binaries}
              selectedId={binary?.id}
              onSelect={setBinaryId}
              onImported={reload}
              locked={busy === true}
            />
          )}
          {common && step?.id === 'analyze' && (
            <SimpleStepPanel
              {...common}
              step="analyze"
              description="Ghidra analyzes the binary headlessly and exports functions, references, symbols, data types, assembly and decompiler output."
            />
          )}
          {common && step?.id === 'reconstruct' && <ReconstructPanel {...common} />}
          {common && step?.id === 'build' && (
            <SimpleStepPanel
              {...common}
              step="build"
              description="The generated C project is configured with CMake and built with Ninja. Compiler errors are mapped back to the responsible function."
            />
          )}
          {common && step?.id === 'validate' && <ValidatePanel {...common} />}
          {common && step?.id === 'download' && (
            <DownloadPanel project={project} binary={common.binary} />
          )}
        </div>
      </section>

      <div className="cluster cluster--between">
        <button
          className="btn"
          type="button"
          disabled={active === 0}
          onClick={() => setChosenStep(active - 1)}
        >
          Back
        </button>
        <button
          className="btn btn--primary"
          type="button"
          disabled={active >= reachable || active >= WIZARD_STEPS.length - 1}
          onClick={() => setChosenStep(active + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
