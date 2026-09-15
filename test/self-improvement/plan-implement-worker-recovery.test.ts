import assert from "node:assert/strict";
import test from "node:test";
import {
  createPlanAuthorizeArtifact,
  type PlanAuthorizeArtifact,
} from "../../src/self-improvement/plan-authorization.js";
import { planImplementHandoffArtifactName } from "../../src/self-improvement/plan-implement-handoff.js";
import {
  validatePlanImplementWorkerSource,
  type HandoffArtifactMetadata,
  type PlanImplementWorkerBundle,
  type PlanImplementWorkerSourceRun,
} from "../../src/self-improvement/plan-implement-worker.js";

const baseSha = "b".repeat(40);
const currentSha = "c".repeat(40);

function authorization(): PlanAuthorizeArtifact {
  return createPlanAuthorizeArtifact({
    normalizedPlan: {
      requirement: { issueNumber: 83, digest: "a".repeat(64) },
      repository: "erpsarang/self-improvement-mvp",
      targetSha: baseSha,
      plan: {
        runId: 34730034257,
        runAttempt: 1,
        artifact: {
          name: "plan-issue-83-34730034257-attempt-1",
          id: 10308609510,
          digest: "c".repeat(64),
        },
        provenanceArtifact: { name: "", id: 0, digest: "" },
      },
    },
    provenanceArtifact: {
      name: "plan-issue-83-34730034257-attempt-1-provenance",
      id: 10308699321,
      digest: "d".repeat(64),
    },
    currentRequirementDigest: "a".repeat(64),
    currentTargetSha: baseSha,
    approvalCommentId: 5649914569,
    approverUserId: 8370921,
    authorizationRunId: 34730287415,
    authorizationRunAttempt: 1,
  });
}

const approved = authorization();
const bundle = {
  contract: {
    repository: approved.repository,
    baseSha,
  },
  authorization: approved,
} as unknown as PlanImplementWorkerBundle;

const artifact: HandoffArtifactMetadata = {
  name: planImplementHandoffArtifactName(approved),
  id: 10308809422,
  digest: "f".repeat(64),
};

function source(overrides: Partial<PlanImplementWorkerSourceRun> = {}): PlanImplementWorkerSourceRun {
  return {
    id: 34730300737,
    runAttempt: 1,
    repository: approved.repository,
    workflowName: "Trusted PLAN IMPLEMENT Handoff",
    workflowPath: ".github/workflows/plan-implement-handoff.yml",
    event: "workflow_run",
    conclusion: "success",
    headBranch: "main",
    defaultBranch: "main",
    headSha: baseSha,
    currentDefaultSha: currentSha,
    ...overrides,
  };
}

test("일반 Handoff 검증은 default 이동을 계속 re-plan 처리한다", () => {
  assert.throws(
    () => validatePlanImplementWorkerSource(bundle, source(), artifact),
    /default branch moved after handoff; re-plan required/,
  );
});

test("recovery Handoff는 exact trusted guard가 base/current SHA를 모두 고정할 때만 허용한다", () => {
  assert.doesNotThrow(() => validatePlanImplementWorkerSource(bundle, source(), artifact, {
    kind: "trusted-recovery-compare-v1",
    baseSha,
    currentDefaultSha: currentSha,
  }));

  assert.throws(() => validatePlanImplementWorkerSource(bundle, source(), artifact, {
    kind: "trusted-recovery-compare-v1",
    baseSha: "d".repeat(40),
    currentDefaultSha: currentSha,
  }), /re-plan required/);

  assert.throws(() => validatePlanImplementWorkerSource(bundle, source(), artifact, {
    kind: "trusted-recovery-compare-v1",
    baseSha,
    currentDefaultSha: "e".repeat(40),
  }), /re-plan required/);
});

test("valid recovery guard도 Handoff source exact identity 검증은 완화하지 않는다", () => {
  assert.throws(() => validatePlanImplementWorkerSource(
    bundle,
    source({ workflowPath: ".github/workflows/implement.yml" }),
    artifact,
    {
      kind: "trusted-recovery-compare-v1",
      baseSha,
      currentDefaultSha: currentSha,
    },
  ), /unexpected source handoff workflow/);
});
