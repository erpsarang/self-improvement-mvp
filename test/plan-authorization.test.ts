import assert from "node:assert/strict";
import test from "node:test";
import {
  assertExactPlanApproval,
  assertHumanApprover,
  createPlanAuthorizeArtifact,
  normalizePlanProvenance,
  planAuthorizeArtifactName,
  requirementDigest,
  toApprovedPlanIdentity,
  type RawPlanProvenance,
} from "../src/self-improvement/plan-authorization.js";

const provenance: RawPlanProvenance = {
  schemaVersion: 1,
  kind: "untrusted-plan-provenance",
  requirement: { issueNumber: 62, digest: "a".repeat(64) },
  repository: "erpsarang/self-improvement-mvp",
  targetSha: "b".repeat(40),
  workflow: { runId: "1234", runAttempt: "2" },
  artifactName: "plan-issue-62-1234-attempt-2",
  artifact: {
    name: "plan-issue-62-1234-attempt-2",
    id: "77",
    digest: "c".repeat(64),
  },
};

const normalized = normalizePlanProvenance(provenance, {
  issueNumber: 62,
  repository: "erpsarang/self-improvement-mvp",
  runId: 1234,
  runAttempt: 2,
  planArtifact: { name: "plan-issue-62-1234-attempt-2", id: 77, digest: `sha256:${"c".repeat(64)}` },
});

function createAuthorization() {
  return createPlanAuthorizeArtifact({
    normalizedPlan: normalized,
    provenanceArtifact: {
      name: "plan-issue-62-1234-attempt-2-provenance",
      id: 78,
      digest: `sha256:${"d".repeat(64)}`,
    },
    currentRequirementDigest: "a".repeat(64),
    currentTargetSha: "b".repeat(40),
    approvalCommentId: 9001,
    approverUserId: 8370921,
    authorizationRunId: 5678,
    authorizationRunAttempt: 1,
  });
}

test("exact PLAN-승인과 Human actor만 승인한다", () => {
  assert.doesNotThrow(() => assertExactPlanApproval("PLAN-승인"));
  assert.throws(() => assertExactPlanApproval(" PLAN-승인"), /exact PLAN-승인/);
  assert.doesNotThrow(() => assertHumanApprover("User", 8370921));
  assert.throws(() => assertHumanApprover("Bot", 1), /human GitHub user/);
});

test("PLAN provenance의 exact run/artifact identity를 정규화한다", () => {
  assert.equal(normalized.plan.runId, 1234);
  assert.equal(normalized.plan.runAttempt, 2);
  assert.equal(normalized.plan.artifact.id, 77);
  assert.equal(normalized.plan.artifact.digest, "c".repeat(64));
  assert.equal(normalized.requirement.issueNumber, 62);
});

test("requirement 또는 frozen target SHA가 바뀌면 fail-closed 한다", () => {
  assert.throws(() => createPlanAuthorizeArtifact({
    normalizedPlan: normalized,
    provenanceArtifact: { name: "p", id: 78, digest: "d".repeat(64) },
    currentRequirementDigest: "e".repeat(64),
    currentTargetSha: "b".repeat(40),
    approvalCommentId: 9001,
    approverUserId: 8370921,
    authorizationRunId: 5678,
    authorizationRunAttempt: 1,
  }), /re-plan required/);

  assert.throws(() => createPlanAuthorizeArtifact({
    normalizedPlan: normalized,
    provenanceArtifact: { name: "p", id: 78, digest: "d".repeat(64) },
    currentRequirementDigest: "a".repeat(64),
    currentTargetSha: "f".repeat(40),
    approvalCommentId: 9001,
    approverUserId: 8370921,
    authorizationRunId: 5678,
    authorizationRunAttempt: 1,
  }), /re-plan required/);
});

test("PLAN_AUTHORIZE는 deterministic digest와 downstream ApprovedPlanIdentity를 만든다", () => {
  const first = createAuthorization();
  const second = createAuthorization();
  assert.deepEqual(first, second);
  assert.match(first.authorizationDigest, /^[0-9a-f]{64}$/);
  assert.equal(first.plan.provenanceArtifact.id, 78);
  assert.deepEqual(toApprovedPlanIdentity(first), {
    requirement: first.requirement,
    repository: first.repository,
    targetSha: first.targetSha,
    plan: first.plan,
    approval: first.approval,
  });
  assert.equal(
    planAuthorizeArtifactName(first),
    "plan-authorize-issue-62-plan-1234-attempt-2-approval-9001-run-5678-attempt-1",
  );
});

test("requirement digest는 PLAN workflow와 같은 JSON.stringify([title, body]) 규칙을 사용한다", () => {
  assert.equal(requirementDigest("제목", "본문"), requirementDigest("제목", "본문"));
  assert.notEqual(requirementDigest("제목", "본문"), requirementDigest("제목", "본문 변경"));
});
