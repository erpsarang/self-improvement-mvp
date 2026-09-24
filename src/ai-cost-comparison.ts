import { STAGE_IDS, type StageId } from './ai-execution-baseline.js';

export const QUALITY_IDS = [
  'planQuality',
  'implementationSuccess',
  'deterministicCi',
  'semanticReview',
  'humanMergeJudgment',
] as const;

export type QualityId = (typeof QUALITY_IDS)[number];
export type QualityStatus = 'pass' | 'fail' | 'unknown';
export type MeasurementKind = 'expected' | 'measured';
export type RunSide = 'baseline' | 'candidate';

export interface StageMeasurement {
  stageId: StageId;
  callCount: number;
  costUnits: number | null;
}

/** Local, caller-supplied data. These are not external API usage fields. */
export interface RunInput {
  cycleId: string;
  workloadKey: string;
  policyLabel: string;
  measurementKind: MeasurementKind;
  currency: string;
  /** Number of integer cost units per one currency unit. */
  unitScale: number;
  stages: StageMeasurement[];
  quality: Record<QualityId, QualityStatus>;
}

export interface CostComparison {
  baselineCostUnits: number | null;
  candidateCostUnits: number | null;
  /** candidate - baseline */
  deltaCostUnits: number | null;
  /** (baseline - candidate) / baseline * 100; approximate floating-point percent. */
  savingsPercent: number | null;
  missingCostSides: RunSide[];
  deltaUnavailableReason: 'missing-cost' | null;
  savingsUnavailableReason: 'missing-cost' | 'zero-baseline-cost' | null;
}

export interface StageComparison extends CostComparison {
  stageId: StageId;
  baselineCallCount: number;
  candidateCallCount: number;
  deltaCallCount: number;
}

export interface QualityObservation {
  qualityId: QualityId;
  baseline: QualityStatus;
  candidate: QualityStatus;
}

export interface ComparisonResult {
  baseline: { cycleId: string; policyLabel: string };
  candidate: { cycleId: string; policyLabel: string };
  workloadKey: string;
  measurementKind: MeasurementKind;
  currency: string;
  unitScale: number;
  stages: StageComparison[];
  totals: CostComparison & {
    baselineCallCount: number;
    candidateCallCount: number;
    deltaCallCount: number;
    missingCosts: { side: RunSide; stageId: StageId }[];
  };
  quality: {
    comparisonStatus: 'sufficient' | 'insufficient';
    observations: QualityObservation[];
    regressions: QualityId[];
    candidateFailures: QualityId[];
    unknownItems: QualityId[];
  };
}

