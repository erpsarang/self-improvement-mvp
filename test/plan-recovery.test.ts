import assert from "node:assert/strict";
import test from "node:test";
import { createPlanAuthorizeArtifact } from "../src/self-improvement/plan-authorization.js";
import {
  classifyPlanRecovery,
  countAutomaticPlanRecoveries,
  MAX_AUTO_REPLAN_PER_AUTHORIZATION,
  planRecoveryBudgetStopMarker,
  planRecoveryMarker,
  type PlanRunObservation,
} from "../src/self-improvement/plan-recovery.js";

const targetSha = "a".repeat(40);

function authorization() {
  return createPlanAuthorizeArtifact({
    normalizedPlan: {
      requirement: { issueNumber: 57, digest: "b".repeat(64) },
      repository: "erpsarang/sales-order-exception-analyzer",
      targetSha,
      plan: {
        runId: 35419847754,
        runAttempt: 2,
        artifact: {
          name: "plan-issue-57-35419847754-attempt-2",
          id: 10577623562,
          digest: "c".repeat(64),
        },
        provenanceArtifact: { name: "", id: 0, digest: "" },
      },
    },
    provenanceArtifact: {
      name: "plan-issue-57-35419847754-attempt-2-provenance",
      id: 10577897979,
      digest: "d".repeat(64),
    },
    currentRequirementDigest: "b".repeat(64),
    currentTargetSha: targetSha,
    approvalCommentId: 5739393840,
    approverUserId: 8370921,
    authorizationRunId: 35421839292,
    authorizationRunAttempt: 1,
  });
}

function planRun(overrides: Partial<PlanRunObservation> = {}): PlanRunObservation {
  return {
    name: "Read-only AI PLAN",
    path: ".github/workflows/plan.yml",
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    runAttempt: 2,
    headBranch: "main",
    headSha: targetSha,
    ...overrides,
  };
}

test("exact PLAN identity와 current default가 같으면 recovery가 필요 없다", () => {
  assert.deepEqual(
    classifyPlanRecovery(authorization(), planRun(), "main", targetSha),
    { required: false, reason: "NONE" },
  );
});

test("default branch가 승인 target 이후 이동하면 fresh PLAN recovery를 요구한다", () => {
  assert.deepEqual(
    classifyPlanRecovery(authorization(), planRun(), "main", "e".repeat(40)),
    { required: true, reason: "DEFAULT_BRANCH_MOVED" },
  );
});

test("PLAN workflow control-plane SHA가 targetSha와 다르면 fresh PLAN recovery를 요구한다", () => {
  assert.deepEqual(
    classifyPlanRecovery(
      authorization(),
      planRun({ headSha: "f".repeat(40) }),
      "main",
      targetSha,
    ),
    { required: true, reason: "PLAN_CONTROL_PLANE_STALE" },
  );
});

test("workflow identity 이상은 자동 recovery하지 않고 fail-closed 한다", () => {
  const approved = authorization();
  assert.throws(
    () => classifyPlanRecovery(approved, planRun({ path: ".github/workflows/other.yml" }), "main", targetSha),
    /identity is invalid/,
  );
  assert.throws(
    () => classifyPlanRecovery(approved, planRun({ runAttempt: 3 }), "main", targetSha),
    /identity is invalid/,
  );
  assert.throws(
    () => classifyPlanRecovery(approved, planRun({ conclusion: "failure" }), "main", targetSha),
    /identity is invalid/,
  );
  assert.throws(
    () => classifyPlanRecovery(approved, planRun({ headBranch: "feature" }), "main", targetSha),
    /identity is invalid/,
  );
});


test("issues로 자동 시작된 PLAN도 workflow_dispatch PLAN과 같은 조건에서 정상 source로 인정한다", () => {
  assert.deepEqual(
    classifyPlanRecovery(authorization(), planRun({ event: "issues" }), "main", targetSha),
    { required: false, reason: "NONE" },
  );
});

test("issues PLAN에서도 기존 recovery 판정은 workflow_dispatch PLAN과 동일하다", () => {
  for (const event of ["workflow_dispatch", "issues"]) {
    assert.deepEqual(
      classifyPlanRecovery(authorization(), planRun({ event }), "main", "e".repeat(40)),
      { required: true, reason: "DEFAULT_BRANCH_MOVED" },
      event,
    );
    assert.deepEqual(
      classifyPlanRecovery(authorization(), planRun({ event, headSha: "f".repeat(40) }), "main", targetSha),
      { required: true, reason: "PLAN_CONTROL_PLANE_STALE" },
      event,
    );
  }
});

test("허용되지 않은 PLAN source event는 계속 fail-closed 한다", () => {
  const approved = authorization();
  for (const event of ["push", "pull_request", "issue_comment", "workflow_run", "schedule", "Issues", "issues ", ""]) {
    assert.throws(
      () => classifyPlanRecovery(approved, planRun({ event }), "main", targetSha),
      /identity is invalid/,
      JSON.stringify(event),
    );
  }
});

test("issues PLAN이어도 나머지 workflow identity 검증은 느슨해지지 않는다", () => {
  const approved = authorization();
  const issues = (overrides: Partial<PlanRunObservation>) => planRun({ event: "issues", ...overrides });
  const invalid: Array<Partial<PlanRunObservation>> = [
    { name: "Other workflow" },
    { path: ".github/workflows/other.yml" },
    { status: "in_progress" },
    { conclusion: "failure" },
    { conclusion: null },
    { runAttempt: 3 },
    { headBranch: "feature" },
  ];
  for (const overrides of invalid) {
    assert.throws(
      () => classifyPlanRecovery(approved, issues(overrides), "main", targetSha),
      /identity is invalid/,
      JSON.stringify(overrides),
    );
  }
  assert.throws(() => classifyPlanRecovery(approved, issues({ headSha: "not-a-sha" }), "main", targetSha), /head SHA is invalid/);
  assert.throws(() => classifyPlanRecovery(approved, issues({}), "main", "not-a-sha"), /current default SHA is invalid/);
  assert.throws(() => classifyPlanRecovery(approved, issues({}), " ", targetSha), /default branch missing/);
});

test("recovery marker는 authorization과 current default SHA에 결합된다", () => {
  const digest = "1".repeat(64);
  const first = planRecoveryMarker(digest, "2".repeat(40));
  const second = planRecoveryMarker(digest, "3".repeat(40));
  assert.notEqual(first, second);
  assert.match(first, /authorization-digest=1{64}/);
  assert.match(first, /target-sha=2{40}/);
  assert.throws(() => planRecoveryMarker("bad", "2".repeat(40)), /authorization digest/);
});


test("동일 authorization의 자동 re-PLAN은 최대 2회로 계수한다", () => {
  const digest = "4".repeat(64);
  const bodies = [
    planRecoveryMarker(digest, "5".repeat(40)),
    planRecoveryMarker(digest, "6".repeat(40)),
    planRecoveryMarker("7".repeat(64), "8".repeat(40)),
  ];
  assert.equal(MAX_AUTO_REPLAN_PER_AUTHORIZATION, 2);
  assert.equal(countAutomaticPlanRecoveries(bodies, digest), 2);
  assert.equal(countAutomaticPlanRecoveries([], digest), 0);
});

test("budget STOP marker는 authorization에만 결합되어 target SHA 변경에도 유지된다", () => {
  const digest = "9".repeat(64);
  const marker = planRecoveryBudgetStopMarker(digest);
  assert.match(marker, /AUTO_REPLAN_STOP/);
  assert.match(marker, /authorization-digest=9{64}/);
  assert.doesNotMatch(marker, /target-sha=/);
});
