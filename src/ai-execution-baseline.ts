/** Configuration observations from the supplied workflow excerpts, not execution telemetry. */
export const STAGE_IDS = [
  'plan',
  'bounded-implement',
  'implement',
  'fix',
  'semantic-review',
  'learn',
  'product-evaluation',
] as const;

export type StageId = (typeof STAGE_IDS)[number];

export interface ExecutionBaselineEntry {
  readonly stageId: StageId;
  readonly workflow: string;
  readonly model: { readonly status: 'unspecified' };
  readonly effort:
    | { readonly status: 'confirmed'; readonly value: 'low' | 'medium' }
    | { readonly status: 'unknown' };
  readonly actualModel: { readonly status: 'unknown' };
}

export const BASELINE_SOURCE_SHA = '7d8a4fd53647e2498a6c38e0442ab61c849601a8';

export const AI_EXECUTION_BASELINE: readonly ExecutionBaselineEntry[] = [
  { stageId: 'plan', workflow: '.github/workflows/plan.yml', model: { status: 'unspecified' }, effort: { status: 'confirmed', value: 'medium' }, actualModel: { status: 'unknown' } },
  { stageId: 'bounded-implement', workflow: '.github/workflows/plan-implement-worker.yml', model: { status: 'unspecified' }, effort: { status: 'confirmed', value: 'low' }, actualModel: { status: 'unknown' } },
  { stageId: 'implement', workflow: '.github/workflows/implement.yml', model: { status: 'unspecified' }, effort: { status: 'confirmed', value: 'medium' }, actualModel: { status: 'unknown' } },
  { stageId: 'fix', workflow: '.github/workflows/fix-worker.yml', model: { status: 'unspecified' }, effort: { status: 'unknown' }, actualModel: { status: 'unknown' } },
  { stageId: 'semantic-review', workflow: '.github/workflows/semantic-review.yml', model: { status: 'unspecified' }, effort: { status: 'confirmed', value: 'medium' }, actualModel: { status: 'unknown' } },
  { stageId: 'learn', workflow: '.github/workflows/learn.yml', model: { status: 'unspecified' }, effort: { status: 'confirmed', value: 'medium' }, actualModel: { status: 'unknown' } },
  { stageId: 'product-evaluation', workflow: '.github/workflows/product-evaluation.yml', model: { status: 'unspecified' }, effort: { status: 'confirmed', value: 'medium' }, actualModel: { status: 'unknown' } },
];