function invalid(path: string, message: string): never {
  throw new TypeError(`${path}: ${message}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid(path, 'expected an object');
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  if (Object.keys(value).length !== keys.length ||
      keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) {
    invalid(path, `expected exactly these fields: ${keys.join(', ')}`);
  }
}

function nonempty(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return invalid(path, 'expected a nonempty string');
  }
  return value;
}

function integer(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    return invalid(path, `expected a safe integer >= ${minimum}`);
  }
  return value;
}

function qualityStatus(value: unknown, path: string): QualityStatus {
  if (value !== 'pass' && value !== 'fail' && value !== 'unknown') {
    return invalid(path, 'expected pass, fail, or unknown');
  }
  return value;
}

function parseRun(value: unknown, path: string): RunInput {
  const input = record(value, path);
  exactKeys(input, ['cycleId', 'workloadKey', 'policyLabel', 'measurementKind', 'currency', 'unitScale', 'stages', 'quality'], path);
  const cycleId = nonempty(input.cycleId, `${path}.cycleId`);
  const workloadKey = nonempty(input.workloadKey, `${path}.workloadKey`);
  const policyLabel = nonempty(input.policyLabel, `${path}.policyLabel`);
  const currency = nonempty(input.currency, `${path}.currency`);
  const measurementKind = input.measurementKind;
  if (measurementKind !== 'expected' && measurementKind !== 'measured') {
    return invalid(`${path}.measurementKind`, 'expected expected or measured');
  }
  const unitScale = integer(input.unitScale, `${path}.unitScale`, 1);
  if (!Array.isArray(input.stages) || input.stages.length !== STAGE_IDS.length) {
    return invalid(`${path}.stages`, 'expected all seven stages exactly once');
  }
  const stages: StageMeasurement[] = [];
  const seen = new Set<StageId>();
  for (const raw of input.stages) {
    const entry = record(raw, `${path}.stages[]`);
    exactKeys(entry, ['stageId', 'callCount', 'costUnits'], `${path}.stages[]`);
    const stageId = STAGE_IDS.find(id => id === entry.stageId);
    if (stageId === undefined || seen.has(stageId)) {
      return invalid(`${path}.stages`, 'unknown or duplicate stageId');
    }
    seen.add(stageId);
    const callCount = integer(entry.callCount, `${path}.${stageId}.callCount`);
    const costUnits = entry.costUnits === null
      ? null
      : integer(entry.costUnits, `${path}.${stageId}.costUnits`);
    if (callCount === 0 && costUnits !== 0) {
      return invalid(`${path}.${stageId}`, 'an uncalled stage requires callCount=0 and costUnits=0');
    }
    stages.push({ stageId, callCount, costUnits });
  }
  const rawQuality = record(input.quality, `${path}.quality`);
  exactKeys(rawQuality, QUALITY_IDS, `${path}.quality`);
  const quality = {} as Record<QualityId, QualityStatus>;
  for (const id of QUALITY_IDS) {
    quality[id] = qualityStatus(rawQuality[id], `${path}.quality.${id}`);
  }
  return { cycleId, workloadKey, policyLabel, measurementKind, currency, unitScale, stages, quality };
}

function safeSum(values: readonly number[], path: string): number {
  let total = 0;
  for (const value of values) {
    if (value > Number.MAX_SAFE_INTEGER - total) {
      throw new RangeError(`${path}: aggregate exceeds safe integer range`);
    }
    total += value;
  }
  return total;
}

function totalCost(run: RunInput, side: RunSide): number | null {
  if (run.stages.some(stage => stage.costUnits === null)) return null;
  return safeSum(run.stages.map(stage => stage.costUnits as number), `${side}.totalCostUnits`);
}

function compareCost(baseline: number | null, candidate: number | null): CostComparison {
  const missingCostSides: RunSide[] = [];
  if (baseline === null) missingCostSides.push('baseline');
  if (candidate === null) missingCostSides.push('candidate');
  const missing = baseline === null || candidate === null;
  return {
    baselineCostUnits: baseline,
    candidateCostUnits: candidate,
    deltaCostUnits: missing ? null : candidate - baseline,
    savingsPercent: missing || baseline === 0 ? null : ((baseline - candidate) / baseline) * 100,
    missingCostSides,
    deltaUnavailableReason: missing ? 'missing-cost' : null,
    savingsUnavailableReason: missing ? 'missing-cost' : baseline === 0 ? 'zero-baseline-cost' : null,
  };
}

/** Validates both inputs before comparing. Never performs IO or authorizes execution/merge. */
export function compareRuns(baselineValue: unknown, candidateValue: unknown): ComparisonResult {
  const baseline = parseRun(baselineValue, 'baseline');
  const candidate = parseRun(candidateValue, 'candidate');
  for (const key of ['workloadKey', 'measurementKind', 'currency', 'unitScale'] as const) {
    if (baseline[key] !== candidate[key]) invalid(key, 'baseline and candidate must match');
  }
  const stages = STAGE_IDS.map(stageId => {
    // parseRun guarantees exactly one entry per stage.
    const before = baseline.stages.find(stage => stage.stageId === stageId)!;
    const after = candidate.stages.find(stage => stage.stageId === stageId)!;
    return {
      stageId,
      ...compareCost(before.costUnits, after.costUnits),
      baselineCallCount: before.callCount,
      candidateCallCount: after.callCount,
      deltaCallCount: after.callCount - before.callCount,
    };
  });
  const baselineCallCount = safeSum(baseline.stages.map(stage => stage.callCount), 'baseline.totalCallCount');
  const candidateCallCount = safeSum(candidate.stages.map(stage => stage.callCount), 'candidate.totalCallCount');
  const missingCosts: { side: RunSide; stageId: StageId }[] = [];
  for (const stage of stages) {
    for (const side of stage.missingCostSides) missingCosts.push({ side, stageId: stage.stageId });
  }
  const observations = QUALITY_IDS.map(qualityId => ({
    qualityId,
    baseline: baseline.quality[qualityId],
    candidate: candidate.quality[qualityId],
  }));
  const unknownItems = observations
    .filter(item => item.baseline === 'unknown' || item.candidate === 'unknown')
    .map(item => item.qualityId);
  return {
    baseline: { cycleId: baseline.cycleId, policyLabel: baseline.policyLabel },
    candidate: { cycleId: candidate.cycleId, policyLabel: candidate.policyLabel },
    workloadKey: baseline.workloadKey,
    measurementKind: baseline.measurementKind,
    currency: baseline.currency,
    unitScale: baseline.unitScale,
    stages,
    totals: {
      ...compareCost(totalCost(baseline, 'baseline'), totalCost(candidate, 'candidate')),
      baselineCallCount,
      candidateCallCount,
      deltaCallCount: candidateCallCount - baselineCallCount,
      missingCosts,
    },
    quality: {
      comparisonStatus: unknownItems.length === 0 ? 'sufficient' : 'insufficient',
      observations,
      regressions: observations.filter(item => item.baseline === 'pass' && item.candidate === 'fail').map(item => item.qualityId),
      candidateFailures: observations.filter(item => item.candidate === 'fail').map(item => item.qualityId),
      unknownItems,
    },
  };
}
