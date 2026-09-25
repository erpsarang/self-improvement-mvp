export type AiUsageStage =
  | 'PLAN'
  | 'IMPLEMENT'
  | 'SEMANTIC_REVIEW'
  | 'LEARN'
  | 'PRODUCT_EVALUATION';

export interface InvocationEvidenceInput {
  readonly owner: string;
  readonly repo: string;
  readonly runId: string;
  readonly jobId: string;
  readonly stage: AiUsageStage;
  readonly ordinal: number;
  readonly boundaryConfirmed: boolean;
  /**
   * Trusted caller-selected Codex start-banner fragment for this invocation.
   * Must exclude workflow settings, prompts, and generated output.
   */
  readonly bannerLog: string;
  /**
   * Trusted caller-selected Codex termination-summary fragment belonging to
   * the same invocation. Must exclude prompts and generated output.
   */
  readonly completionLog: string;
}

export interface InvocationEvidence {
  readonly owner: string;
  readonly repo: string;
  readonly runId: string;
  readonly jobId: string;
  readonly stage: AiUsageStage;
  readonly ordinal: number;
  readonly sourceRef: string;
  readonly providerCallCount: 1 | null;
  readonly model: string | null;
  readonly tokenUsage: number | null;
  readonly monetaryCost: null;
}

const stages: readonly AiUsageStage[] = [
  'PLAN', 'IMPLEMENT', 'SEMANTIC_REVIEW', 'LEARN', 'PRODUCT_EVALUATION',
];

function lines(fragment: string): string[] {
  // Remove only an optional Actions timestamp, never arbitrary log prefixes.
  return fragment.split(/\r?\n/).map(line => line.replace(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z[ \t]+/,
    '',
  ).trim());
}

function parseModel(fragment: string): string | null {
  const markers = lines(fragment).filter(line => /^model\s*:/.test(line));
  // Repeated markers are ambiguous even if their values happen to agree.
  if (markers.length !== 1) return null;
  const match = /^model:[ \t]*([A-Za-z0-9][A-Za-z0-9._/-]*)$/.exec(markers[0]!);
  return match?.[1] ?? null;
}

function parseTokens(fragment: string): number | null {
  const entries = lines(fragment);
  const positions = entries.flatMap((line, index) =>
    /^tokens used\b/.test(line) ? [index] : [],
  );
  if (positions.length !== 1) return null;
  const index = positions[0]!;
  if (entries[index] !== 'tokens used') return null;
  const value = entries[index + 1];
  // Codex summary: marker on its own line, then a nonnegative integer.
  // Accept plain digits or correctly grouped thousands, without rounding.
  if (value === undefined || !/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(value)) {
    return null;
  }
  const parsed = Number(value.replace(/,/g, ''));
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Parse already isolated, trusted marker regions for one identified invocation.
 * This function does not establish log authenticity, discover invocation
 * boundaries, assign ordinals, select jobs, or serialize an ai-usage-record.
 * Passing an entire job log or an AI response violates the input contract.
 * Unknown identity/boundaries fail closed; unknown measurements remain null.
 */
export function parseInvocationEvidence(input: InvocationEvidenceInput): InvocationEvidence {
  if (
    input.boundaryConfirmed !== true ||
    !Number.isSafeInteger(input.ordinal) || input.ordinal < 1 ||
    !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(input.owner) ||
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(input.repo) ||
    !/^[1-9]\d*$/.test(input.runId) ||
    !/^[1-9]\d*$/.test(input.jobId) ||
    !stages.includes(input.stage)
  ) {
    throw new Error('Confirmed invocation boundary, ordinal, stage and source identity are required');
  }

  const model = parseModel(input.bannerLog);
  const tokenUsage = parseTokens(input.completionLog);
  return {
    owner: input.owner,
    repo: input.repo,
    runId: input.runId,
    jobId: input.jobId,
    stage: input.stage,
    ordinal: input.ordinal,
    sourceRef: `github-actions-job-log://${input.owner}/${input.repo}/run/${input.runId}/job/${input.jobId}#codex-${input.ordinal}`,
    providerCallCount: model !== null && tokenUsage !== null ? 1 : null,
    model,
    tokenUsage,
    monetaryCost: null,
  };
}
