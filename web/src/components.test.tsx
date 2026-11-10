// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as apiModule from './api';
import { ApiError, initToken, urlWithToken } from './api';
import { LogView } from './components/JobPanel';
import { ThemeSwitcher } from './components/ThemeSwitcher';
import { initialStream, type LogLine } from './hooks';
import { ProjectsPage } from './pages/ProjectsPage';
import { ImportPanel } from './wizard/ImportPanel';
import { ReconstructPanel, TaskList } from './wizard/StepPanels';
import type { BinarySummary, TaskItem } from './types';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});

describe('token handling', () => {
  it('moves the token from the URL into the tab session and removes it from the address bar', () => {
    window.history.replaceState(null, '', '/?token=abc123&x=1#/settings');
    expect(initToken()).toBe('abc123');
    expect(window.location.search).toBe('?x=1');
    expect(window.location.hash).toBe('#/settings');
    expect(urlWithToken('/api/x')).toBe('/api/x?token=abc123');
    expect(urlWithToken('/api/x?a=1')).toBe('/api/x?a=1&token=abc123');
  });
});

describe('ThemeSwitcher', () => {
  it('offers all themes, applies and remembers the choice', async () => {
    render(<ThemeSwitcher />);
    const select = screen.getByLabelText('Theme') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual([
      'default',
      'contrast',
      'coral',
      'forest',
      'harbor',
      'midnight',
      'mono',
      'paper',
    ]);
    await userEvent.selectOptions(select, 'midnight');
    expect(document.documentElement.dataset['theme']).toBe('midnight');
    expect(localStorage.getItem('recode.theme')).toBe('midnight');
  });
});

describe('LogView', () => {
  const lines: LogLine[] = [
    { id: 1, kind: 'tool', source: 'analyze-x.log', text: 'ghidra line' },
    { id: 2, kind: 'tool', source: 'claude-1.log', text: 'claude line' },
    { id: 3, kind: 'event', source: 'recode', text: 'event line' },
  ];
  it('filters by source', async () => {
    render(<LogView lines={lines} />);
    const log = screen.getByLabelText('Live log');
    expect(log.textContent).toContain('ghidra line');
    expect(log.textContent).toContain('claude line');
    await userEvent.click(screen.getByRole('button', { name: 'Claude' }));
    expect(log.textContent).toBe('claude line\n');
    await userEvent.click(screen.getByRole('button', { name: 'Events' }));
    expect(log.textContent).toBe('event line\n');
  });
  it('says so when there is no output', () => {
    render(<LogView lines={[]} />);
    expect(screen.getByLabelText('Live log').textContent).toBe('(no output yet)');
  });
});

describe('TaskList', () => {
  it('shows status, attempts and the last error of unfinished tasks', () => {
    const tasks: TaskItem[] = [
      {
        id: 'a',
        kind: 'function',
        title: 'add_ints @ 0x1',
        status: 'completed',
        attempts: 1,
        lastError: null,
      },
      {
        id: 'b',
        kind: 'function',
        title: 'multiply @ 0x2',
        status: 'failed',
        attempts: 3,
        lastError: 'address mismatch',
      },
    ];
    render(<TaskList tasks={tasks} />);
    expect(screen.getByText('add_ints @ 0x1')).toBeTruthy();
    expect(screen.getByText('address mismatch')).toBeTruthy();
    expect(screen.getByText('completed')).toBeTruthy();
    expect(screen.getByText('failed')).toBeTruthy();
  });
});

