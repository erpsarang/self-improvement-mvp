import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyPlanFailure,
  decidePlanRetry,
  MAX_AUTO_PLAN_RETRY_PER_REQUIREMENT,
  parsePlanRetryRecords,
  planRetryMarker,
  planRetryStopMarker,
  type PlanFailureObservation,
  type PlanRetryRecord,
} from "../src/self-improvement/plan-retry.js";

const key = { issueNumber: 2, requirementDigest: "38b54481347d8182895a8ce2a8e2c7d05a8af75f3cda691778c608819299ca59" };

function observed(overrides: Partial<PlanFailureObservation> = {}): PlanFailureObservation {
  return {
    executorFailureReason: "",
    validationFailureReason: "",
    resultTimedOut: "",
    requestResult: "success",
    resolveResult: "failure",
    ...overrides,
  };
}

// App transportation_guide에서 실제로 관측된 PLAN 실패 5건의 사유 문자열이다(Issue #2, #7의 PLAN_FAILED 댓글).
const OBSERVED_FAILURES: ReadonlyArray<{ readonly run: number; readonly observation: PlanFailureObservation; readonly code: string; readonly retryable: boolean }> = [
  { run: 38885217871, observation: observed({ validationFailureReason: "Error: PLAN references exact path outside bounded implementation scope: static/index.html" }), code: "PLAN_PATH_NOTATION_REJECTED", retryable: false },
  { run: 38887176176, observation: observed({ validationFailureReason: "Error: PLAN references exact path outside bounded implementation scope: index.html" }), code: "PLAN_PATH_NOTATION_REJECTED", retryable: false },
  { run: 38979993091, observation: observed({ validationFailureReason: "Error: PLAN references exact path outside bounded implementation scope: test_recommend.py/test_server.py" }), code: "PLAN_PATH_NOTATION_REJECTED", retryable: false },
  { run: 38981512927, observation: observed({ executorFailureReason: "EXECUTION_FAILED" }), code: "EXECUTOR_EXECUTION_FAILED", retryable: true },
  { run: 38992157914, observation: observed({ executorFailureReason: "EXECUTION_FAILED" }), code: "EXECUTOR_EXECUTION_FAILED", retryable: true },
];

test("관측된 PLAN 실패 5건은 닫힌 코드로 분류되고 executor EXECUTION_FAILED만 재시도 대상이다", () => {
  for (const failure of OBSERVED_FAILURES) {
    assert.deepEqual(
      classifyPlanFailure(failure.observation),
      { code: failure.code, retryable: failure.retryable },
      `run ${failure.run}`,
    );
  }
});

test("executor 사유는 exact marker 값만 코드로 바꾸고 모르는 값은 UNKNOWN으로 멈춘다", () => {
  assert.deepEqual(classifyPlanFailure(observed({ executorFailureReason: "REQUEST_REJECTED" })), { code: "EXECUTOR_REQUEST_REJECTED", retryable: false });
  assert.deepEqual(classifyPlanFailure(observed({ executorFailureReason: "RESULT_POST_FAILED" })), { code: "EXECUTOR_RESULT_POST_FAILED", retryable: false });
  assert.deepEqual(classifyPlanFailure(observed({ executorFailureReason: "execution_failed" })), { code: "UNKNOWN", retryable: false });
  assert.deepEqual(classifyPlanFailure(observed({ executorFailureReason: "EXECUTION_FAILED; rm -rf" })), { code: "UNKNOWN", retryable: false });
  // executor 사유가 있으면 검증 사유보다 먼저 본다(resolve job도 FAILED marker를 먼저 본다).
  assert.deepEqual(
    classifyPlanFailure(observed({ executorFailureReason: "EXECUTION_FAILED", validationFailureReason: "Error: anything" })),
    { code: "EXECUTOR_EXECUTION_FAILED", retryable: true },
  );
});

test("trusted 검증 거부·timeout·request 실패·원인 불명은 모두 STOP이 기본이다", () => {
  assert.deepEqual(
    classifyPlanFailure(observed({ validationFailureReason: "Error: PLAN scope cannot hold existing tests within 8 bounded paths (changed 7 + impacted tests 3 = 10)" })),
    { code: "PLAN_SCOPE_TOO_LARGE", retryable: false },
  );
  assert.deepEqual(classifyPlanFailure(observed({ validationFailureReason: "Error: PLAN schema mismatch" })), { code: "PLAN_VALIDATION_REJECTED", retryable: false });
  assert.deepEqual(classifyPlanFailure(observed({ resultTimedOut: "true" })), { code: "PLAN_RESULT_TIMEOUT", retryable: false });
  assert.deepEqual(classifyPlanFailure(observed({ requestResult: "failure", resolveResult: "skipped" })), { code: "PLAN_REQUEST_FAILED", retryable: false });
  assert.deepEqual(classifyPlanFailure(observed()), { code: "UNKNOWN", retryable: false });
  assert.deepEqual(classifyPlanFailure(observed({ resolveResult: "success", executorFailureReason: "EXECUTION_FAILED" })), { code: "UNKNOWN", retryable: false });
});

