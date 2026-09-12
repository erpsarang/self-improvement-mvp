import assert from "node:assert/strict";
import test from "node:test";
import {
  createImplementContract,
  implementContractArtifactName,
  verifyImplementContract,
  type ApprovedPlanIdentity,
} from "../src/self-improvement/implement-contract.js";

const identity: ApprovedPlanIdentity = {
  requirement: { issueNumber: 62, digest: "a".repeat(64) },
  repository: "erpsarang/self-improvement-mvp",
  targetSha: "b".repeat(40),
  plan: {
    runId: 1234,
    runAttempt: 2,
    artifact: { name: "plan-issue-62-1234-attempt-2", id: 77, digest: "c".repeat(64) },
    provenanceArtifact: { name: "plan-issue-62-1234-attempt-2-provenance", id: 78, digest: "d".repeat(64) },
  },
  approval: { commentId: 9001, approverUserId: 8370921 },
};

const scope = {
  allowedPaths: ["test/plan-authorize.test.ts", "src/self-improvement/plan-authorize.ts"],
  requiredChanges: ["exact PLAN identity를 trusted하게 결합한다"],
  forbiddenChanges: ["Auto Merge 금지"],
  validationCommands: ["npm test", "npm run build"],
  maxFilesChanged: 2,
  maxPatchBytes: 200000,
} as const;

test("approved PLAN identity와 frozen SHA를 deterministic IMPLEMENT contract로 고정한다", () => {
  const first = createImplementContract(identity, scope);
  const second = createImplementContract(identity, scope);

  assert.deepEqual(first, second);
  assert.equal(first.baseSha, identity.targetSha);
  assert.deepEqual(first.requirement, identity.requirement);
  assert.deepEqual(first.approvedPlan, identity.plan);
  assert.deepEqual(first.approval, identity.approval);
  assert.equal(first.scope.allowedPaths[0], "src/self-improvement/plan-authorize.ts");
  assert.match(first.contractDigest, /^[0-9a-f]{64}$/);
  assert.doesNotThrow(() => verifyImplementContract(first));
});

test("PLAN identity 또는 scope가 바뀌면 contract digest가 달라진다", () => {
  const original = createImplementContract(identity, scope);
  const changedPlan = createImplementContract({ ...identity, plan: { ...identity.plan, runAttempt: 3 } }, scope);
  const changedScope = createImplementContract(identity, { ...scope, requiredChanges: ["다른 변경"] });

  assert.notEqual(original.contractDigest, changedPlan.contractDigest);
  assert.notEqual(original.contractDigest, changedScope.contractDigest);
});

test("contract 위변조는 digest 검증에서 fail-closed 한다", () => {
  const contract = createImplementContract(identity, scope);
  const forged = { ...contract, baseSha: "e".repeat(40) };
  assert.throws(() => verifyImplementContract(forged), /digest mismatch/);
});

test("unsafe path와 change budget 초과를 거부한다", () => {
  assert.throws(() => createImplementContract(identity, { ...scope, allowedPaths: ["../secret"], maxFilesChanged: 1 }), /unsafe allowed path/);
  assert.throws(() => createImplementContract(identity, { ...scope, maxFilesChanged: 3 }), /cannot exceed allowedPaths length/);
});

test("artifact 이름도 exact PLAN run/attempt와 Human approval identity에 결합한다", () => {
  assert.equal(
    implementContractArtifactName(identity),
    "implement-contract-issue-62-plan-1234-attempt-2-approval-9001",
  );
});
