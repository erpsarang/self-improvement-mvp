import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { FIX_REQUEST_WORKFLOW_PATH, FIX_WORKFLOW_PATH } from "../src/self-improvement/fix.js";
import { sha256 } from "../src/self-improvement/implement.js";
import {
  createPublishProvenance,
  publishBranchForSeal,
  validatePublishProvenance,
  validateSealedCandidateForPublish,
} from "../src/self-improvement/publish.js";
import {
  cyclePublishBranchName,
  isCyclePublishBranchForIssue,
  isPublishBranchForIssue,
  legacyPublishBranchName,
  publishCycleId,
} from "../src/self-improvement/publish-branch.js";
import { sealFixCandidate, type SealProvenance } from "../src/self-improvement/seal.js";

const baseSha = "a".repeat(40);
const trustedCodeSha = "b".repeat(40);
const publishedHeadSha = "c".repeat(40);
const patch = Buffer.from("diff --git a/a.txt b/a.txt\n");
const patchDigest = sha256(patch);

const seal: SealProvenance = {
  type: "SEAL",
  repository: "erpsarang/self-improvement-mvp",
  issueNumber: 17,
  baseSha,
  sourceAuthorization: {
    runId: 100,
    runAttempt: 1,
    approvalCommentId: 200,
    policySnapshot: `sha256:${"1".repeat(64)}`,
    requirementsDigest: `sha256:${"2".repeat(64)}`,
    authorizedBaseSha: baseSha,
  },
  sourceImplement: {
    workflowPath: ".github/workflows/implement.yml",
    runId: 300,
    runAttempt: 1,
    controlPlaneSha: baseSha,
    candidateArtifactName: "implement-candidate-100-300-attempt-1",
    candidatePatchDigest: patchDigest,
    aiExecution: {
      provider: "openai-codex-action",
      resultId: "codex-action-run:300:1",
    },
  },
  sealWorkflow: {
    workflowPath: ".github/workflows/trusted-rail.yml",
    runId: 400,
    runAttempt: 1,
    trustedCodeSha,
  },
  sealedPatchDigest: patchDigest,
};

const artifactName = "sealed-candidate-300-attempt-1-400-attempt-1";

test("sealed artifact는 digest와 run identity가 일치할 때만 PUBLISH 입력으로 승인된다", () => {
  const validated = validateSealedCandidateForPublish({
    seal,
    sealedPatch: patch,
    sealedArtifactName: artifactName,
    repository: seal.repository,
  });
  assert.equal(validated.issueNumber, 17);
  assert.equal(validated.baseSha, baseSha);
});

test("sealed patch bytes가 바뀌면 PUBLISH를 거부한다", () => {
  assert.throws(
    () =>
      validateSealedCandidateForPublish({
        seal,
        sealedPatch: Buffer.from("tampered"),
        sealedArtifactName: artifactName,
        repository: seal.repository,
      }),
    /sealed patch digest/,
  );
});

test("sealed artifact 이름의 run identity가 provenance와 다르면 거부한다", () => {
  assert.throws(
    () =>
      validateSealedCandidateForPublish({
        seal,
        sealedPatch: patch,
        sealedArtifactName: "sealed-candidate-300-attempt-1-999-attempt-1",
        repository: seal.repository,
      }),
    /artifact identity/,
  );
});

const expectedCycle = createHash("sha256").update(`${baseSha}:${patchDigest}`, "utf8").digest("hex").slice(0, 16);

test("새 PUBLISH branch는 trusted SEAL의 baseSha + sealedPatchDigest cycle identity를 쓴다", () => {
  assert.equal(publishCycleId(baseSha, patchDigest), expectedCycle);
  assert.equal(publishBranchForSeal(seal), `ai-publish/issue-17-cycle-${expectedCycle}`);
  assert.equal(cyclePublishBranchName(17, baseSha, patchDigest), `ai-publish/issue-17-cycle-${expectedCycle}`);
  assert.throws(() => cyclePublishBranchName(0, baseSha, patchDigest), /양의 정수/);
  assert.throws(() => publishCycleId("A".repeat(40), patchDigest), /baseSha/);
  assert.throws(() => publishCycleId(baseSha, "1".repeat(64)), /sealedPatchDigest/);
});

