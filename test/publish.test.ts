import assert from "node:assert/strict";
import test from "node:test";
import { sha256 } from "../src/self-improvement/implement.js";
import {
  createPublishProvenance,
  publishBranchName,
  validateSealedCandidateForPublish,
} from "../src/self-improvement/publish.js";
import type { SealProvenance } from "../src/self-improvement/seal.js";

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

test("publish branch는 issue별 deterministic trusted 이름을 사용한다", () => {
  assert.equal(publishBranchName(17), "ai-publish/issue-17");
  assert.throws(() => publishBranchName(0), /양의 정수/);
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
  assert.equal(provenance.publishedBranch, "ai-publish/issue-17");
  assert.equal(provenance.publishedHeadSha, publishedHeadSha);
  assert.equal(provenance.sourceSeal.sealedPatchDigest, patchDigest);
  assert.equal(provenance.publishWorkflow.workflowPath, ".github/workflows/trusted-rail.yml");
});
