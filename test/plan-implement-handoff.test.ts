import assert from "node:assert/strict";
import test from "node:test";
import { createPlanAuthorizeArtifact, requirementDigest, type PlanAuthorizeArtifact } from "../src/self-improvement/plan-authorization.js";
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
const requirementSnapshot = {
  title: "Framework 실행 상태를 사람이 이해하기 쉬운 한국어로 표시",
  body: "approved Requirement body",
} as const;
const approvedRequirementDigest = requirementDigest(requirementSnapshot.title, requirementSnapshot.body);

function authorization(): PlanAuthorizeArtifact {
  return createPlanAuthorizeArtifact({
    normalizedPlan: {
      requirement: { issueNumber: 83, digest: approvedRequirementDigest },
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
    currentRequirementDigest: approvedRequirementDigest,
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
  approach: [
    "HumanStatus별 고정 한국어 문구를 사용한다",
    "PLAN 출력에는 승인된 문구만 연결한다",
  ],
  implementationScope: {
    ready: true,
    allowedPaths: [
      "src/self-improvement/human-status.ts",
      ".github/workflows/plan.yml",
      "test/human-status.test.ts",
    ],
    contextPaths: ["src/self-improvement/implement-contract.ts"],
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

  const contract = createPlanImplementContract(approved, canonicalPlanArtifact(), requirementSnapshot);
  assert.equal(contract.baseSha, targetSha);
  assert.equal(contract.requirement.issueNumber, 83);
  assert.deepEqual(contract.requirementSnapshot, requirementSnapshot);
  assert.equal(contract.approvedPlan.runId, 34727609462);
  assert.equal(contract.approvedPlan.runAttempt, 2);
  assert.equal(contract.approval.commentId, 5649698571);
  assert.equal(contract.scope.maxFilesChanged, 3);
  assert.deepEqual(contract.scope.contextPaths, ["src/self-improvement/implement-contract.ts"]);
  assert.equal(contract.scope.maxContextBytes, PLAN_IMPLEMENT_MAX_CONTEXT_BYTES);
  assert.equal(contract.scope.maxPatchBytes, PLAN_IMPLEMENT_MAX_PATCH_BYTES);
  assert.deepEqual(contract.scope.requiredChanges, [
    ...readyPlan.implementationScope.requiredChanges,
    ...readyPlan.approach.map((item) => `승인된 PLAN approach: ${item}`),
  ]);
  assert.deepEqual(contract.scope.forbiddenChanges, readyPlan.implementationScope.forbiddenChanges);
  assert.deepEqual(contract.scope.validationCommands, ["npm test"]);
  assert.match(contract.contractDigest, /^[0-9a-f]{64}$/);
});


test("approved Requirement snapshot이 digest와 다르면 re-plan required로 fail-closed 한다", () => {
  const approved = authorization();
  assert.throws(
    () => createPlanImplementContract(
      approved,
      canonicalPlanArtifact(),
      { title: requirementSnapshot.title, body: "changed after approval" },
    ),
    /requirementSnapshot digest mismatch; re-plan required/,
  );
});

test("package.json 변경 승인에는 package-lock.json을 deterministic companion으로 결합한다", () => {
  const approved = authorization();
  const webPlan = {
    ...readyPlan,
    approach: ["Vite 기반 Web 화면을 추가한다"],
    implementationScope: {
      ...readyPlan.implementationScope,
      allowedPaths: ["package.json", "src/web/main.ts"],
      requiredChanges: ["Vite 개발 의존성과 Web 진입점을 추가한다"],
      validationCommands: ["npm test", "npm run build"],
    },
  };

  const contract = createPlanImplementContract(approved, canonicalPlanArtifact(webPlan), requirementSnapshot);

  assert.deepEqual(contract.scope.allowedPaths, [
    "package-lock.json",
    "package.json",
    "src/web/main.ts",
  ]);
  assert.equal(contract.scope.maxFilesChanged, 3);
  assert.ok(contract.scope.requiredChanges.includes(
    "package.json을 변경하더라도 package-lock.json은 작성하지 않는다. package-lock.json은 trusted deterministic step이 생성해 같은 candidate에 포함한다. 의존성은 npm registry의 semver 버전으로만 지정한다.",
  ));
});

test("package.json companion이 8-file bounded scope를 넘기면 fail-closed 한다", () => {
  const approved = authorization();
  const saturatedPlan = {
    ...readyPlan,
    implementationScope: {
      ...readyPlan.implementationScope,
      allowedPaths: [
        "package.json",
        "src/a.ts",
        "src/b.ts",
        "src/c.ts",
        "src/d.ts",
        "src/e.ts",
        "src/f.ts",
        "src/g.ts",
      ],
    },
  };

  assert.throws(
    () => createPlanImplementContract(approved, canonicalPlanArtifact(saturatedPlan), requirementSnapshot),
    /package-lock\.json within bounded scope/,
  );
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
    () => createPlanImplementContract(approved, readyPlan, requirementSnapshot),
    /wrapper shape/,
  );
  assert.throws(
    () => createPlanImplementContract(approved, { ...canonicalPlanArtifact(), plan: undefined }, requirementSnapshot),
    /plan is invalid/,
  );
  assert.throws(
    () => createPlanImplementContract(approved, canonicalPlanArtifact(readyPlan, { repository: "other/repo" }), requirementSnapshot),
    /repository mismatch/,
  );
  assert.throws(
    () => createPlanImplementContract(approved, canonicalPlanArtifact(readyPlan, { sha: "e".repeat(40) }), requirementSnapshot),
    /SHA mismatch/,
  );
  assert.throws(
    () => createPlanImplementContract(approved, { ...canonicalPlanArtifact(), extra: true }, requirementSnapshot),
    /wrapper shape/,
  );
});

test("approved PLAN approach는 bounded 문자열 배열만 handoff한다", () => {
  const approved = authorization();
  assert.throws(
    () => createPlanImplementContract(
      approved,
      canonicalPlanArtifact({ ...readyPlan, approach: undefined }),
      requirementSnapshot,
    ),
    /invalid approach/,
  );
  assert.throws(
    () => createPlanImplementContract(
      approved,
      canonicalPlanArtifact({ ...readyPlan, approach: ["정상 지침", 1] }),
      requirementSnapshot,
    ),
    /invalid approach/,
  );
  assert.throws(
    () => createPlanImplementContract(
      approved,
      canonicalPlanArtifact({ ...readyPlan, approach: Array.from({ length: 9 }, (_, index) => `지침-${index}`) }),
      requirementSnapshot,
    ),
    /approach exceeds/,
  );
});

test("ready=false, blocking question, unsafe scope와 비허용 검증 명령은 handoff하지 않는다", () => {
  const approved = authorization();
  assert.throws(
    () => createPlanImplementContract(
      approved,
      canonicalPlanArtifact({ ...readyPlan, implementationScope: { ...readyPlan.implementationScope, ready: false } }),
      requirementSnapshot,
    ),
    /not ready/,
  );
  assert.throws(
    () => createPlanImplementContract(approved, canonicalPlanArtifact({ ...readyPlan, questions: ["결정 필요"] }), requirementSnapshot),
    /blocking questions/,
  );
  assert.throws(
    () => createPlanImplementContract(
      approved,
      canonicalPlanArtifact({
        ...readyPlan,
        implementationScope: { ...readyPlan.implementationScope, allowedPaths: ["../secret"] },
      }),
      requirementSnapshot,
    ),
    /unsafe approved PLAN path/,
  );
  assert.throws(
    () => createPlanImplementContract(
      approved,
      canonicalPlanArtifact({
        ...readyPlan,
        implementationScope: { ...readyPlan.implementationScope, contextPaths: ["../secret"] },
      }),
      requirementSnapshot,
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
      requirementSnapshot,
    ),
    /untrusted approved validation command/,
  );
});

test("handoff identity는 approval, Contract, Context digest에 결합된다", () => {
  const approved = authorization();
  const contract = createPlanImplementContract(approved, canonicalPlanArtifact(), requirementSnapshot);
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