test("같은 cycle 재시도는 같은 branch, 같은 Issue의 다른 slice는 다른 branch를 쓴다 (#250)", () => {
  const retry: SealProvenance = { ...seal, sealWorkflow: { ...seal.sealWorkflow, runAttempt: 2 } };
  assert.equal(publishBranchForSeal(retry), publishBranchForSeal(seal));

  const otherBase: SealProvenance = { ...seal, baseSha: "d".repeat(40) };
  const otherPatch: SealProvenance = { ...seal, sealedPatchDigest: sha256(Buffer.from("other slice")) };
  const branches = new Set([publishBranchForSeal(seal), publishBranchForSeal(otherBase), publishBranchForSeal(otherPatch)]);
  assert.equal(branches.size, 3);
  for (const branch of branches) {
    assert.ok(isCyclePublishBranchForIssue(branch, 17), branch);
    assert.notEqual(branch, legacyPublishBranchName(17));
  }
});

test("branch 형식 판별은 같은 Issue의 legacy/cycle 형식만 허용한다", () => {
  assert.ok(isPublishBranchForIssue("ai-publish/issue-17", 17));
  assert.ok(isPublishBranchForIssue(`ai-publish/issue-17-cycle-${expectedCycle}`, 17));
  assert.ok(!isPublishBranchForIssue("ai-publish/issue-170", 17));
  assert.ok(!isPublishBranchForIssue(`ai-publish/issue-18-cycle-${expectedCycle}`, 17));
  assert.ok(!isPublishBranchForIssue(`ai-publish/issue-17-cycle-${expectedCycle.toUpperCase()}`, 17));
  assert.ok(!isPublishBranchForIssue(`ai-publish/issue-17-cycle-${expectedCycle}0`, 17));
  assert.ok(!isPublishBranchForIssue(`ai-publish/issue-17/cycle-${expectedCycle}`, 17));
  assert.ok(!isPublishBranchForIssue("main", 17));
  assert.ok(!isCyclePublishBranchForIssue("ai-publish/issue-17", 17));
});

test("PUBLISH provenance는 exact published head SHA와 source SEAL을 결합한다", () => {
  const provenance = createPublishProvenance({
    seal,
    sealedPatch: patch,
    sealedArtifactName: artifactName,
    repository: seal.repository,
    publishRun: {
      runId: 400,
      runAttempt: 1,
      trustedCodeSha,
    },
    publishedHeadSha,
  });

  assert.equal(provenance.type, "PUBLISH");
  assert.equal(provenance.publishedBranch, `ai-publish/issue-17-cycle-${expectedCycle}`);
  assert.equal(provenance.publishedHeadSha, publishedHeadSha);
  assert.equal(provenance.sourceSeal.sealedPatchDigest, patchDigest);
  assert.equal(provenance.publishWorkflow.workflowPath, ".github/workflows/trusted-rail.yml");
});

function publishFor(value: SealProvenance, sealedArtifactName = artifactName) {
  return createPublishProvenance({
    seal: value,
    sealedPatch: patch,
    sealedArtifactName,
    repository: value.repository,
    publishRun: { runId: value.sealWorkflow.runId, runAttempt: value.sealWorkflow.runAttempt, trustedCodeSha },
    publishedHeadSha,
  });
}

test("PUBLISH provenance 검증은 trusted SEAL에서 branch를 다시 계산하고 legacy는 historical에서만 허용한다", () => {
  const provenance = publishFor(seal);
  assert.equal(validatePublishProvenance(provenance).publishedBranch, provenance.publishedBranch);

  const legacy = { ...provenance, publishedBranch: "ai-publish/issue-17" };
  assert.throws(() => validatePublishProvenance(legacy), /cycle identity/);
  assert.throws(() => validatePublishProvenance(legacy, "current"), /cycle identity/);
  assert.equal(validatePublishProvenance(legacy, "historical").publishedBranch, "ai-publish/issue-17");

  const otherCycle = {
    ...provenance,
    publishedBranch: cyclePublishBranchName(17, "d".repeat(40), patchDigest),
  };
  assert.throws(() => validatePublishProvenance(otherCycle), /cycle identity/);
  assert.throws(() => validatePublishProvenance(otherCycle, "historical"), /cycle identity/);
  assert.throws(
    () => validatePublishProvenance({ ...provenance, publishedBranch: "ai-publish/issue-18" }, "historical"),
    /cycle identity/,
  );
});

