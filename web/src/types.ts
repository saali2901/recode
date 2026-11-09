export type Status = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type StepName = 'prepare' | 'analyze' | 'reconstruct' | 'build' | 'validate';

export interface StepState {
  status: Status;
  attempts: number;
  summary?: string;
  error?: string;
}

export interface TaskCounts {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
}

export interface BinarySummary {
  id: string;
  fileName: string;
  size: number;
  sha256: string;
  format: string;
  kind: string;
  architecture: string;
  bits: number;
  endianness: string;
  entryPoint: string | null;
  sectionCount: number;
  symbolCount: number;
  warnings: string[];
  steps: Record<StepName, StepState> | null;
  tasks: TaskCounts | null;
}

export interface JobInfo {
  id: string;
  step: 'analyze' | 'reconstruct' | 'build' | 'validate' | 'run';
  binaryId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  summary?: string;
  error?: string;
  hint?: string;
}

export interface ProjectDetail {
  name: string;
  binaries: BinarySummary[];
  references: string[];
  job: JobInfo | null;
}

export interface ProjectListItem {
  name: string;
  binaries: number;
  references: number;
  running: string | null;
  error?: string;
}

export interface TaskItem {
  id: string;
  kind: 'overview' | 'types' | 'function';
  title: string;
  status: Status;
  attempts: number;
  lastError: string | null;
}

export interface ValidationCheck {
  id: string;
  level: string;
  title: string;
  outcome: 'passed' | 'failed' | 'not-assessed';
  detail: string;
}

export interface ValidationReport {
  generatedAt: string;
  checks: ValidationCheck[];
  disclaimer: string;
}

export interface DoctorCheck {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  hint?: string;
}

export interface UploadResult {
  detection: string;
  binaries: Array<{
    id: string;
    fileName: string;
    created: boolean;
    format: string;
    architecture: string;
  }>;
  references: string[];
}

export interface ConfigResponse {
  effective: Record<string, unknown>;
  user: Record<string, unknown>;
  project: Record<string, unknown> | null;
}

export interface RawInfo {
  arch: string;
  endian: string;
  bits: string;
  base: string;
  entry: string;
}