describe('ProjectsPage', () => {
  it('lists projects and links to them', async () => {
    vi.spyOn(apiModule.api, 'get').mockResolvedValue({
      workspace: '/ws',
      projects: [
        { name: 'alpha', binaries: 2, references: 1, running: null },
        { name: 'beta', binaries: 0, references: 0, running: 'analyze' },
      ],
    });
    render(<ProjectsPage />);
    expect(await screen.findByText('alpha')).toBeTruthy();
    expect(screen.getByText('2 binaries · 1 reference file')).toBeTruthy();
    expect(screen.getByText('analyze')).toBeTruthy();
    expect(screen.getByText('alpha').closest('a')?.getAttribute('href')).toBe('#/projects/alpha');
    expect(screen.getByText('/ws')).toBeTruthy();
  });

  it('shows an empty state and creates a project', async () => {
    vi.spyOn(apiModule.api, 'get').mockResolvedValue({ workspace: '/ws', projects: [] });
    const post = vi.spyOn(apiModule.api, 'post').mockResolvedValue({});
    render(<ProjectsPage />);
    expect(await screen.findByText('No projects yet')).toBeTruthy();
    const create = screen.getByRole('button', { name: 'Create project' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('New project'), 'demo');
    await userEvent.click(create);
    expect(post).toHaveBeenCalledWith('/api/projects', { name: 'demo' });
    await waitFor(() => expect(window.location.hash).toBe('#/projects/demo'));
  });

  it('shows server errors from creating a project', async () => {
    vi.spyOn(apiModule.api, 'get').mockResolvedValue({ workspace: '/ws', projects: [] });
    vi.spyOn(apiModule.api, 'post').mockRejectedValue(
      new ApiError(400, 'INVALID_INPUT', 'Invalid project name "x y".', 'Use letters'),
    );
    render(<ProjectsPage />);
    await userEvent.type(await screen.findByLabelText('New project'), 'x y');
    await userEvent.click(screen.getByRole('button', { name: 'Create project' }));
    expect(await screen.findByText('Invalid project name "x y".')).toBeTruthy();
    expect(screen.getByText('Use letters')).toBeTruthy();
  });
});

describe('ImportPanel', () => {
  const props = {
    project: 'p',
    binaries: [] as BinarySummary[],
    selectedId: undefined,
    onSelect: () => undefined,
    locked: false,
  };

  it('uploads chosen files and reports the result', async () => {
    const upload = vi.spyOn(apiModule, 'uploadFile').mockResolvedValue({
      detection: 'ELF',
      binaries: [
        { id: 'a-1', fileName: 'a.out', created: true, format: 'elf', architecture: 'x86_64' },
      ],
      references: [],
    });
    const onImported = vi.fn();
    render(<ImportPanel {...props} onImported={onImported} />);
    const file = new File([new Uint8Array(8)], 'a.out');
    fireEvent.change(screen.getByTestId('file-input'), { target: { files: [file] } });
    expect(await screen.findByText(/Imported: a.out \(elf, x86_64\)/)).toBeTruthy();
    expect(upload).toHaveBeenCalledWith('p', file, null, expect.any(Function));
    expect(onImported).toHaveBeenCalled();
  });

  it('accepts dropped files and ignores drops while a job runs', async () => {
    const upload = vi
      .spyOn(apiModule, 'uploadFile')
      .mockResolvedValue({ detection: 'Reference', binaries: [], references: ['reference/n.txt'] });
    const { rerender } = render(<ImportPanel {...props} onImported={() => undefined} />);
    const file = new File(['x'], 'n.txt');
    fireEvent.drop(screen.getByTestId('dropzone'), { dataTransfer: { files: [file] } });
    expect(await screen.findByText('Stored as reference material')).toBeTruthy();
    rerender(<ImportPanel {...props} locked onImported={() => undefined} />);
    fireEvent.drop(screen.getByTestId('dropzone'), {
      dataTransfer: { files: [new File(['y'], 'm.txt')] },
    });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(
      (screen.getByRole('button', { name: 'Choose files…' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('asks for raw binary details and re-sends the same file with them', async () => {
    const upload = vi
      .spyOn(apiModule, 'uploadFile')
      .mockRejectedValueOnce(new ApiError(409, 'RAW_INFO_REQUIRED', 'No recognizable header.'))
      .mockResolvedValueOnce({
        detection: 'raw',
        binaries: [
          { id: 'fw-1', fileName: 'fw.bin', created: true, format: 'raw', architecture: 'arm' },
        ],
        references: [],
      });
    render(<ImportPanel {...props} onImported={() => undefined} />);
    const file = new File([new Uint8Array(4)], 'fw.bin');
    fireEvent.change(screen.getByTestId('file-input'), { target: { files: [file] } });
    const form = await screen.findByRole('form', { name: 'Raw binary information' });
    expect(form).toBeTruthy();
    const submit = screen.getByRole('button', {
      name: 'Import as raw binary',
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true); // base address is required
    await userEvent.selectOptions(screen.getByLabelText('Architecture'), 'arm');
    await userEvent.selectOptions(screen.getByLabelText('Bits'), '32');
    await userEvent.type(screen.getByLabelText('Base address (hex)'), '0x8000');
    await userEvent.click(submit);
    await screen.findByText(/Imported: fw.bin \(raw, arm\)/);
    expect(upload).toHaveBeenLastCalledWith(
      'p',
      file,
      { arch: 'arm', endian: 'little', bits: '32', base: '0x8000', entry: '' },
      expect.any(Function),
    );
  });

  it('shows upload errors with their hint', async () => {
    vi.spyOn(apiModule, 'uploadFile').mockRejectedValue(
      new ApiError(400, 'ARCHIVE', 'Archive entry has an unsafe path', 'Do not trust this file'),
    );
    render(<ImportPanel {...props} onImported={() => undefined} />);
    fireEvent.change(screen.getByTestId('file-input'), {
      target: { files: [new File(['x'], 'evil.zip')] },
    });
    expect(await screen.findByText('Archive entry has an unsafe path')).toBeTruthy();
    expect(screen.getByText('Do not trust this file')).toBeTruthy();
  });

  it('lets the user pick one of several binaries', async () => {
    const binary = (id: string, name: string): BinarySummary => ({
      id,
      fileName: name,
      size: 2048,
      sha256: '',
      format: 'elf',
      kind: 'executable',
      architecture: 'x86_64',
      bits: 64,
      endianness: 'little',
      entryPoint: '0x401000',
      sectionCount: 3,
      symbolCount: 7,
      warnings: [],
      steps: null,
      tasks: null,
    });
    const onSelect = vi.fn();
    render(
      <ImportPanel
        {...props}
        binaries={[binary('a', 'one'), binary('b', 'two')]}
        selectedId="a"
        onSelect={onSelect}
        onImported={() => undefined}
      />,
    );
    expect((screen.getByLabelText('Use one') as HTMLInputElement).checked).toBe(true);
    await userEvent.click(screen.getByLabelText('Use two'));
    expect(onSelect).toHaveBeenCalledWith('b');
  });
});

describe('ReconstructPanel', () => {
  beforeEach(() => {
    vi.spyOn(apiModule.api, 'get').mockImplementation(async (path: string) => {
      if (path.endsWith('/perf')) throw new ApiError(404, 'NOT_FOUND', 'No run yet.');
      return TASKS;
    });
  });
  const TASKS = {
    tasks: [
      {
        id: 'overview',
        kind: 'overview',
        title: 'Binary overview',
        status: 'completed',
        attempts: 1,
        lastError: null,
      },
      {
        id: 'types',
        kind: 'types',
        title: 'Shared data structures',
        status: 'completed',
        attempts: 1,
        lastError: null,
      },
      {
        id: 'fn_1',
        kind: 'function',
        title: 'add_ints @ 0x1',
        status: 'running',
        attempts: 1,
        lastError: null,
      },
      {
        id: 'fn_2',
        kind: 'function',
        title: 'main @ 0x2',
        status: 'pending',
        attempts: 0,
        lastError: null,
      },
    ],
  };
  const binary = {
    id: 'b',
    steps: {
      prepare: { status: 'completed', attempts: 0 },
      analyze: { status: 'completed', attempts: 1 },
      reconstruct: { status: 'running', attempts: 1 },
      build: { status: 'pending', attempts: 0 },
      validate: { status: 'pending', attempts: 0 },
    },
  } as unknown as BinarySummary;

  it('shows progress, agent activity and a cancel button while running', async () => {
    const stream = {
      ...initialStream,
      connected: true,
      job: {
        id: 'j',
        step: 'reconstruct' as const,
        binaryId: 'b',
        status: 'running' as const,
        startedAt: new Date(Date.now() - 60_000).toISOString(),
      },
      activity: [{ id: 1, agent: 'recode-c-reconstructor', summary: 'Reconstruct fn_1' }],
    };
    const post = vi.spyOn(apiModule.api, 'post').mockResolvedValue({ cancelled: true });
    render(
      <ReconstructPanel
        project="p"
        binary={binary}
        stream={stream}
        busy
        onStarted={() => undefined}
      />,
    );
    expect(await screen.findByText('2 of 4 tasks completed')).toBeTruthy();
    const bar = screen.getByLabelText('Reconstruction progress') as HTMLProgressElement;
    expect(bar.value).toBe(2);
    expect(bar.max).toBe(4);
    expect(screen.getAllByText('recode-c-reconstructor').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(post).toHaveBeenCalledWith('/api/projects/p/jobs/cancel');
  });

  it('starts a run with the force option', async () => {
    const post = vi.spyOn(apiModule.api, 'post').mockResolvedValue({});
    const idle = {
      ...binary,
      steps: { ...binary.steps, reconstruct: { status: 'failed', attempts: 1 } },
    } as unknown as BinarySummary;
    render(
      <ReconstructPanel
        project="p"
        binary={idle}
        stream={initialStream}
        busy={false}
        onStarted={() => undefined}
      />,
    );
    await userEvent.click(await screen.findByLabelText('Force re-run'));
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(post).toHaveBeenCalledWith('/api/projects/p/jobs', {
      step: 'reconstruct',
      binaryId: 'b',
      force: true,
      options: {},
    });
  });

  it('sends per-run scheduler options with the job', async () => {
    const post = vi.spyOn(apiModule.api, 'post').mockResolvedValue({});
    render(
      <ReconstructPanel
        project="p"
        binary={binary}
        stream={initialStream}
        busy={false}
        onStarted={() => undefined}
      />,
    );
    await userEvent.type(await screen.findByLabelText('Concurrent sessions (maximum)'), '3');
    await userEvent.selectOptions(screen.getByLabelText('Function dependencies'), 'complete');
    await userEvent.click(screen.getByLabelText('Ignore the result cache in this run'));
    await userEvent.click(screen.getByRole('button', { name: /^(Start|Resume|Re-?run)/ }));
    expect(post).toHaveBeenCalledWith('/api/projects/p/jobs', {
      step: 'reconstruct',
      binaryId: 'b',
      force: false,
      options: { sessions: 3, dependencies: 'complete', noCache: true },
    });
  });

  it('shows the tier, escalations and cache use of every task', () => {
    render(
      <TaskList
        tasks={[
          {
            id: 'fn_1',
            kind: 'function',
            title: 'a @ 0x1',
            status: 'completed',
            attempts: 2,
            lastError: null,
            tier: 'standard',
            escalations: 1,
          },
          {
            id: 'fn_2',
            kind: 'function',
            title: 'b @ 0x2',
            status: 'completed',
            attempts: 1,
            lastError: null,
            tier: 'fast',
            fromCache: true,
            openIssues: ['loops-dropped: x'],
          },
        ]}
      />,
    );
    expect(screen.getByText('standard')).toBeTruthy();
    expect(screen.getByText(/↑1/)).toBeTruthy();
    expect(screen.getByText(/\(cache\)/)).toBeTruthy();
    expect(screen.getByText(/Open findings: loops-dropped: x/)).toBeTruthy();
  });

  it('shows the metrics of the last run when the server has them', async () => {
    vi.spyOn(apiModule.api, 'get').mockImplementation(async (path: string) => {
      if (path.endsWith('/perf')) return PERF;
      return TASKS;
    });
    render(
      <ReconstructPanel
        project="p"
        binary={binary}
        stream={initialStream}
        busy={false}
        onStarted={() => undefined}
      />,
    );
    expect(await screen.findByText('Run r1', { exact: false })).toBeTruthy();
    expect(screen.getByText('4 / 1')).toBeTruthy(); // max / average sessions
    expect(screen.getByText('75 %')).toBeTruthy(); // cache hit rate
    expect(screen.getByText('opus')).toBeTruthy();
  });
});

const PERF = {
  runId: 'r1',
  mode: 'adaptive',
  counters: {},
  phases: {},
  analysis: null,
  summary: {
    wallSeconds: 12,
    modelCalls: 5,
    inputTokens: 1000,
    outputTokens: 200,
    costUsd: 0,
    perModel: [
      {
        tier: 'advanced',
        model: 'opus',
        calls: 2,
        seconds: 8,
        inputTokens: 600,
        outputTokens: 120,
        failures: 0,
      },
    ],
    meanQueueWaitSeconds: 0.5,
    cacheHitRate: 0.75,
    workersMax: 4,
    workersAverage: 1,
    retries: 0,
    escalations: 2,
    accepted: 9,
    failed: 1,
    compileErrors: 3,
  },
};

describe('JobStatus errors', () => {
  const failed = (patch: object) => ({
    id: 'j',
    step: 'reconstruct' as const,
    binaryId: 'b',
    status: 'failed' as const,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    error: 'boom',
    ...patch,
  });

  it('offers a trust button for untrusted folders and calls the API', async () => {
    const post = vi.spyOn(apiModule.api, 'post').mockResolvedValue({});
    const { JobStatus } = await import('./components/JobPanel');
    render(
      <JobStatus
        job={failed({
          errorCode: 'UNTRUSTED',
          error: 'Claude Code does not trust this project folder',
        })}
        label="reconstruct"
        project="demo"
      />,
    );
    expect(
      screen.getByText('Claude Code does not trust this project folder', {
        selector: '.alert__title',
      }),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Trust this project' }));
    expect(post).toHaveBeenCalledWith('/api/projects/demo/trust');
    expect(await screen.findByText('Trusted. Start the step again.')).toBeTruthy();
  });

  it('shows the usage limit as a warning with a clear title, without a trust button', async () => {
    const { JobStatus } = await import('./components/JobPanel');
    render(
      <JobStatus
        job={failed({
          errorCode: 'RATE_LIMIT',
          error: 'Claude Code usage limit reached: resets 1:50pm',
        })}
        label="reconstruct"
        project="demo"
      />,
    );
    expect(screen.getByText('Claude usage limit reached')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Trust this project' })).toBeNull();
    expect(document.querySelector('.alert--warning')).toBeTruthy();
  });
});
