export type ValidationLevel =
  'syntactic' | 'compiled' | 'coverage' | 'functional' | 'fidelity' | 'ai-review';

export type CheckOutcome = 'passed' | 'failed' | 'not-assessed';

export interface ValidationCheckResult {
  id: string;
  level: ValidationLevel;
  title: string;
  outcome: CheckOutcome;
  detail: string;
}

export interface ValidationReport {
  generatedAt: string;
  checks: ValidationCheckResult[];
  /** Plain-language limits of what the checks prove. */
  disclaimer: string;
}