const reviewedHeadSha = "e".repeat(40);
const fixRequestRunId = 500;
const fixRunId = 600;
const fixSealRunId = 700;

function fixSeal(reviewedBranch: string): SealProvenance {
  const requirementsDigest = `sha256:${"2".repeat(64)}`;
  const fix = {
    type: "FIX",
    repository: seal.repository,
    issueNumber: 17,
    baseSha: reviewedHeadSha,
    fixAttempt: 1,
    sourceAuthorization: { ...seal.sourceAuthorization!, requirementsDigest },
    sourceReview: {
      artifactName: "review-provenance-issue-17-400-attempt-1",
      runId: 400,
      runAttempt: 1,
      reviewedBranch,
      reviewedHeadSha,
      requirementsDigest,
      findingsDigest: `sha256:${"3".repeat(64)}`,
    },
    sourceRequest: {
      workflowPath: FIX_REQUEST_WORKFLOW_PATH,
      runId: fixRequestRunId,
      runAttempt: 1,
      artifactName: `fix-request-400-fix-1-${fixRequestRunId}-attempt-1`,
      trustedCodeSha,
    },
    fixWorkflow: { workflowPath: FIX_WORKFLOW_PATH, runId: fixRunId, runAttempt: 1 },
    candidatePatchDigest: patchDigest,
    aiExecution: { provider: "openai-codex-action", resultId: "codex-action-run:600:1" },
  };
  return sealFixCandidate({
    fix,
    candidatePatch: patch,
    sourceRun: {
      id: fixRunId,
      runAttempt: 1,
      controlPlaneSha: trustedCodeSha,
      repository: seal.repository,
      conclusion: "success",
      workflowPath: FIX_WORKFLOW_PATH,
    },
    sealRun: { runId: fixSealRunId, runAttempt: 1, trustedCodeSha },
    candidateArtifactName: `implement-candidate-${fixRequestRunId}-${fixRunId}-attempt-1`,
  }).provenance;
}

test("FIX는 새 cycle branch를 만들지 않고 source REVIEW branch(legacy/cycle)를 그대로 이어받는다", () => {
  const fixArtifact = `sealed-candidate-${fixRunId}-attempt-1-${fixSealRunId}-attempt-1`;
  const cycleBranch = publishBranchForSeal(seal);
  for (const reviewedBranch of [cycleBranch, "ai-publish/issue-17"]) {
    const sealed = fixSeal(reviewedBranch);
    assert.equal(publishBranchForSeal(sealed), reviewedBranch);
    const provenance = publishFor(sealed, fixArtifact);
    assert.equal(provenance.publishedBranch, reviewedBranch);
    // FIX가 이어받은 branch는 current 검증에서도 exact하게 통과한다.
    assert.equal(validatePublishProvenance(provenance).publishedBranch, reviewedBranch);
    // FIX가 자기 patch로 새 cycle branch를 만든 것처럼 위조하면 거부한다.
    assert.throws(
      () => validatePublishProvenance({
        ...provenance,
        publishedBranch: cyclePublishBranchName(17, sealed.baseSha, sealed.sealedPatchDigest),
      }, "historical"),
      /cycle identity/,
    );
  }
});

test("FIX source REVIEW branch가 다른 Issue이거나 형식이 틀리면 SEAL 단계에서 fail-closed 한다", () => {
  for (const reviewedBranch of [
    "ai-publish/issue-18",
    `ai-publish/issue-18-cycle-${expectedCycle}`,
    `ai-publish/issue-17-cycle-${expectedCycle.slice(0, 15)}`,
    "main",
  ]) {
    assert.throws(() => fixSeal(reviewedBranch), /FIX provenance/, reviewedBranch);
  }
});
