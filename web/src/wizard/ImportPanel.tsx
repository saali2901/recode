import { useRef, useState, type DragEvent } from 'react';
import { ApiError, uploadFile } from '../api';
import { formatBytes } from '../format';
import type { BinarySummary, RawInfo } from '../types';

type Entry =
  | { id: number; file: File; state: 'uploading'; progress: number }
  | { id: number; file: File; state: 'done'; message: string }
  | { id: number; file: File; state: 'error'; message: string; hint?: string }
  | { id: number; file: File; state: 'needs-raw'; message: string };

const ARCHITECTURES = [
  'x86',
  'x86_64',
  'arm',
  'aarch64',
  'mips',
  'mips64',
  'ppc',
  'ppc64',
  'riscv32',
  'riscv64',
];

const EMPTY_RAW: RawInfo = { arch: 'x86_64', endian: 'little', bits: '64', base: '', entry: '' };

function RawForm({ onSubmit, disabled }: { onSubmit: (raw: RawInfo) => void; disabled: boolean }) {
  const [raw, setRaw] = useState<RawInfo>(EMPTY_RAW);
  const set = (key: keyof RawInfo) => (event: { target: { value: string } }) =>
    setRaw({ ...raw, [key]: event.target.value });
  return (
    <form
      className="raw-form stack gap-3"
      aria-label="Raw binary information"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(raw);
      }}
    >
      <p className="text-sm">
        This file has no recognizable header, so ReCode cannot know how to read it. Tell it what the
        file is. Nothing is guessed.
      </p>
      <div className="grid grid--3 gap-3">
        <div className="field">
          <label className="field__label" htmlFor="raw-arch">
            Architecture
          </label>
          <select id="raw-arch" className="select" value={raw.arch} onChange={set('arch')}>
            {ARCHITECTURES.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field__label" htmlFor="raw-endian">
            Endianness
          </label>
          <select id="raw-endian" className="select" value={raw.endian} onChange={set('endian')}>
            <option>little</option>
            <option>big</option>
          </select>
        </div>
        <div className="field">
          <label className="field__label" htmlFor="raw-bits">
            Bits
          </label>
          <select id="raw-bits" className="select" value={raw.bits} onChange={set('bits')}>
            <option>16</option>
            <option>32</option>
            <option>64</option>
          </select>
        </div>
        <div className="field field--required">
          <label className="field__label" htmlFor="raw-base">
            Base address (hex)
          </label>
          <input
            id="raw-base"
            className="input"
            placeholder="0x400000"
            value={raw.base}
            onChange={set('base')}
            required
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="raw-entry">
            Entry point (hex, optional)
          </label>
          <input
            id="raw-entry"
            className="input"
            placeholder="0x400000"
            value={raw.entry}
            onChange={set('entry')}
          />
        </div>
      </div>
      <div>
        <button
          className="btn btn--primary"
          type="submit"
          disabled={disabled || raw.base.trim() === ''}
        >
          Import as raw binary
        </button>
      </div>
    </form>
  );
}

