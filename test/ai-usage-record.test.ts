import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  aggregateAiUsageRecord,
  serializeAiUsageRecord,
  type AiUsageRecordInput,
} from '../src/ai-usage-record.js';

const observation = {
  stage: 'PLAN' as const,
  sourceRef: 'execution-1',
  model: 'model-a',
  tokenUsage: 12,
};

function reject(input: unknown): void {
  assert.throws(() => aggregateAiUsageRecord(input), TypeError);
  assert.throws(() => serializeAiUsageRecord(input), TypeError);
}

test('preserves invocation references, models and tokens in the v2 shape', () => {
  const sourceRef = ' evidence/run-42/job-plan#codex-1 ';
  const result = aggregateAiUsageRecord({
    cycleRef: ' cycle-42 ',
    observations: [{ ...observation, sourceRef, model: ' model-a ' }],
  });
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.cycleRef, ' cycle-42 ');
  assert.deepEqual(result.stages.map((entry) => entry.stage), [
    'PLAN', 'IMPLEMENT', 'SEMANTIC_REVIEW', 'LEARN', 'PRODUCT_EVALUATION',
  ]);
  assert.deepEqual(result.stages[0], {
    stage: 'PLAN',
    sourceRefs: [sourceRef],
    invocations: [{ sourceRef, model: ' model-a ', tokenUsage: 12 }],
    observedStageInvocationCount: 1,
    providerCallCount: 1,
    monetaryCost: null,
  });
  for (const entry of result.stages) assert.equal(entry.monetaryCost, null);
});

test('deduplicates references and preserves different invocation models without cross-cycle state', () => {
  const observations = [
    observation,
    { ...observation },
    { ...observation, sourceRef: 'execution-2', model: 'model-b', tokenUsage: 0 },
    { ...observation, stage: 'IMPLEMENT', sourceRef: 'execution-3' },
  ];
  const result = aggregateAiUsageRecord({ cycleRef: 'cycle-1', observations });
  assert.deepEqual(result.stages[0]?.invocations, [
    { sourceRef: 'execution-1', model: 'model-a', tokenUsage: 12 },
    { sourceRef: 'execution-2', model: 'model-b', tokenUsage: 0 },
  ]);
  assert.equal(result.stages[0]?.observedStageInvocationCount, 2);
  assert.equal(result.stages[0]?.providerCallCount, 2);
  assert.equal(result.stages[1]?.providerCallCount, 1);
  const next = aggregateAiUsageRecord({ cycleRef: 'cycle-2', observations });
  assert.equal(next.cycleRef, 'cycle-2');
  assert.deepEqual(next.stages, result.stages);
});

test('rejects conflicts including cross-stage reuse and null versus known values in either order', () => {
  for (const conflicting of [
    { ...observation, stage: 'IMPLEMENT' },
    { ...observation, model: 'model-b' },
    { ...observation, tokenUsage: 13 },
    { ...observation, model: null },
    { ...observation, tokenUsage: null },
  ]) {
    for (const observations of [[observation, conflicting], [conflicting, observation]]) {
      reject({ cycleRef: 'cycle-1', observations });
    }
  }
});

test('incomplete observations preserve known fields and make the stage call count unknown', () => {
  for (const partial of [
    { model: null, tokenUsage: 10 },
    { model: 'model-b', tokenUsage: null },
    { model: null, tokenUsage: null },
  ]) {
    const incomplete = { stage: 'PLAN', sourceRef: 'execution-2', ...partial };
    const result = aggregateAiUsageRecord({
      cycleRef: 'cycle-1',
      observations: [observation, incomplete, { ...incomplete }],
    });
    assert.equal(result.stages[0]?.observedStageInvocationCount, 2);
    assert.equal(result.stages[0]?.providerCallCount, null);
    assert.equal(result.stages[0]?.monetaryCost, null);
    assert.deepEqual(result.stages[0]?.invocations, [
      { sourceRef: 'execution-1', model: 'model-a', tokenUsage: 12 },
      { sourceRef: 'execution-2', ...partial },
    ]);
  }
});

