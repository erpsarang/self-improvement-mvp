import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  collectAiUsageEvidence,
  type AiUsageStage,
  type CollectorDependencies,
  type NormalizedJob,
  type StageRunIdentity,
} from '../src/ai-usage-evidence-collector.js';

const target: StageRunIdentity = {
  stage: 'PLAN', owner: 'owner', repo: 'repo', runId: 101,
};

test('collects only explicit runs and jobs sequentially, preserving raw logs and parser values', async () => {
  const stages: AiUsageStage[] = [
    'PLAN', 'IMPLEMENT/FIX', 'SEMANTIC_REVIEW', 'LEARN', 'PRODUCT_EVALUATION',
  ];
  const runs = stages.map((stage, index) => ({
    stage, owner: `owner${index}`, repo: `repo${index}`, runId: 100 + index,
  }));
  const events: string[] = [];
  const parserValues = new Map<number, object>();
  const result = await collectAiUsageEvidence(runs, {
    listJobs: async (request) => {
      const index = request.runId - 100;
      assert.deepEqual(request, {
        method: 'GET',
        endpoint: '/repos/{owner}/{repo}/actions/runs/{run_id}/jobs',
        owner: `owner${index}`, repo: `repo${index}`, runId: 100 + index,
      });
      events.push(`list:${request.runId}`);
      return [
        { jobId: request.runId * 10 + 2, skipped: false },
        { jobId: request.runId * 10 + 3, skipped: true },
        { jobId: request.runId * 10 + 1, skipped: false },
      ];
    },
    getJobLog: async (request) => {
      const index = request.runId - 100;
      assert.deepEqual(request, {
        method: 'GET',
        endpoint: '/repos/{owner}/{repo}/actions/jobs/{job_id}/logs',
        owner: `owner${index}`, repo: `repo${index}`,
        runId: 100 + index, jobId: request.jobId,
      });
      assert.ok([request.runId * 10 + 2, request.runId * 10 + 1].includes(request.jobId));
      events.push(`log:${request.jobId}`);
      return ` raw log ${request.jobId}\r\n`;
    },
    parseEvidence: async (input) => {
      const index = input.runId - 100;
      assert.deepEqual(input, {
        owner: `owner${index}`, repo: `repo${index}`, runId: 100 + index,
        jobId: input.jobId, rawLog: ` raw log ${input.jobId}\r\n`,
      });
      events.push(`parse:${input.jobId}`);
      // An opaque fake result, not a declaration of the existing parser schema.
      const value = Object.freeze({
        invocations: Object.freeze([
          Object.freeze({ model: 'observed-model', tokenUsage: 123, monetaryCost: null }),
          Object.freeze({ model: null, tokenUsage: null, monetaryCost: null }),
        ]),
        sourceRef: `github-actions-job-log://${input.owner}/${input.repo}/run/${input.runId}/job/${input.jobId}#codex-1`,
      });
      parserValues.set(input.jobId, value);
      return value;
    },
  });

  assert.deepEqual(events, runs.flatMap(({ runId }) => [
    `list:${runId}`, `log:${runId * 10 + 2}`, `parse:${runId * 10 + 2}`,
    `log:${runId * 10 + 1}`, `parse:${runId * 10 + 1}`,
  ]));
  assert.deepEqual(result, runs.flatMap((run) => [2, 1].map((offset) => ({
    ...run, jobId: run.runId * 10 + offset,
    evidence: parserValues.get(run.runId * 10 + offset),
  }))));
  for (const item of result) assert.strictEqual(item.evidence, parserValues.get(item.jobId));
});

test('empty input, empty job lists and skipped jobs require no logs or parsing', async () => {
  let listCalls = 0;
  const dependencies: CollectorDependencies<unknown> = {
    listJobs: async () => {
      listCalls += 1;
      return listCalls === 1 ? [] : [{ jobId: 1, skipped: true }];
    },
    getJobLog: async () => { throw new Error('Unexpected log request'); },
    parseEvidence: () => { throw new Error('Unexpected parser call'); },
  };
  assert.deepEqual(await collectAiUsageEvidence([], dependencies), []);
  assert.equal(listCalls, 0);
  assert.deepEqual(await collectAiUsageEvidence([target, { ...target, runId: 102 }], dependencies), []);
  assert.equal(listCalls, 2);
});

test('validates all explicit identities before requesting evidence', async () => {
  const invalid = [
    { stage: 'UNKNOWN' }, { stage: undefined },
    { owner: '' }, { owner: undefined }, { owner: 'other/owner' },
    { repo: '' }, { repo: undefined }, { repo: '..' },
    { runId: undefined }, { runId: '101' }, { runId: 0 },
    { runId: -1 }, { runId: 1.5 }, { runId: Number.MAX_SAFE_INTEGER + 1 },
  ];
  let calls = 0;
  const dependencies: CollectorDependencies<null> = {
    listJobs: async () => { calls += 1; return []; },
    getJobLog: async () => { calls += 1; return ''; },
    parseEvidence: () => { calls += 1; return null; },
  };
  for (const patch of invalid) {
    const bad = { ...target, ...patch } as unknown as StageRunIdentity;
    await assert.rejects(collectAiUsageEvidence([target, bad], dependencies), TypeError);
  }
  assert.equal(calls, 0);
});

test('rejects incomplete normalized job identities before log retrieval', async () => {
  for (const bad of [{ jobId: 0, skipped: false }, { jobId: 1 }, { skipped: true }]) {
    await assert.rejects(collectAiUsageEvidence([target], {
      listJobs: async () => [
        { jobId: 2, skipped: false }, bad as NormalizedJob,
      ],
      getJobLog: async () => { assert.fail('Unexpected log request'); },
      parseEvidence: () => { assert.fail('Unexpected parser call'); },
    }), TypeError);
  }
});

test('preserves null and empty parser results without inferring usage', async () => {
  for (const evidence of [null, []]) {
    const result = await collectAiUsageEvidence([target], {
      listJobs: async () => [{ jobId: 1, skipped: false }],
      getJobLog: async () => '',
      parseEvidence: () => evidence,
    });
    assert.equal(result.length, 1);
    assert.strictEqual(result[0]?.evidence, evidence);
  }
});

for (const failurePoint of ['list', 'log', 'parse'] as const) {
  test(`propagates ${failurePoint} errors unchanged without retry or later work`, async () => {
    const failure = new Error(`${failurePoint} failed`);
    const events: string[] = [];
    const dependencies: CollectorDependencies<null> = {
      listJobs: async () => {
        events.push('list');
        if (failurePoint === 'list') throw failure;
        return [{ jobId: 1, skipped: false }, { jobId: 2, skipped: false }];
      },
      getJobLog: async () => {
        events.push('log');
        if (failurePoint === 'log') throw failure;
        return 'raw';
      },
      parseEvidence: async () => {
        events.push('parse');
        throw failure;
      },
    };
    await assert.rejects(
      collectAiUsageEvidence([target, { ...target, runId: 102 }], dependencies),
      (error: unknown) => error === failure,
    );
    assert.deepEqual(events, failurePoint === 'list' ? ['list']
      : failurePoint === 'log' ? ['list', 'log'] : ['list', 'log', 'parse']);
  });
}
