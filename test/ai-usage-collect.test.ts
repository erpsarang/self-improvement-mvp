import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { collectCompletedCycle, COLLECTION_STAGES, type CompletedCycleInput } from '../src/ai-usage-collect.js';
import type { HttpTransport } from '../src/ai-usage-github-actions.js';

const input: CompletedCycleInput = {
  owner: 'erpsarang', repository: 'self-improvement-mvp',
  cycleRef: 'erpsarang/self-improvement-mvp#273',
  runIds: {
    PLAN: [36119752025], 'IMPLEMENT/FIX': [36120272161],
    SEMANTIC_REVIEW: [36121315832], LEARN: [36121856353], PRODUCT_EVALUATION: [36121809205],
  },
};
const runs = COLLECTION_STAGES.map(stage => input.runIds[stage][0]!);
const log = [
  'OpenAI Codex v1.0', '--------', '\x1b[1mmodel:\x1b[0m observed-model',
  '--------', '\x1b[36muser\x1b[0m', 'model: prompt-model',
  '\x1b[2mtokens used\x1b[0m', '{"result":true}', '42,356',
].map(line => `2026-09-25T10:00:00.1234567Z ${line}`).join('\n');

// Synthetic observations of the supplied format, NOT proof of live cycle usage.
function fixture(events: string[], incomplete = false): HttpTransport {
  return async (url, init) => {
    events.push(url);
    const parsed = new URL(url);
    const run = /\/runs\/(\d+)\/jobs$/.exec(parsed.pathname);
    if (run) {
      const index = runs.indexOf(Number(run[1]));
      assert.ok(index >= 0);
      assert.equal(init.headers.Authorization, 'Bearer test-only');
      return {
        status: 200, headers: { get: () => null },
        text: async () => JSON.stringify({ jobs: [
          { id: index * 10 + 3, conclusion: 'success' },
          { id: index * 10 + 2, conclusion: 'skipped' },
          { id: index * 10 + 1, conclusion: 'success' },
        ] }),
      };
    }
    const job = /\/jobs\/(\d+)\/logs$/.exec(parsed.pathname);
    if (job) {
      assert.notEqual(Number(job[1]) % 10, 2);
      return { status: 302, headers: { get: () => `https://blob.example/${job[1]}` }, text: async () => '' };
    }
    assert.equal(parsed.hostname, 'blob.example');
    assert.deepEqual(init.headers, {});
    const jobId = Number(parsed.pathname.slice(1));
    return {
      status: 200, headers: { get: () => null },
      text: async () => jobId % 10 === 3 ? 'non-AI job' : incomplete ? log.replace('42,356', 'unavailable') : log,
    };
  };
}

test('connects REST, collector, parser and record across all five explicit stages', async () => {
  const events: string[] = [];
  const record = await collectCompletedCycle(input, 'test-only', fixture(events));
  assert.equal(record.cycleRef, input.cycleRef);
  assert.equal(record.schemaVersion, 2);
  assert.equal(events.length, 25);
  for (const [index, stage] of record.stages.entries()) {
    assert.equal(stage.stage, COLLECTION_STAGES[index] === 'IMPLEMENT/FIX' ? 'IMPLEMENT' : COLLECTION_STAGES[index]);
    assert.equal(stage.observedStageInvocationCount, 1);
    assert.equal(stage.providerCallCount, 1);
    assert.equal(stage.monetaryCost, null);
    const sourceRef = `github-actions-job-log://erpsarang/self-improvement-mvp/run/${runs[index]}/job/${index * 10 + 1}#codex-1`;
    assert.deepEqual(stage.sourceRefs, [sourceRef]);
    assert.deepEqual(stage.invocations, [{ sourceRef, model: 'observed-model', tokenUsage: 42356 }]);
  }
  assert.equal(JSON.stringify(record), JSON.stringify(await collectCompletedCycle(input, 'test-only', fixture([]))));
});

test('preserves unknown token usage and paired count without estimating costs', async () => {
  const record = await collectCompletedCycle(input, 'test-only', fixture([], true));
  for (const stage of record.stages) {
    assert.equal(stage.providerCallCount, null);
    assert.equal(stage.invocations[0]?.model, 'observed-model');
    assert.equal(stage.invocations[0]?.tokenUsage, null);
    assert.equal(stage.monetaryCost, null);
  }
});

test('validates every stage before any transport call', async () => {
  let calls = 0;
  const transport: HttpTransport = async () => { calls += 1; throw new Error('Unexpected call'); };
  for (const bad of [
    { ...input, owner: 'bad/owner' }, { ...input, cycleRef: ' ' },
    { ...input, runIds: { ...input.runIds, PRODUCT_EVALUATION: [0] } },
    { ...input, runIds: { ...input.runIds, PRODUCT_EVALUATION: [] } },
    { ...input, runIds: { ...input.runIds, PRODUCT_EVALUATION: input.runIds.PLAN } },
    { ...input, runIds: { PLAN: [1] } },
  ]) {
    await assert.rejects(collectCompletedCycle(bad as CompletedCycleInput, 'test-only', transport), TypeError);
  }
  assert.equal(calls, 0);
});

test('transport failure stops the integration without retries or later stages', async () => {
  let calls = 0;
  await assert.rejects(collectCompletedCycle(input, 'test-only', async () => {
    calls += 1;
    throw new Error('sensitive');
  }), /^Error: GitHub Actions evidence request failed$/);
  assert.equal(calls, 1);
});

test('workflow is dispatch-only, read-only, exact-SHA and scopes the runtime token to collection', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ai-usage-collect.yml', import.meta.url), 'utf8');
  assert.match(workflow, /on:\n  workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request|push:|schedule:|codex-action|secrets\.|write-all|: write/);
  assert.match(workflow, /permissions:\n  actions: read\n  contents: read/);
  assert.match(workflow, /ref: \$\{\{ github.sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.equal((workflow.match(/GITHUB_TOKEN:/g) ?? []).length, 1);
  const collection = workflow.split('      - name: Collect existing evidence\n')[1]!.split('      - name: Publish record summary')[0]!;
  assert.match(collection, /GITHUB_TOKEN: \$\{\{ github.token \}\}/);
  assert.match(collection, /node --import tsx src\/ai-usage-collect.ts/);
  assert.doesNotMatch(collection.split('        run:')[1]!, /\$\{\{ inputs\./);
  assert.match(workflow, /GITHUB_STEP_SUMMARY/);
  assert.match(workflow, /uses: actions\/upload-artifact@v4/);
  assert.match(workflow, /path: \$\{\{ runner.temp \}\}\/ai-usage-record.json/);
  for (const field of ['cycle_ref', 'plan_run_id', 'implement_run_id', 'semantic_review_run_id', 'learn_run_id', 'product_evaluation_run_id']) {
    assert.ok(workflow.includes(`      ${field}:`));
  }
});
