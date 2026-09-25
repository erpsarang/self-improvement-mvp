import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AI_EXECUTION_BASELINE, STAGE_IDS } from '../src/ai-execution-baseline.js';
import { compareRuns, QUALITY_IDS, type RunInput } from '../src/ai-cost-comparison.js';

function run(cost = 100): RunInput {
  return {
    cycleId: 'synthetic-cycle',
    workloadKey: 'synthetic-workload',
    policyLabel: 'synthetic-policy',
    measurementKind: 'expected',
    currency: 'USD',
    unitScale: 1000,
    stages: STAGE_IDS.map(stageId => ({ stageId, callCount: 1, costUnits: cost })),
    quality: {
      planQuality: 'pass', implementationSuccess: 'pass', deterministicCi: 'pass',
      semanticReview: 'pass', humanMergeJudgment: 'pass',
    },
  };
}

// Synthetic references exercise the input contract; they are not actual evidence.
function measuredRun(label = 'fixture', cost = 100): RunInput {
  const input = run(cost);
  input.measurementKind = 'measured';
  input.stages = input.stages.map(stage => ({
    ...stage, sourceRef: `fixtures/${label}.json#${stage.stageId}`,
  }));
  return input;
}

function onlyPlan(cost: number, calls = 1): RunInput {
  const input = run();
  input.stages = STAGE_IDS.map(stageId => ({
    stageId, callCount: stageId === 'plan' ? calls : 0, costUnits: stageId === 'plan' ? cost : 0,
  }));
  return input;
}

function rawRun(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(run())) as Record<string, unknown>;
}

function rawStages(input: Record<string, unknown>): Record<string, unknown>[] {
  return input.stages as Record<string, unknown>[];
}

test('baseline records configuration evidence without claiming an actual model', () => {
  assert.deepEqual(AI_EXECUTION_BASELINE.map(entry => entry.stageId), STAGE_IDS);
  for (const entry of AI_EXECUTION_BASELINE) {
    assert.deepEqual(entry.model, { status: 'unspecified' });
    assert.deepEqual(entry.actualModel, { status: 'unknown' });
    assert.deepEqual(entry.effort, entry.stageId === 'fix'
      ? { status: 'unknown' }
      : { status: 'confirmed', value: entry.stageId === 'bounded-implement' ? 'low' : 'medium' });
  }
});

test('compares by stage identity, preserves inputs, and reports independent quality', () => {
  const baseline = run(100);
  const candidate = run(80);
  candidate.cycleId = 'candidate-cycle';
  candidate.policyLabel = 'candidate-policy';
  candidate.stages.reverse();
  candidate.stages.find(stage => stage.stageId === 'plan')!.callCount = 2;
  const snapshot = JSON.stringify([baseline, candidate]);
  const result = compareRuns(baseline, candidate);
  assert.equal(JSON.stringify([baseline, candidate]), snapshot);
  assert.deepEqual(result.stages.map(stage => stage.stageId), STAGE_IDS);
  assert.equal(result.stages[0]!.deltaCallCount, 1);
  assert.equal(result.stages[0]!.deltaCostUnits, -20);
  assert.equal(result.totals.baselineCostUnits, 700);
  assert.equal(result.totals.candidateCostUnits, 560);
  assert.equal(result.totals.deltaCostUnits, -140);
  assert.equal(result.totals.savingsPercent, 20);
  assert.equal(result.totals.deltaCallCount, 1);
  assert.deepEqual(result.totals.missingCosts, []);
  assert.equal(result.totals.deltaUnavailableReason, null);
  assert.equal(result.totals.savingsUnavailableReason, null);
  assert.equal(result.quality.comparisonStatus, 'sufficient');
  assert.deepEqual(result.quality.regressions, []);
  assert.deepEqual(result.quality.candidateFailures, []);
  assert.deepEqual(result.quality.unknownItems, []);
  assert.deepEqual(result.candidate, { cycleId: 'candidate-cycle', policyLabel: 'candidate-policy' });
});

