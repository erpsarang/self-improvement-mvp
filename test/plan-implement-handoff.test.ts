import assert from "node:assert/strict";
import test from "node:test";
import { createPlanAuthorizeArtifact, type PlanAuthorizeArtifact } from "../src/self-improvement/plan-authorization.js";
import {
  createPlanImplementContract,
  createPlanImplementHandoffManifest,
  PLAN_IMPLEMENT_MAX_CONTEXT_BYTES,
  PLAN_IMPLEMENT_MAX_PATCH_BYTES,
  planImplementHandoffArtifactName,
  validatePlanAuthorizeSource,
  verifyPlanAuthorizeArtifact,
  type PlanAuthorizeSourceRun,
} from "../src/self-improvement/plan-implement-handoff.js";

const targetSha = "b".repeat(40);

function authorization(): PlanAuthorizeArtifact {
  return createPlanAuthorizeArtifact({
    normalizedPlan: {
      requirement: { issueNumber: 83, digest: "a".repeat(64) },
      repository: "erpsarang/self-improvement-mvp",
      targetSha,
      plan: {
        runId: 34727609462,
        runAttempt: 2,
        artifact: {
          name: "plan-issue-83-34727609462-attempt-2",
          id: 10308880882,
          digest: "c".repeat(64),
        },
        provenanceArtifact: { name: "", id: 0, digest: "" },
      },
    },
    provenanceArtifact: {
      name: "plan-issue-83-34727609462-attempt-2-provenance",
      id: 10308236589,
      digest: "d".repeat(64),
    },
    currentRequirementDigest: "a".repeat(64),
    currentTargetSha: targetSha,
    approvalCommentId: 5649698571,
    approverUserId: 8370921,
    authorizationRunId: 34728260819,
    authorizationRunAttempt: 1,
  });
}

function source(overrides: Partial<PlanAuthorizeSourceRun> = {}): PlanAuthorizeSourceRun {
  return {
    id: 34728260819,
    runAttempt: 1,
    repository: "erpsarang/self-improvement-mvp",
    workflowPath: ".github/workflows/plan-authorize.yml",
    event: "issue_comment",
    conclusion: "success",
    headBranch: "main",
    defaultBranch: "main",
    headSha: targetSha,
    currentDefaultSha: targetSha,
    ...overrides,
  };
}

const readyPlan = {
  questions: [],
  implementationScope: {
    ready: true,
    allowedPaths: [
      "src/self-improvement/human-status.ts",
      ".github/workflows/plan.yml",
      "test/human-status.test.ts",
    ],
    requiredChanges: [
      "6개 HumanStatus의 현재 상황과 다음 행동을 한국어로 반환한다",
      "PLAN 출력에 사람용 상태 요약을 연결한다",
    ],
    forbiddenChanges: [
      "Trust Boundary 변경 금지",
      "Auto Merge 추가 금지",
    ],
    validationCommands: ["npm test"],
  },
};

function canonicalPlanArtifact(
  plan: Record<string, unknown> = readyPlan,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: "untrusted-plan",
    repository: "erpsarang/self-improvement-mvp",
    sha: targetSha,
    requirement: "Framework 실행 상태를 사람이 이해하기 쉬운 한국어로 표시",
    context: {
      digestAlgorithm: "sha256",
      digest: "9".repeat(64),
      evidence: [],
      totalBytes: 1234,
    },
    plan,
    ...overrides,
  };
}

test("canonical PLAN.json wrapper와 ready scope를 deterministic ImplementContract로 변환한다", () => {
  const approved = authorization();
  assert.doesNotThrow(() => verifyPlanAuthorizeArtifact(approved));
  assert.doesNotThrow(() => validatePlanAuthorizeSource(approved, source()));

  const contract = createPlanImplementContract(approved, canonicalPlanArtifact());
  assert.equal(contract.baseSha, targetSha);
  assert.equal(contract.requirement.issueNumber, 83);
  assert.equal(contract.approvedPlan.runId, 34727609462);
  assert.equal(contract.approvedPlan.runAttempt, 2);
  assert.equal(contract.approval.commentId, 5649698571);
  assert.equal(contract.scope.maxFilesChanged, 3);
  assert.equal(contract.scope.maxContextBytes, PLAN_IMPLEMENT_MAX_CONTEXT_BYTES);
  assert.equal(contract.scope.maxPatchBytes, PLAN_IMPLEMENT_MAX_PATCH_BYTES);
  assert.deepEqual(contract.scope.requiredChanges, readyPlan.implementationScope.requiredChanges);
  assert.deepEqual(contract.scope.forbiddenChanges, readyPlan.implementationScope.forbiddenChanges);
  assert.deepEqual(contract.scope.validationCommands, ["npm test"]);
  assert.match(contract.contractDigest, /^[0-9a-f]{64}$/);
});

