import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  parseInvocationEvidence,
  type AiUsageStage,
  type InvocationEvidenceInput,
} from '../src/ai-usage-evidence.js';

function evidence(overrides: Partial<InvocationEvidenceInput> = {}): InvocationEvidenceInput {
  return {
    owner: 'example',
    repo: 'framework',
    runId: '36105751504',
    jobId: '10850838788',
    stage: 'PLAN',
    ordinal: 1,
    boundaryConfirmed: true,
    bannerLog: 'model: observed-model',
    completionLog: 'tokens used\n1,234',
    ...overrides,
  };
}

test('deterministically preserves identity and pairs observed markers without mutation', () => {
  const input = Object.freeze(evidence());
  const first = parseInvocationEvidence(input);
  assert.deepEqual(first, {
    owner: 'example',
    repo: 'framework',
    runId: '36105751504',
    jobId: '10850838788',
    stage: 'PLAN',
    ordinal: 1,
    sourceRef: 'github-actions-job-log://example/framework/run/36105751504/job/10850838788#codex-1',
    providerCallCount: 1,
    model: 'observed-model',
    tokenUsage: 1234,
    monetaryCost: null,
  });
  assert.deepEqual(parseInvocationEvidence(input), first);
  assert.deepEqual(input, evidence());
});

test('preserves every supplied stage and distinguishes invocation ordinals', () => {
  const stages: AiUsageStage[] = [
    'PLAN', 'IMPLEMENT', 'SEMANTIC_REVIEW', 'LEARN', 'PRODUCT_EVALUATION',
  ];
  for (const stage of stages) {
    const result = parseInvocationEvidence(evidence({ stage, ordinal: 2 }));
    assert.equal(result.stage, stage);
    assert.equal(result.sourceRef,
      'github-actions-job-log://example/framework/run/36105751504/job/10850838788#codex-2');
  }
});

test('missing measurements are independently null and cannot prove a paired call', () => {
  for (const [bannerLog, completionLog, model, tokenUsage] of [
    ['', 'tokens used\n12', null, 12],
    ['model: observed-model', '', 'observed-model', null],
    ['', '', null, null],
  ] as const) {
    const result = parseInvocationEvidence(evidence({ bannerLog, completionLog }));
    assert.equal(result.model, model);
    assert.equal(result.tokenUsage, tokenUsage);
    assert.equal(result.providerCallCount, null);
    assert.equal(result.monetaryCost, null);
  }
});

test('conflicting or duplicate model markers are ambiguous', () => {
  for (const bannerLog of [
    'model: first\nmodel: second',
    'model: first\nmodel: first',
    'model: first\nmodel:',
    'model: this is a generated sentence',
  ]) {
    const result = parseInvocationEvidence(evidence({ bannerLog }));
    assert.equal(result.model, null);
    assert.equal(result.tokenUsage, 1234);
    assert.equal(result.providerCallCount, null);
  }
});

test('conflicting, repeated, malformed and unsafe token markers remain null', () => {
  for (const completionLog of [
    'tokens used\n12\ntokens used\n13',
    'tokens used\n12\ntokens used\n12',
    'tokens used',
    'tokens used\n',
    'tokens used\n-1',
    'tokens used\n1.5',
    'tokens used\n1e3',
    'tokens used\n12,34',
    'tokens used\n9007199254740992',
    'tokens used\n12 tokens',
    'tokens used: 12',
  ]) {
    const result = parseInvocationEvidence(evidence({ completionLog }));
    assert.equal(result.tokenUsage, null, completionLog);
    assert.equal(result.model, 'observed-model');
    assert.equal(result.providerCallCount, null);
    assert.equal(result.monetaryCost, null);
  }
});

test('accepts timestamped CRLF fragments and zero tokens', () => {
  const result = parseInvocationEvidence(evidence({
    bannerLog: '2026-09-25T10:00:00.0000000Z model: observed-model\r\n',
    completionLog: '2026-09-25T10:01:00Z tokens used\r\n2026-09-25T10:01:00Z 0\r\n',
  }));
  assert.equal(result.model, 'observed-model');
  assert.equal(result.tokenUsage, 0);
  assert.equal(result.providerCallCount, 1);
  assert.equal(result.monetaryCost, null);
});

test('does not treat settings, prose or markers from the wrong region as evidence', () => {
  const result = parseInvocationEvidence(evidence({
    bannerLog: 'workflow model: configured-model\nThe model: generated-model\ntokens used\n99',
    completionLog: 'model: generated-model\nThe response says tokens used 99',
  }));
  assert.equal(result.model, null);
  assert.equal(result.tokenUsage, null);
  assert.equal(result.providerCallCount, null);
  assert.equal(result.monetaryCost, null);
});

test('fails closed on uncertain boundaries, ordinals, stages and source identities', () => {
  const invalid: Partial<InvocationEvidenceInput>[] = [
    { boundaryConfirmed: false },
    { ordinal: 0 },
    { ordinal: -1 },
    { ordinal: 1.5 },
    { ordinal: Number.NaN },
    { ordinal: Number.MAX_SAFE_INTEGER + 1 },
    { owner: 'example/other' },
    { repo: 'framework#other' },
    { runId: '' },
    { runId: '01' },
    { jobId: '0' },
    { jobId: '12/other' },
    { stage: 'UNKNOWN' as AiUsageStage },
  ];
  for (const override of invalid) {
    assert.throws(() => parseInvocationEvidence(evidence(override)),
      /Confirmed invocation boundary/);
  }
});

test('retains large decimal source IDs exactly and never estimates monetary cost', () => {
  const result = parseInvocationEvidence(evidence({
    runId: '9007199254740993',
    completionLog: 'tokens used\n9007199254740991',
  }));
  assert.equal(result.runId, '9007199254740993');
  assert.equal(result.sourceRef,
    'github-actions-job-log://example/framework/run/9007199254740993/job/10850838788#codex-1');
  assert.equal(result.tokenUsage, Number.MAX_SAFE_INTEGER);
  assert.equal(result.monetaryCost, null);
});