test('measured comparisons preserve both source references by stage identity', () => {
  const baseline = measuredRun('before', 100);
  const candidate = measuredRun('after', 80);
  baseline.stages[0]!.sourceRef = '  fixtures/before.json#plan  ';
  candidate.stages.reverse();
  candidate.stages.find(stage => stage.stageId === 'plan')!.callCount = 2;
  const snapshot = JSON.stringify([baseline, candidate]);
  const result = compareRuns(baseline, candidate);
  assert.equal(JSON.stringify([baseline, candidate]), snapshot);
  assert.equal(result.measurementKind, 'measured');
  assert.deepEqual(result.stages.map(stage => stage.stageId), STAGE_IDS);
  for (const stage of result.stages) {
    assert.equal(stage.baselineSourceRef, stage.stageId === 'plan'
      ? '  fixtures/before.json#plan  ' : `fixtures/before.json#${stage.stageId}`);
    assert.equal(stage.candidateSourceRef, `fixtures/after.json#${stage.stageId}`);
    assert.equal(stage.deltaCostUnits, -20);
    assert.equal(stage.deltaCallCount, stage.stageId === 'plan' ? 1 : 0);
  }
  assert.equal(result.totals.baselineCostUnits, 700);
  assert.equal(result.totals.candidateCostUnits, 560);
  assert.equal(result.totals.deltaCostUnits, -140);
  assert.equal(result.totals.savingsPercent, 20);
  assert.equal(result.totals.deltaCallCount, 1);
});

test('measured inputs require an own source reference for every stage on either side', () => {
  for (const side of ['baseline', 'candidate'] as const) {
    for (const stageId of STAGE_IDS) {
      for (const cost of [100, 0, null]) {
        const baseline = measuredRun('before');
        const candidate = measuredRun('after');
        const stage = (side === 'baseline' ? baseline : candidate).stages.find(item => item.stageId === stageId)!;
        stage.costUnits = cost;
        stage.callCount = cost === 0 ? 0 : 1;
        delete stage.sourceRef;
        assert.throws(() => compareRuns(baseline, candidate), {
          name: 'TypeError', message: `${side}.${stageId}.sourceRef: required for measured stages`,
        });
        Object.setPrototypeOf(stage, { sourceRef: 'inherited-reference' });
        assert.throws(() => compareRuns(baseline, candidate), {
          name: 'TypeError', message: `${side}.${stageId}.sourceRef: required for measured stages`,
        });
      }
    }
  }
});

test('provided source references must be nonempty strings for either measurement kind', () => {
  for (const measurementKind of ['expected', 'measured'] as const) {
    for (const sourceRef of ['', ' \t\n', null, undefined, 1, false, {}, []]) {
      for (const side of ['baseline', 'candidate'] as const) {
        const baseline = { ...measuredRun('before'), measurementKind };
        const candidate = { ...measuredRun('after'), measurementKind };
        const input = side === 'baseline' ? baseline : candidate;
        input.stages[0] = { ...input.stages[0]!, sourceRef } as unknown as RunInput['stages'][number];
        assert.throws(() => compareRuns(baseline, candidate), {
          name: 'TypeError', message: `${side}.plan.sourceRef: expected a nonempty string`,
        });
      }
    }
  }
});

test('expected inputs allow absent or partial references without becoming measured', () => {
  const baseline = run();
  const candidate = run(80);
  let result = compareRuns(baseline, candidate);
  assert.equal(result.measurementKind, 'expected');
  for (const stage of result.stages) {
    assert.equal(stage.baselineSourceRef, null);
    assert.equal(stage.candidateSourceRef, null);
  }
  baseline.stages[0]!.sourceRef = 'local-estimate:before';
  candidate.stages[1]!.sourceRef = 'local-estimate:after';
  result = compareRuns(baseline, candidate);
  assert.equal(result.measurementKind, 'expected');
  for (const stage of result.stages) {
    assert.equal(stage.baselineSourceRef, stage.stageId === 'plan' ? 'local-estimate:before' : null);
    assert.equal(stage.candidateSourceRef, stage.stageId === 'bounded-implement' ? 'local-estimate:after' : null);
  }
  assert.equal(result.totals.deltaCostUnits, -140);
  assert.equal(result.totals.savingsPercent, 20);
});

test('source references do not fill missing costs or change uncalled stage rules', () => {
  const baseline = measuredRun('before');
  const candidate = measuredRun('after', 80);
  baseline.stages[0]!.costUnits = null;
  candidate.stages[1]!.callCount = 0;
  candidate.stages[1]!.costUnits = 0;
  const result = compareRuns(baseline, candidate);
  assert.equal(result.stages[0]!.baselineSourceRef, 'fixtures/before.json#plan');
  assert.equal(result.stages[0]!.deltaUnavailableReason, 'missing-cost');
  assert.equal(result.stages[1]!.candidateSourceRef, 'fixtures/after.json#bounded-implement');
  assert.equal(result.stages[1]!.deltaCostUnits, -100);
  assert.equal(result.totals.baselineCostUnits, null);
  assert.equal(result.totals.candidateCostUnits, 480);
  assert.equal(result.totals.deltaCostUnits, null);
  assert.deepEqual(result.totals.missingCosts, [{ side: 'baseline', stageId: 'plan' }]);
  candidate.stages[1]!.costUnits = null;
  assert.throws(() => compareRuns(baseline, candidate), TypeError);
});