test("source workflow/run/SHA/default HEAD가 exact approval과 다르면 fail-closed 한다", () => {
  const approved = authorization();
  assert.throws(
    () => validatePlanAuthorizeSource(approved, source({ workflowPath: ".github/workflows/authorize.yml" })),
    /source workflow/,
  );
  assert.throws(
    () => validatePlanAuthorizeSource(approved, source({ runAttempt: 2 })),
    /run identity/,
  );
  assert.throws(
    () => validatePlanAuthorizeSource(approved, source({ currentDefaultSha: "e".repeat(40) })),
    /re-plan required/,
  );
});

test("PLAN_AUTHORIZE artifact 위변조를 digest 검증에서 거부한다", () => {
  const approved = authorization();
  const forged = { ...approved, targetSha: "e".repeat(40) };
  assert.throws(() => verifyPlanAuthorizeArtifact(forged), /digest mismatch/);
});

test("production handoff는 bare payload나 malformed canonical wrapper를 거부한다", () => {
  const approved = authorization();
  assert.throws(
    () => createPlanImplementContract(approved, readyPlan),
    /wrapper shape/,
  );
  assert.throws(
    () => createPlanImplementContract(approved, { ...canonicalPlanArtifact(), plan: undefined }),
    /plan is invalid/,
  );
  assert.throws(
    () => createPlanImplementContract(approved, canonicalPlanArtifact(readyPlan, { repository: "other/repo" })),
    /repository mismatch/,
  );
  assert.throws(
    () => createPlanImplementContract(approved, canonicalPlanArtifact(readyPlan, { sha: "e".repeat(40) })),
    /SHA mismatch/,
  );
  assert.throws(
    () => createPlanImplementContract(approved, { ...canonicalPlanArtifact(), extra: true }),
    /wrapper shape/,
  );
});

test("ready=false, blocking question, unsafe scope와 비허용 검증 명령은 handoff하지 않는다", () => {
  const approved = authorization();
  assert.throws(
    () => createPlanImplementContract(
      approved,
      canonicalPlanArtifact({ ...readyPlan, implementationScope: { ...readyPlan.implementationScope, ready: false } }),
    ),
    /not ready/,
  );
  assert.throws(
    () => createPlanImplementContract(approved, canonicalPlanArtifact({ ...readyPlan, questions: ["결정 필요"] })),
    /blocking questions/,
  );
  assert.throws(
    () => createPlanImplementContract(
      approved,
      canonicalPlanArtifact({
        ...readyPlan,
        implementationScope: { ...readyPlan.implementationScope, allowedPaths: ["../secret"] },
      }),
    ),
    /unsafe approved PLAN path/,
  );
  assert.throws(
    () => createPlanImplementContract(
      approved,
      canonicalPlanArtifact({
        ...readyPlan,
        implementationScope: { ...readyPlan.implementationScope, validationCommands: ["npm install"] },
      }),
    ),
    /untrusted approved validation command/,
  );
});

test("handoff identity는 approval, Contract, Context digest에 결합된다", () => {
  const approved = authorization();
  const contract = createPlanImplementContract(approved, canonicalPlanArtifact());
  const sourceArtifact = {
    name: "plan-authorize-issue-83-plan-34727609462-attempt-2-approval-5649698571-run-34728260819-attempt-1",
    id: 10309140730,
    digest: "e".repeat(64),
  };
  const first = createPlanImplementHandoffManifest({
    authorization: approved,
    sourceArtifact,
    contract,
    contextDigest: "f".repeat(64),
  });
  const second = createPlanImplementHandoffManifest({
    authorization: approved,
    sourceArtifact,
    contract,
    contextDigest: "f".repeat(64),
  });
  assert.deepEqual(first, second);
  assert.equal(first.sourcePlanAuthorize.runId, 34728260819);
  assert.equal(first.approvalCommentId, 5649698571);
  assert.equal(first.contractDigest, contract.contractDigest);
  assert.match(first.handoffDigest, /^[0-9a-f]{64}$/);
  assert.equal(
    planImplementHandoffArtifactName(approved),
    "plan-implement-handoff-issue-83-plan-34727609462-attempt-2-approval-5649698571",
  );
});
