export const AI_USAGE_STAGES = Object.freeze([
  'PLAN',
  'IMPLEMENT',
  'SEMANTIC_REVIEW',
  'LEARN',
  'PRODUCT_EVALUATION',
] as const);

export type AiUsageStage = (typeof AI_USAGE_STAGES)[number];

export interface StageExecutionObservation {
  readonly stage: AiUsageStage;
  readonly sourceRef: string;
}

export interface AiUsageRecordInput {
  readonly cycleRef: string;
  readonly observations: readonly StageExecutionObservation[];
}

export interface StageUsageRecord {
  readonly stage: AiUsageStage;
  readonly sourceRefs: readonly string[];
  readonly observedStageInvocationCount: number | null;
  readonly providerCallCount: null;
  readonly model: null;
  readonly tokenUsage: null;
  readonly monetaryCost: null;
}

export interface AiUsageRecord {
  readonly schemaVersion: 1;
  readonly cycleRef: string;
  readonly stages: readonly StageUsageRecord[];
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function requireKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length ||
    !expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new TypeError(`${label} must contain exactly: ${expected.join(', ')}`);
  }
}

function requireReference(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-blank string`);
  }
  return value;
}

function requireStage(value: unknown, label: string): AiUsageStage {
  for (const stage of AI_USAGE_STAGES) {
    if (value === stage) return stage;
  }
  throw new TypeError(`${label} must be a supported AI stage`);
}

/**
 * Aggregates observations supplied by a trusted caller. Validation does not
 * authenticate evidence or establish observation completeness.
 */
export function aggregateAiUsageRecord(input: unknown): AiUsageRecord {
  const record = requireObject(input, 'input');
  requireKeys(record, ['cycleRef', 'observations'], 'input');
  const cycleRef = requireReference(record.cycleRef, 'cycleRef');
  const observations: unknown = record.observations;
  if (!Array.isArray(observations)) {
    throw new TypeError('observations must be an array');
  }

  const sources = new Map<AiUsageStage, Set<string>>();
  for (const stage of AI_USAGE_STAGES) sources.set(stage, new Set<string>());

  for (const [index, value] of observations.entries()) {
    const label = `observations[${index}]`;
    const observation = requireObject(value, label);
    requireKeys(observation, ['stage', 'sourceRef'], label);
    const stage = requireStage(observation.stage, `${label}.stage`);
    const sourceRef = requireReference(observation.sourceRef, `${label}.sourceRef`);
    sources.get(stage)!.add(sourceRef);
  }

  const stages: StageUsageRecord[] = AI_USAGE_STAGES.map((stage) => {
    // Relational string comparison uses UTF-16 code units, independent of locale.
    const sourceRefs = [...sources.get(stage)!].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return {
      stage,
      sourceRefs,
      observedStageInvocationCount: sourceRefs.length === 0 ? null : sourceRefs.length,
      providerCallCount: null,
      model: null,
      tokenUsage: null,
      monetaryCost: null,
    };
  });

  return { schemaVersion: 1, cycleRef, stages };
}

/** Serializes validated input using fixed field, stage and sourceRef ordering. */
export function serializeAiUsageRecord(input: unknown): string {
  return JSON.stringify(aggregateAiUsageRecord(input));
}
