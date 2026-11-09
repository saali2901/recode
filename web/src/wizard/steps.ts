import type { BinarySummary, ProjectDetail, StepName } from '../types';

export const WIZARD_STEPS = [
  { id: 'import', label: 'Import', hint: 'Add binaries' },
  { id: 'analyze', label: 'Analyze', hint: 'Ghidra' },
  { id: 'reconstruct', label: 'Reconstruct', hint: 'Claude Code agents' },
  { id: 'build', label: 'Build', hint: 'CMake & Ninja' },
  { id: 'validate', label: 'Validate', hint: 'Checks' },
  { id: 'download', label: 'Download', hint: 'C project' },
] as const;

export type WizardStepId = (typeof WIZARD_STEPS)[number]['id'];

function stepDone(binary: BinarySummary | undefined, step: StepName): boolean {
  return binary?.steps?.[step]?.status === 'completed';
}

/** Index of the first step that still has to be done; steps beyond it are not reachable yet. */
export function firstOpenStep(
  detail: ProjectDetail | undefined,
  binary: BinarySummary | undefined,
): number {
  if (!detail || detail.binaries.length === 0 || !binary) return 0;
  const order: StepName[] = ['analyze', 'reconstruct', 'build', 'validate'];
  const index = order.findIndex((step) => !stepDone(binary, step));
  return index === -1 ? WIZARD_STEPS.length - 1 : index + 1;
}