test('serialization is independent of input ordering and identical duplicates', () => {
  const observations = [
    { ...observation, stage: 'LEARN', sourceRef: 'ref-z' },
    { ...observation, sourceRef: 'ref-ä', model: null },
    { ...observation, sourceRef: 'ref-a', tokenUsage: null },
    { ...observation, sourceRef: 'ref-Z' },
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
  assert.deepEqual(aggregateAiUsageRecord(input).stages[0]?.invocations.map((entry) => entry.sourceRef), [
    'ref-Z', 'ref-a', 'ref-ä',
  ]);
  assert.ok(serialized.startsWith('{"schemaVersion":2,"cycleRef":"cycle-1","stages":['));
});

test('absent observations remain unknown, never zero', () => {
  const empty = aggregateAiUsageRecord({ cycleRef: 'cycle-1', observations: [] });
  assert.equal(empty.stages.length, 5);
  for (const entry of empty.stages) {
    assert.deepEqual(entry, {
      stage: entry.stage,
      sourceRefs: [],
      invocations: [],
      observedStageInvocationCount: null,
      providerCallCount: null,
      monetaryCost: null,
    });
  }
  const partial = aggregateAiUsageRecord({
    cycleRef: 'cycle-1',
    observations: [{ ...observation, stage: 'PRODUCT_EVALUATION' }],
  });
  assert.deepEqual(partial.stages.map((entry) => entry.providerCallCount), [
    null, null, null, null, 1,
  ]);
});

test('accepts safe token boundaries without summing invocation tokens', () => {
  const result = aggregateAiUsageRecord({
    cycleRef: 'cycle-1',
    observations: [
      { ...observation, tokenUsage: Number.MAX_SAFE_INTEGER },
      { ...observation, sourceRef: 'execution-2', tokenUsage: Number.MAX_SAFE_INTEGER },
      { ...observation, sourceRef: 'execution-3', tokenUsage: -0 },
    ],
  });
  assert.deepEqual(result.stages[0]?.invocations.map((entry) => entry.tokenUsage), [
    Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0,
  ]);
  assert.equal(result.stages[0]?.providerCallCount, 3);
  assert.equal(result.stages[0]?.monetaryCost, null);
});

test('rejects malformed input, missing fields and unsupported evidence fields', () => {
  const invalid: unknown[] = [
    null, undefined, [], 'cycle-1', {}, new Date(),
    { cycleRef: 'cycle-1' },
    { cycleRef: '', observations: [] },
    { cycleRef: ' \n\t', observations: [] },
    { cycleRef: 1, observations: [] },
    { cycleRef: 'cycle-1', observations: null },
    { cycleRef: 'cycle-1', observations: {} },
    { cycleRef: 'cycle-1', observations: [], extra: true },
    { cycleRef: 'cycle-1', observations: new Array(1) },
  ];
  const invalidObservations: unknown[] = [null, [], 'PLAN', {}, new Date()];
  for (const key of Object.keys(observation)) {
    const missing: Record<string, unknown> = { ...observation };
    delete missing[key];
    invalidObservations.push(missing);
  }
  for (const stage of ['plan', 'REVIEW', 1, null]) {
    invalidObservations.push({ ...observation, stage });
  }
  for (const sourceRef of ['', ' \n', null, 42]) {
    invalidObservations.push({ ...observation, sourceRef });
  }
  for (const model of ['', ' \n', undefined, 42, {}, false]) {
    invalidObservations.push({ ...observation, model });
  }
  for (const tokenUsage of [undefined, '12', '18,152', -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, {}, false]) {
    invalidObservations.push({ ...observation, tokenUsage });
  }
  for (const field of ['providerCallCount', 'monetaryCost', 'extra']) {
    invalidObservations.push({ ...observation, [field]: null });
  }
  invalidObservations.push({ ...observation, [Symbol('extra')]: true });
  invalidObservations.push(Object.assign(Object.create({ inherited: true }), observation));
  for (const entry of invalidObservations) {
    invalid.push({ cycleRef: 'cycle-1', observations: [entry] });
  }
  for (const input of invalid) reject(input);
});

test('does not mutate frozen input or retain mutable observation aliases', () => {
  const input: AiUsageRecordInput = Object.freeze({
    cycleRef: 'cycle-1',
    observations: Object.freeze([
      Object.freeze({ ...observation, sourceRef: 'ref-z' }),
      Object.freeze({ ...observation, sourceRef: 'ref-a' }),
      Object.freeze({ ...observation, sourceRef: 'ref-z' }),
    ]),
  });
  const before = JSON.stringify(input);
  aggregateAiUsageRecord(input);
  serializeAiUsageRecord(input);
  assert.equal(JSON.stringify(input), before);

  const mutable = {
    cycleRef: 'cycle-2',
    observations: [{ ...observation }],
  };
  const result = aggregateAiUsageRecord(mutable);
  mutable.cycleRef = 'changed';
  mutable.observations[0]!.sourceRef = 'changed';
  mutable.observations[0]!.model = 'changed';
  mutable.observations[0]!.tokenUsage = 99;
  mutable.observations.push({ ...observation, sourceRef: 'new' });
  assert.equal(result.cycleRef, 'cycle-2');
  assert.deepEqual(result.stages[0]?.sourceRefs, ['execution-1']);
  assert.deepEqual(result.stages[0]?.invocations, [
    { sourceRef: 'execution-1', model: 'model-a', tokenUsage: 12 },
  ]);
  assert.equal(result.stages[0]?.providerCallCount, 1);
  assert.equal(result.stages[1]?.observedStageInvocationCount, null);
});
