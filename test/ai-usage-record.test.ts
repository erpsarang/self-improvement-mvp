import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  aggregateAiUsageRecord,
  serializeAiUsageRecord,
  type AiUsageRecordInput,
} from '../src/ai-usage-record.js';

test('preserves exact references and only counts observed stage executions', () => {
  const sourceRef = ' evidence/run-42/attempt-2/job-plan/execution-1#artifact-A ';
  const result = aggregateAiUsageRecord({
    cycleRef: ' cycle-42 ',
    observations: [{ stage: 'PLAN', sourceRef }],
  });

  assert.equal(result.schemaVersion, 1);
  assert.equal(result.cycleRef, ' cycle-42 ');
  assert.deepEqual(result.stages.map((entry) => entry.stage), [
    'PLAN', 'IMPLEMENT', 'SEMANTIC_REVIEW', 'LEARN', 'PRODUCT_EVALUATION',
  ]);
  assert.deepEqual(result.stages[0], {
    stage: 'PLAN',
    sourceRefs: [sourceRef],
    observedStageInvocationCount: 1,
    providerCallCount: null,
    model: null,
    tokenUsage: null,
    monetaryCost: null,
  });
  for (const entry of result.stages) {
    assert.equal(entry.providerCallCount, null);
    assert.equal(entry.model, null);
    assert.equal(entry.tokenUsage, null);
    assert.equal(entry.monetaryCost, null);
  }
});

test('deduplicates by stage and sourceRef within each input cycle', () => {
  const observations = [
    { stage: 'PLAN', sourceRef: 'execution-1' },
    { stage: 'PLAN', sourceRef: 'execution-1' },
    { stage: 'PLAN', sourceRef: 'execution-2' },
    { stage: 'IMPLEMENT', sourceRef: 'execution-1' },
  ];
  const result = aggregateAiUsageRecord({ cycleRef: 'cycle-1', observations });
  assert.deepEqual(result.stages[0]?.sourceRefs, ['execution-1', 'execution-2']);
  assert.equal(result.stages[0]?.observedStageInvocationCount, 2);
  assert.equal(result.stages[1]?.observedStageInvocationCount, 1);

  const next = aggregateAiUsageRecord({ cycleRef: 'cycle-2', observations });
  assert.equal(next.cycleRef, 'cycle-2');
  assert.deepEqual(next.stages, result.stages);
});

test('serialization is independent of input ordering and duplicate observations', () => {
  const observations = [
    { stage: 'LEARN', sourceRef: 'ref-z' },
    { stage: 'PLAN', sourceRef: 'ref-ä' },
    { stage: 'PLAN', sourceRef: 'ref-a' },
    { stage: 'PLAN', sourceRef: 'ref-Z' },
  ];
  const input = { cycleRef: 'cycle-1', observations };
  const serialized = serializeAiUsageRecord(input);
  assert.equal(serialized, serializeAiUsageRecord({
    observations: [...observations].reverse().concat(observations),
    cycleRef: 'cycle-1',
  }));
  assert.equal(serialized, JSON.stringify(aggregateAiUsageRecord(input)));
  assert.deepEqual(aggregateAiUsageRecord(input).stages[0]?.sourceRefs, [
    'ref-Z', 'ref-a', 'ref-ä',
  ]);
  assert.ok(serialized.startsWith('{"schemaVersion":1,"cycleRef":"cycle-1","stages":['));
});

test('absent observations remain unknown, never zero', () => {
  const empty = aggregateAiUsageRecord({ cycleRef: 'cycle-1', observations: [] });
  assert.equal(empty.stages.length, 5);
  for (const entry of empty.stages) {
    assert.equal(entry.observedStageInvocationCount, null);
    assert.deepEqual(entry.sourceRefs, []);
  }
  const partial = aggregateAiUsageRecord({
    cycleRef: 'cycle-1',
    observations: [{ stage: 'PRODUCT_EVALUATION', sourceRef: 'execution-1' }],
  });
  assert.deepEqual(partial.stages.map((entry) => entry.observedStageInvocationCount), [
    null, null, null, null, 1,
  ]);
});

test('rejects malformed input and unsupported evidence fields', () => {
  const invalid: unknown[] = [
    null, undefined, [], 'cycle-1', {},
    { cycleRef: 'cycle-1' },
    { cycleRef: '', observations: [] },
    { cycleRef: ' \n\t', observations: [] },
    { cycleRef: 1, observations: [] },
    { cycleRef: 'cycle-1', observations: null },
    { cycleRef: 'cycle-1', observations: {} },
    { cycleRef: 'cycle-1', observations: [], extra: true },
    { cycleRef: 'cycle-1', observations: new Array(1) },
  ];
  const invalidObservations: unknown[] = [
    null, [], 'PLAN', {},
    { stage: 'PLAN' },
    { sourceRef: 'execution-1' },
    { stage: 'plan', sourceRef: 'execution-1' },
    { stage: 'REVIEW', sourceRef: 'execution-1' },
    { stage: 1, sourceRef: 'execution-1' },
    { stage: 'PLAN', sourceRef: '' },
    { stage: 'PLAN', sourceRef: ' \n' },
    { stage: 'PLAN', sourceRef: null },
    { stage: 'PLAN', sourceRef: 42 },
  ];
  for (const field of ['providerCallCount', 'model', 'tokenUsage', 'monetaryCost']) {
    invalidObservations.push({ stage: 'PLAN', sourceRef: 'execution-1', [field]: null });
  }
  for (const observation of invalidObservations) {
    invalid.push({ cycleRef: 'cycle-1', observations: [observation] });
  }
  for (const input of invalid) {
    assert.throws(() => aggregateAiUsageRecord(input), TypeError);
    assert.throws(() => serializeAiUsageRecord(input), TypeError);
  }
});

test('does not mutate frozen input or retain mutable input aliases', () => {
  const input: AiUsageRecordInput = Object.freeze({
    cycleRef: 'cycle-1',
    observations: Object.freeze([
      Object.freeze({ stage: 'PLAN' as const, sourceRef: 'ref-z' }),
      Object.freeze({ stage: 'PLAN' as const, sourceRef: 'ref-a' }),
      Object.freeze({ stage: 'PLAN' as const, sourceRef: 'ref-z' }),
    ]),
  });
  const before = JSON.stringify(input);
  aggregateAiUsageRecord(input);
  serializeAiUsageRecord(input);
  assert.equal(JSON.stringify(input), before);

  const mutable = {
    cycleRef: 'cycle-2',
    observations: [{ stage: 'PLAN', sourceRef: 'original' }],
  };
  const result = aggregateAiUsageRecord(mutable);
  mutable.cycleRef = 'changed';
  mutable.observations[0]!.sourceRef = 'changed';
  mutable.observations.push({ stage: 'IMPLEMENT', sourceRef: 'new' });
  assert.equal(result.cycleRef, 'cycle-2');
  assert.deepEqual(result.stages[0]?.sourceRefs, ['original']);
  assert.equal(result.stages[1]?.observedStageInvocationCount, null);
});