test('sourceRef remains the only optional stage field', () => {
  for (const side of ['baseline', 'candidate'] as const) {
    const baseline = measuredRun('before');
    const candidate = measuredRun('after');
    const input = side === 'baseline' ? baseline : candidate;
    Object.assign(input.stages[0]!, { extra: true });
    assert.throws(() => compareRuns(baseline, candidate), TypeError);
  }
});

test('cost increases, equality, full savings, and fractional percentages', () => {
  assert.equal(compareRuns(run(100), run(150)).totals.savingsPercent, -50);
  assert.equal(compareRuns(run(100), run(150)).totals.deltaCostUnits, 350);
  assert.equal(compareRuns(run(), run()).totals.savingsPercent, 0);
  assert.equal(compareRuns(run(), run(0)).totals.savingsPercent, 100);
  assert.ok(Math.abs(compareRuns(onlyPlan(3), onlyPlan(2)).totals.savingsPercent! - 100 / 3) < 1e-12);
});

test('zero baseline yields a known delta but no savings percentage', () => {
  for (const cost of [0, 5]) {
    const result = compareRuns(onlyPlan(0, 0), onlyPlan(cost));
    assert.equal(result.totals.deltaCostUnits, cost);
    assert.equal(result.totals.savingsPercent, null);
    assert.equal(result.totals.savingsUnavailableReason, 'zero-baseline-cost');
    assert.equal(result.totals.deltaUnavailableReason, null);
    assert.equal(result.stages[1]!.savingsUnavailableReason, 'zero-baseline-cost');
  }
});

test('missing costs never become partial totals and retain side/stage reasons', () => {
  const baseline = run();
  const candidate = run(80);
  baseline.stages[0]!.costUnits = null;
  let result = compareRuns(baseline, candidate);
  assert.equal(result.totals.baselineCostUnits, null);
  assert.equal(result.totals.candidateCostUnits, 560);
  assert.equal(result.totals.deltaCostUnits, null);
  assert.equal(result.totals.savingsPercent, null);
  assert.equal(result.totals.deltaUnavailableReason, 'missing-cost');
  assert.equal(result.totals.savingsUnavailableReason, 'missing-cost');
  assert.deepEqual(result.totals.missingCostSides, ['baseline']);
  assert.deepEqual(result.totals.missingCosts, [{ side: 'baseline', stageId: 'plan' }]);
  assert.equal(result.stages[1]!.deltaCostUnits, -20);
  assert.equal(result.totals.baselineCallCount, 7);
  candidate.stages[1]!.costUnits = null;
  result = compareRuns(baseline, candidate);
  assert.equal(result.totals.candidateCostUnits, null);
  assert.deepEqual(result.totals.missingCostSides, ['baseline', 'candidate']);
  assert.deepEqual(result.totals.missingCosts, [
    { side: 'baseline', stageId: 'plan' }, { side: 'candidate', stageId: 'bounded-implement' },
  ]);
  assert.deepEqual(result.stages[1]!.missingCostSides, ['candidate']);
  assert.equal(result.quality.comparisonStatus, 'sufficient');
  const unknownCandidate = onlyPlan(1);
  unknownCandidate.stages[0]!.costUnits = null;
  assert.equal(compareRuns(onlyPlan(0, 0), unknownCandidate).totals.savingsUnavailableReason, 'missing-cost');
});

test('safe integer boundaries are accepted and aggregate overflow is rejected', () => {
  const maximum = Number.MAX_SAFE_INTEGER;
  const result = compareRuns(onlyPlan(maximum, maximum), onlyPlan(0, 0));
  assert.equal(result.totals.deltaCostUnits, -maximum);
  assert.equal(result.totals.deltaCallCount, -maximum);
  assert.equal(result.totals.savingsPercent, 100);
  const costOverflow = onlyPlan(maximum);
  costOverflow.stages[1] = { stageId: 'bounded-implement', callCount: 1, costUnits: 1 };
  assert.throws(() => compareRuns(costOverflow, run()), RangeError);
  assert.throws(() => compareRuns(run(), costOverflow), RangeError);
  const callOverflow = onlyPlan(0, maximum);
  callOverflow.stages[1] = { stageId: 'bounded-implement', callCount: 1, costUnits: 0 };
  assert.throws(() => compareRuns(run(), callOverflow), RangeError);
});

