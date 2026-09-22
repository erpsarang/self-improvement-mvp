import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { assertTrustedOwnershipList } from '../src/self-improvement/distribution-manifest.js';

// Independent, reviewed expectation from the approved Requirement snapshot.
const workflows = [
  'fix-request', 'fix-worker', 'improvement-candidate', 'learn-source', 'learn',
  'orchestrator', 'plan-authorize', 'plan-candidate-bridge', 'plan-implement-handoff',
  'plan-implement-worker', 'plan-recovery', 'plan-worker-recovery-preflight', 'plan',
  'product-evaluation', 'semantic-review', 'trusted-rail',
];
const runtime = [
  'authorization', 'completed-cycle', 'context-pack', 'deterministic-ci',
  'fix-handler', 'fix', 'implement-contract', 'implement',
  'improvement-candidate-handler', 'improvement-candidate', 'learn-handler',
  'learn-input-pack', 'learn-report', 'learn-source-handler', 'learn-source',
  'orchestrator-handler', 'orchestrator', 'plan-authorization', 'plan-authorize-handler',
  'plan-bridge-patch', 'plan-business-context', 'plan-candidate-bridge-handler', 'plan-candidate-bridge',
  'plan-context-policy', 'plan-explicit-path-context', 'plan-human-output-context',
  'plan-implement-handoff-handler', 'plan-implement-handoff',
  'plan-implement-worker-handler', 'plan-implement-worker', 'plan-recovery-handler', 'plan-recovery',
  'plan-worker-ci-repair-handler',
  'planner-handler', 'planner', 'product-evaluation-handler', 'product-evaluation',
  'publish-handler', 'publish', 'repair-policy', 'review-decision',
  'review-handler', 'review', 'seal-handler', 'seal', 'single-pass-worker', 'trusted-lockfile',
  'verify-handler', 'verify', 'distribution-manifest', 'distribution-manifest-verifier',
  'distribution-bundle', 'distribution-bundle-builder', 'distribution-bundle-verifier',
];

test('production ownership is exactly the reviewed full bundle, with no digests or project files', () => {
  const value: unknown = JSON.parse(readFileSync('policy/framework-distribution-ownership.v1.json', 'utf8'));
  assertTrustedOwnershipList(value);
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.sourceRepository, 'erpsarang/self-improvement-mvp');
  const expected = [
    ...workflows.map(name => `.github/workflows/${name}.yml`),
    ...runtime.map(name => `src/self-improvement/${name}.ts`),
    'policy/framework-distribution-ownership.v1.json',
    'package.json',
    'package-lock.json',
  ].sort();
  assert.equal(expected.length, 73);
  assert.deepEqual(value.entries.map(entry => entry.sourcePath).sort(), expected);
  for (const entry of value.entries) {
    const expectedTarget = entry.sourcePath === 'package.json' || entry.sourcePath === 'package-lock.json'
      ? `.framework-runtime/${entry.sourcePath}`
      : entry.sourcePath;
    assert.equal(entry.targetPath, expectedTarget);
    assert.equal(entry.classification, 'required');
    assert.deepEqual(Object.keys(entry).sort(), ['classification', 'sourcePath', 'targetPath']);
  }
});