export function ImportPanel({
  project,
  binaries,
  selectedId,
  onSelect,
  onImported,
  locked,
}: {
  project: string;
  binaries: BinarySummary[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  onImported: () => void;
  locked: boolean;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [dragging, setDragging] = useState(false);
  const nextId = useRef(1);
  const input = useRef<HTMLInputElement>(null);

  const update = (id: number, entry: Entry): void =>
    setEntries((all) => all.map((e) => (e.id === id ? entry : e)));

  async function send(id: number, file: File, raw: RawInfo | null): Promise<void> {
    update(id, { id, file, state: 'uploading', progress: 0 });
    try {
      const result = await uploadFile(project, file, raw, (progress) =>
        update(id, { id, file, state: 'uploading', progress }),
      );
      const summary =
        result.binaries.length > 0
          ? result.binaries
              .map(
                (b) =>
                  `${b.created ? 'Imported' : 'Already imported'}: ${b.fileName} (${b.format}, ${b.architecture})`,
              )
              .join('; ')
          : result.references.length > 0
            ? 'Stored as reference material'
            : result.detection;
      update(id, { id, file, state: 'done', message: summary });
      onImported();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'RAW_INFO_REQUIRED') {
        update(id, { id, file, state: 'needs-raw', message: e.message });
      } else {
        update(id, {
          id,
          file,
          state: 'error',
          message: e instanceof Error ? e.message : String(e),
          ...(e instanceof ApiError && e.hint ? { hint: e.hint } : {}),
        });
      }
    }
  }

  function add(files: FileList | File[]): void {
    for (const file of Array.from(files)) {
      const id = nextId.current++;
      setEntries((all) => [...all, { id, file, state: 'uploading', progress: 0 }]);
      void send(id, file, null);
    }
  }

  function onDrop(event: DragEvent): void {
    event.preventDefault();
    setDragging(false);
    if (!locked) add(event.dataTransfer.files);
  }

  return (
    <div className="stack gap-6">
      <div
        className={`dropzone${dragging ? ' dropzone--active' : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        data-testid="dropzone"
      >
        <p className="dropzone__title">Drop binaries here</p>
        <p className="text-sm text-muted">
          ELF, PE (EXE/DLL), Mach-O, object files, raw .bin, ZIP archives — or reference files (C,
          headers, JSON, YAML, TXT, MAP)
        </p>
        <button
          className="btn"
          type="button"
          disabled={locked}
          onClick={() => input.current?.click()}
        >
          Choose files…
        </button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          data-testid="file-input"
          onChange={(event) => {
            if (event.target.files) add(event.target.files);
            event.target.value = '';
          }}
        />
        {locked && <p className="text-sm text-muted">A job is running; uploads are paused.</p>}
      </div>

      {entries.length > 0 && (
        <ul className="stack gap-3 upload-list" aria-label="Uploads">
          {entries.map((entry) => (
            <li key={entry.id} className="card card--compact card--subtle">
              <div className="card__body stack gap-2">
                <div className="cluster cluster--between">
                  <span>
                    <strong>{entry.file.name}</strong>{' '}
                    <span className="text-sm text-muted">{formatBytes(entry.file.size)}</span>
                  </span>
                  {entry.state === 'done' && <span className="tag tag--success">imported</span>}
                  {entry.state === 'error' && <span className="tag tag--danger">failed</span>}
                  {entry.state === 'needs-raw' && (
                    <span className="tag tag--warning">needs information</span>
                  )}
                </div>
                {entry.state === 'uploading' && (
                  <progress
                    className="progress"
                    value={Math.round(entry.progress * 100)}
                    max={100}
                    aria-label={`Uploading ${entry.file.name}`}
                  />
                )}
                {entry.state === 'done' && <p className="text-sm">{entry.message}</p>}
                {entry.state === 'error' && (
                  <div className="alert alert--danger" role="alert">
                    <div className="alert__content">
                      <p>{entry.message}</p>
                      {entry.hint && <pre className="hint-block">{entry.hint}</pre>}
                    </div>
                  </div>
                )}
                {entry.state === 'needs-raw' && (
                  <RawForm
                    disabled={locked}
                    onSubmit={(raw) => void send(entry.id, entry.file, raw)}
                  />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {binaries.length > 0 && (
        <div className="stack gap-3">
          <h3>Binaries in this project</h3>
          <div className="table-wrap">
            <table className="table--compact">
              <caption className="sr-only">Imported binaries; select the one to work on</caption>
              <thead>
                <tr>
                  <th>Use</th>
                  <th>File</th>
                  <th>Format</th>
                  <th>Architecture</th>
                  <th>Entry point</th>
                  <th className="num">Symbols</th>
                </tr>
              </thead>
              <tbody>
                {binaries.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <input
                        type="radio"
                        name="binary"
                        aria-label={`Use ${b.fileName}`}
                        checked={b.id === selectedId}
                        onChange={() => onSelect(b.id)}
                      />
                    </td>
                    <td>
                      {b.fileName} <span className="text-sm text-muted">{formatBytes(b.size)}</span>
                      {b.warnings.map((w) => (
                        <div key={w} className="text-sm text-muted">
                          {w}
                        </div>
                      ))}
                    </td>
                    <td>
                      {b.format} ({b.kind})
                    </td>
                    <td>
                      {b.architecture}, {b.bits}-bit, {b.endianness}-endian
                    </td>
                    <td>{b.entryPoint ?? '—'}</td>
                    <td className="num">{b.symbolCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