test('comparison dimensions must match; identifiers and labels may differ', () => {
  for (const [key, value] of [
    ['workloadKey', 'different'], ['measurementKind', 'measured'], ['currency', 'EUR'], ['unitScale', 100],
  ] as const) {
    const candidate = { ...run(), [key]: value };
    if (key === 'measurementKind') candidate.stages = measuredRun().stages;
    assert.throws(() => compareRuns(run(), candidate), new RegExp(key));
  }
  assert.throws(() => compareRuns(measuredRun(), run()), /measurementKind/);
  const baseline = measuredRun();
  const candidate = { ...baseline, cycleId: 'other', policyLabel: 'other' };
  assert.equal(compareRuns(baseline, candidate).measurementKind, 'measured');
});

test('rejects invalid runtime structures on either side', () => {
  const invalidInputs: unknown[] = [null, [], 1, 'run', undefined];
  const mutations: ((value: Record<string, unknown>) => void)[] = [
    value => { delete value.cycleId; },
    value => { value.extra = true; },
    value => { value.cycleId = ' '; },
    value => { value.workloadKey = 2; },
    value => { value.policyLabel = ''; },
    value => { value.currency = ''; },
    value => { value.measurementKind = 'estimated'; },
    value => { value.stages = {}; },
    value => { rawStages(value).pop(); },
    value => { rawStages(value).push({ stageId: 'plan', callCount: 1, costUnits: 1 }); },
    value => { rawStages(value)[0]!.stageId = 'invalid'; },
    value => { rawStages(value)[0]!.stageId = 'fix'; },
    value => { rawStages(value)[0] = null as unknown as Record<string, unknown>; },
    value => { delete rawStages(value)[0]!.costUnits; },
    value => { rawStages(value)[0]!.extra = true; },
    value => { rawStages(value)[0]!.callCount = 0; },
    value => { rawStages(value)[0]!.callCount = 0; rawStages(value)[0]!.costUnits = null; },
    value => { value.quality = null; },
    value => { delete (value.quality as Record<string, unknown>).planQuality; },
    value => { (value.quality as Record<string, unknown>).extra = 'pass'; },
    value => { (value.quality as Record<string, unknown>).planQuality = 'approved'; },
  ];
  for (const mutate of mutations) {
    const value = rawRun();
    mutate(value);
    invalidInputs.push(value);
  }
  for (const value of invalidInputs) {
    assert.throws(() => compareRuns(value, run()), TypeError);
    assert.throws(() => compareRuns(run(), value), TypeError);
  }
});

test('integer fields reject negative, fractional, nonfinite, unsafe, and nonnumeric values', () => {
  for (const value of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '1', undefined, null]) {
    for (const field of ['callCount', 'costUnits', 'unitScale']) {
      if (field === 'costUnits' && value === null) continue;
      const input = rawRun();
      if (field === 'unitScale') input.unitScale = value;
      else rawStages(input)[0]![field] = value;
      assert.throws(() => compareRuns(input, run()), TypeError);
    }
  }
  assert.throws(() => compareRuns({ ...run(), unitScale: 0 }, run()), TypeError);
});

test('all quality transitions are summarized independently of savings', () => {
  const statuses = ['pass', 'fail', 'unknown'] as const;
  for (const id of QUALITY_IDS) {
    for (const before of statuses) {
      for (const after of statuses) {
        const baseline = run(100);
        const candidate = run(50);
        baseline.quality[id] = before;
        candidate.quality[id] = after;
        const result = compareRuns(baseline, candidate);
        const unknown = before === 'unknown' || after === 'unknown';
        assert.equal(result.totals.savingsPercent, 50);
        assert.equal(result.quality.comparisonStatus, unknown ? 'insufficient' : 'sufficient');
        assert.deepEqual(result.quality.unknownItems, unknown ? [id] : []);
        assert.deepEqual(result.quality.regressions, before === 'pass' && after === 'fail' ? [id] : []);
        assert.deepEqual(result.quality.candidateFailures, after === 'fail' ? [id] : []);
        assert.deepEqual(result.quality.observations.find(item => item.qualityId === id), {
          qualityId: id, baseline: before, candidate: after,
        });
      }
    }
  }
});

test('unknown observations do not suppress other regression or failure signals', () => {
  const baseline = run();
  const candidate = run(10);
  baseline.quality.implementationSuccess = 'fail';
  candidate.quality.implementationSuccess = 'fail';
  candidate.quality.planQuality = 'fail';
  candidate.quality.humanMergeJudgment = 'unknown';
  const result = compareRuns(baseline, candidate);
  assert.equal(result.quality.comparisonStatus, 'insufficient');
  assert.deepEqual(result.quality.regressions, ['planQuality']);
  assert.deepEqual(result.quality.candidateFailures, ['planQuality', 'implementationSuccess']);
  assert.deepEqual(result.quality.unknownItems, ['humanMergeJudgment']);
});