test("marker는 (Issue, requirement digest) 키와 시도·코드·원 run을 고정된 모양으로 남긴다", () => {
  const marker = planRetryMarker(key, { attempt: 1, code: "EXECUTOR_EXECUTION_FAILED", sourceRunId: 38981512927, sourceRunAttempt: 1 });
  assert.equal(
    marker,
    "<!-- self-improvement:AUTO_PLAN_RETRY issue=2 requirement=38b54481347d8182895a8ce2a8e2c7d05a8af75f3cda691778c608819299ca59 attempt=1 code=EXECUTOR_EXECUTION_FAILED source-run=38981512927 source-attempt=1 -->",
  );
  assert.equal(
    planRetryStopMarker(key),
    "<!-- self-improvement:AUTO_PLAN_RETRY_STOP issue=2 requirement=38b54481347d8182895a8ce2a8e2c7d05a8af75f3cda691778c608819299ca59 -->",
  );
  assert.throws(() => planRetryMarker({ ...key, requirementDigest: "abc" }, { attempt: 1, code: "UNKNOWN", sourceRunId: 1, sourceRunAttempt: 1 }), /requirement digest is invalid/);
  assert.throws(() => planRetryMarker(key, { attempt: 0, code: "UNKNOWN", sourceRunId: 1, sourceRunAttempt: 1 }), /retry attempt/);
});

test("기록은 같은 키의 marker만 읽고 다른 Issue·다른 본문·깨진 marker는 무시한다", () => {
  const mine = planRetryMarker(key, { attempt: 1, code: "EXECUTOR_EXECUTION_FAILED", sourceRunId: 38981512927, sourceRunAttempt: 1 });
  const otherIssue = planRetryMarker({ ...key, issueNumber: 7 }, { attempt: 1, code: "EXECUTOR_EXECUTION_FAILED", sourceRunId: 38992157914, sourceRunAttempt: 1 });
  const otherBody = planRetryMarker({ ...key, requirementDigest: "0".repeat(64) }, { attempt: 1, code: "EXECUTOR_EXECUTION_FAILED", sourceRunId: 1, sourceRunAttempt: 1 });
  const bodies = [
    `${mine}\r\n\r\n## PLAN 자동 재시도 (1/2)`,
    otherIssue,
    otherBody,
    "<!-- self-improvement:AUTO_PLAN_RETRY issue=2 requirement=38b54481347d8182895a8ce2a8e2c7d05a8af75f3cda691778c608819299ca59 attempt=x code=EXECUTOR_EXECUTION_FAILED source-run=1 source-attempt=1 -->",
    "## PLAN 실패 (게시된 PLAN 없음)",
  ];
  assert.deepEqual(parsePlanRetryRecords(bodies, key), [
    { attempt: 1, code: "EXECUTOR_EXECUTION_FAILED", sourceRunId: 38981512927, sourceRunAttempt: 1 },
  ]);
});

test("재시도 판정: 켜져 있고 재시도 가능하고 예산 안이고 같은 코드가 처음일 때만 dispatch한다", () => {
  const retryable = { code: "EXECUTOR_EXECUTION_FAILED" as const, retryable: true };
  const first: PlanRetryRecord = { attempt: 1, code: "EXECUTOR_EXECUTION_FAILED", sourceRunId: 100, sourceRunAttempt: 1 };

  assert.deepEqual(decidePlanRetry({ enabled: true, classification: retryable, priorRecords: [], sourceRunId: 100 }), { outcome: "RETRY", attempt: 1 });
  assert.deepEqual(decidePlanRetry({ enabled: false, classification: retryable, priorRecords: [], sourceRunId: 100 }), { outcome: "DISABLED", attempt: 1 });
  assert.deepEqual(
    decidePlanRetry({ enabled: true, classification: { code: "PLAN_PATH_NOTATION_REJECTED", retryable: false }, priorRecords: [], sourceRunId: 100 }),
    { outcome: "NOT_RETRYABLE", attempt: 1 },
  );
  // auto_retry job을 같은 실패 run에서 다시 실행해도 두 번 dispatch하지 않는다.
  assert.deepEqual(decidePlanRetry({ enabled: true, classification: retryable, priorRecords: [first], sourceRunId: 100 }), { outcome: "ALREADY_DISPATCHED", attempt: 2 });
  // 같은 사유 코드가 두 번이면 예산이 남아도 멈춘다.
  assert.deepEqual(decidePlanRetry({ enabled: true, classification: retryable, priorRecords: [first], sourceRunId: 101 }), { outcome: "SAME_CODE_REPEATED", attempt: 2 });
  // 예산 상한은 코드와 무관하게 2회다.
  const two: PlanRetryRecord[] = [first, { attempt: 2, code: "UNKNOWN", sourceRunId: 101, sourceRunAttempt: 1 }];
  assert.equal(MAX_AUTO_PLAN_RETRY_PER_REQUIREMENT, 2);
  assert.deepEqual(
    decidePlanRetry({ enabled: true, classification: { code: "PLAN_VALIDATION_REJECTED", retryable: true }, priorRecords: two, sourceRunId: 102 }),
    { outcome: "BUDGET_EXHAUSTED", attempt: 3 },
  );
});
