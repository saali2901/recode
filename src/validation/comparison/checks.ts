import type { BuildReport } from '../build/builder.js';
import type { ValidationCheckResult } from '../interfaces.js';
import type { FunctionResult, ReviewResult } from '../../reconstruction/interfaces/results.js';

export interface CheckInput {
  build: BuildReport | undefined;
  functionResults: FunctionResult[];
  totalFunctions: number;
  reviews: ReviewResult[] | undefined;
  /** Whether a runnable reference and a comparator exist. Always false in the MVP. */
  hasExecutableComparator: boolean;
}

export type ValidationCheck = (input: CheckInput) => ValidationCheckResult[];

const syntaxAndCompile: ValidationCheck = ({ build }) => {
  if (!build) {
    const detail = 'No build has been run.';
    return [
      {
        id: 'syntax',
        level: 'syntactic',
        title: 'Syntactic correctness',
        outcome: 'not-assessed',
        detail,
      },
      {
        id: 'compile',
        level: 'compiled',
        title: 'Successful compilation',
        outcome: 'not-assessed',
        detail,
      },
    ];
  }
  const syntaxErrors = build.diagnostics.filter((d) => d.severity === 'error');
  return [
    {
      id: 'syntax',
      level: 'syntactic',
      title: 'Syntactic correctness',
      outcome:
        build.status === 'configure-failed'
          ? 'not-assessed'
          : syntaxErrors.length === 0
            ? 'passed'
            : 'failed',
      detail:
        build.status === 'configure-failed'
          ? 'CMake configuration failed before compiling.'
          : `${syntaxErrors.length} compiler error(s), ${build.warningCount} warning(s).`,
    },
    {
      id: 'compile',
      level: 'compiled',
      title: 'Successful compilation',
      outcome: build.status === 'success' ? 'passed' : 'failed',
      detail: `Build status: ${build.status}.`,
    },
  ];
};

const coverage: ValidationCheck = ({ functionResults, totalFunctions }) => {
  const reconstructed = functionResults.filter((r) => r.status === 'reconstructed');
  const byConfidence = (level: string): number =>
    reconstructed.filter((r) => r.confidence === level).length;
  return [
    {
      id: 'coverage',
      level: 'coverage',
      title: 'Reconstruction coverage',
      outcome: totalFunctions > 0 && reconstructed.length === totalFunctions ? 'passed' : 'failed',
      detail:
        `${reconstructed.length} of ${totalFunctions} functions reconstructed ` +
        `(certain: ${byConfidence('certain')}, probable: ${byConfidence('probable')}, speculative: ${byConfidence('speculative')}).`,
    },
  ];
};

const aiReview: ValidationCheck = ({ reviews }) => {
  if (!reviews) {
    return [
      {
        id: 'ai-review',
        level: 'ai-review',
        title: 'AI review of logic',
        outcome: 'not-assessed',
        detail:
          'Not requested. Run "recode validate --ai-review" (uses your Claude Code subscription).',
      },
    ];
  }
  const inconsistent = reviews.filter((r) => r.verdict === 'inconsistent').length;
  const concerns = reviews.filter((r) => r.verdict === 'concerns').length;
  return [
    {
      id: 'ai-review',
      level: 'ai-review',
      title: 'AI review of logic',
      outcome: inconsistent === 0 && concerns === 0 ? 'passed' : 'failed',
      detail: `${reviews.length} function(s) reviewed: ${inconsistent} inconsistent, ${concerns} with concerns. An AI review is an opinion, not a proof.`,
    },
  ];
};

const referenceChecks: ValidationCheck = ({ hasExecutableComparator }) => [
  {
    id: 'functional',
    level: 'functional',
    title: 'Functional equivalence',
    outcome: 'not-assessed',
    detail: hasExecutableComparator
      ? 'Comparator available.'
      : 'No comparison mechanism is implemented in the MVP; successful compilation does not imply equivalent behavior.',
  },
  {
    id: 'fidelity',
    level: 'fidelity',
    title: 'Fidelity to the original source',
    outcome: 'not-assessed',
    detail: 'The original source is unknown; fidelity cannot be measured.',
  },
];

/** Registered validation checks, evaluated in order. Add new checks here. */
export const VALIDATION_CHECKS: readonly ValidationCheck[] = [
  syntaxAndCompile,
  coverage,
  aiReview,
  referenceChecks,
];
