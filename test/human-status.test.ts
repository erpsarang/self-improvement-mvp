import assert from 'node:assert/strict';
import test from 'node:test';

import { getHumanStatusSummary, type HumanStatus } from '../src/self-improvement/human-status.js';

const statuses: HumanStatus[] = [
  'PLAN',
  'PLAN_AUTHORIZE',
  'IMPLEMENT',
  'VERIFY',
  'MERGE_READY',
  'STOPPED',
];

test('provides display-only guidance for every HumanStatus', () => {
  for (const status of statuses) {
    const summary = getHumanStatusSummary(status);
    assert.ok(summary.currentSituation.length > 0, `${status} needs a current situation`);
    assert.ok(summary.nextAction.length > 0, `${status} needs a next action`);
  }
});

test('status guidance does not imply decisions that still require their own checks', () => {
  assert.match(getHumanStatusSummary('PLAN').currentSituation, /구현 승인이 아닙니다/);
  assert.match(getHumanStatusSummary('PLAN_AUTHORIZE').currentSituation, /구현 시작을 뜻하지 않/);
  assert.match(getHumanStatusSummary('IMPLEMENT').currentSituation, /검증·리뷰 완료를 뜻하지 않/);
  assert.match(getHumanStatusSummary('VERIFY').currentSituation, /검증 성공이나 리뷰 통과를 뜻하지 않/);
  assert.match(getHumanStatusSummary('MERGE_READY').nextAction, /사람이 최종 병합 여부를 결정/);
  assert.match(getHumanStatusSummary('STOPPED').currentSituation, /성공을 뜻하지 않/);
});

test('unknown input fails closed to neutral display guidance', () => {
  const summary = getHumanStatusSummary('NOT_A_WORKFLOW_STATE');
  assert.match(summary.currentSituation, /확인할 수 없습니다/);
  assert.match(summary.currentSituation, /성공 여부는 확인되지 않았습니다/);
  assert.match(summary.nextAction, /기록과 결과를 확인/);
});
