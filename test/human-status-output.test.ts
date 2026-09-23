import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path: string): string => readFileSync(path, 'utf8');
const plan = read('.github/workflows/plan.yml');
const authorize = read('.github/workflows/plan-authorize.yml');
const orchestrator = read('.github/workflows/orchestrator.yml');

function position(source: string, fragment: string): number {
  const index = source.indexOf(fragment);
  assert.notEqual(index, -1, `missing expected fragment: ${fragment}`);
  return index;
}

test('PLAN appends its summary after existing provenance fields', () => {
  const fields = [
    'PLAN: [${identity.artifactName}]',
    'Provenance: [PLAN-provenance.json]',
    'Frozen target SHA:',
    'Requirement title/body SHA-256:',
    'Workflow run:',
    'PLAN artifact ID:',
    'PLAN artifact SHA-256:',
    '### HumanStatus: PLAN',
  ];
  const positions = fields.map((field) => position(plan, field));
  for (let index = 1; index < positions.length; index += 1) {
    const previous = positions[index - 1];
    const current = positions[index];
    assert.ok(previous !== undefined && current !== undefined && previous < current);
  }
  assert.match(plan, /\*\*현재 상황:\*\*/);
  assert.match(plan, /\*\*다음 행동:\*\*/);
});

test('PLAN_AUTHORIZE appends its summary after exact artifact identity', () => {
  const digest = position(authorize, 'Artifact SHA-256:');
  const noImplement = position(authorize, '이 단계에서는 IMPLEMENT를 시작하지 않습니다.');
  const status = position(authorize, '### HumanStatus: PLAN_AUTHORIZE');
  assert.ok(digest < noImplement && noImplement < status);
});

test('MERGE_READY summary is only part of newly created PR content', () => {
  const reuse = position(orchestrator, 'if (exactBranchPrs.length === 1)');
  const create = position(orchestrator, 'github.rest.pulls.create');
  const summary = position(orchestrator, '### HumanStatus: MERGE_READY');
  const exactCheck = position(orchestrator, 'github.rest.pulls.get');
  assert.ok(reuse < create && create < summary && summary < exactCheck);
  assert.doesNotMatch(orchestrator, /github\.rest\.pulls\.update/);
  assert.match(orchestrator, /reviewed exact SHA/);
  assert.match(orchestrator, /requirements digest/);
  assert.match(orchestrator, /Human-only/);
  assert.match(orchestrator, /Auto Merge는 사용하지 않습니다/);
  assert.match(orchestrator, /ai-dev-framework:MERGE_READY/);
});

test('does not publish additional IMPLEMENT or VERIFY summaries', () => {
  for (const status of ['IMPLEMENT', 'VERIFY']) {
    assert.doesNotMatch(`${plan}\n${authorize}\n${orchestrator}`, new RegExp(`HumanStatus: ${status}`));
  }
});

test('STOPPED is published only by the PLAN_AUTHORIZE fail-closed path, with a reason and next action', () => {
  assert.doesNotMatch(`${plan}\n${orchestrator}`, /HumanStatus: STOPPED/);
  const failureGate = position(authorize, "if: failure() && steps.authorize.outputs.rejected == 'true'");
  const reason = position(authorize, '거부 사유: ${process.env.REJECTION_REASON}');
  const stopped = position(authorize, '### HumanStatus: STOPPED');
  const nextAction = position(authorize, '**다음 행동:** ${process.env.REJECTION_NEXT_ACTION}');
  assert.ok(failureGate < reason && reason < stopped && stopped < nextAction);
  assert.equal(authorize.match(/HumanStatus: STOPPED/g)?.length, 1);
});

test('PLAN pointer carries the Decision Packet between provenance fields and HumanStatus, and fails closed without it', () => {
  const packetGuard = position(plan, "startsWith('### PLAN Decision Packet')");
  const failClosed = position(plan, 'Missing PLAN Decision Packet');
  const digest = position(plan, 'PLAN artifact SHA-256:');
  const packet = position(plan, '              decisionPacket,');
  const status = position(plan, '### HumanStatus: PLAN');
  assert.ok(packetGuard < failClosed && failClosed < digest && digest < packet && packet < status);
  assert.match(plan, /\*\*다음 행동:\*\* \$\{nextAction\}/);
  assert.match(plan, /decision_packet: \$\{\{ steps\.validate\.outputs\.decision_packet \}\}/);
  assert.match(plan, /plan_ready: \$\{\{ steps\.validate\.outputs\.plan_ready \}\}/);
});
