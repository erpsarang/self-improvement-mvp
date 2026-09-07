import assert from "node:assert/strict";
import test from "node:test";
import type { PublishProvenance } from "../src/self-improvement/publish.js";
import {
  createVerifyProvenance,
  validatePublishedCandidateForVerify,
} from "../src/self-improvement/verify.js";

const baseSha = "a".repeat(40);
const publishedHeadSha = "b".repeat(40);
const trustedCodeSha = "c".repeat(40);
const patchDigest = `sha256:${"1".repeat(64)}`;

const publish: PublishProvenance = {
  type: "PUBLISH",
  repository: "erpsarang/self-improvement-mvp",
  issueNumber: 20,
  baseSha,
  sourceSealArtifactName: "sealed-candidate-300-attempt-1-400-attempt-1",
  sourceSeal: {
    type: "SEAL",
    repository: "erpsarang/self-improvement-mvp",
    issueNumber: 20,
    baseSha,
    sourceAuthorization: {
      runId: 100,
      runAttempt: 1,
      approvalCommentId: 200,
      policySnapshot: `sha256:${"2".repeat(64)}`,
      requirementsDigest: `sha256:${"3".repeat(64)}`,
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
  },
  publishWorkflow: {
    workflowPath: ".github/workflows/trusted-rail.yml",
    runId: 400,
    runAttempt: 1,
    trustedCodeSha,
  },
  publishedBranch: "ai-publish/issue-20",
  publishedHeadSha,
};

const artifactName = "publish-provenance-issue-20-400-attempt-1";

test("PUBLISH provenance artifact는 issue/run/attempt가 정확히 결합될 때만 VERIFY 입력으로 승인된다", () => {
  const validated = validatePublishedCandidateForVerify({
    publish,
    publishArtifactName: artifactName,
    repository: publish.repository,
  });
  assert.equal(validated.publishedHeadSha, publishedHeadSha);
  assert.equal(validated.publishedBranch, "ai-publish/issue-20");
});

test("PUBLISH artifact identity가 provenance와 다르면 VERIFY를 거부한다", () => {
  assert.throws(
    () =>
      validatePublishedCandidateForVerify({
        publish,
        publishArtifactName: "publish-provenance-issue-20-999-attempt-1",
        repository: publish.repository,
      }),
    /artifact identity/,
  );
});

test("published branch가 issue와 deterministic binding을 깨면 VERIFY를 거부한다", () => {
  assert.throws(
    () =>
      validatePublishedCandidateForVerify({
        publish: { ...publish, publishedBranch: "ai-publish/issue-999" },
        publishArtifactName: artifactName,
        repository: publish.repository,
      }),
    /PUBLISH provenance/,
  );
});

test("VERIFY provenance는 exact publishedHeadSha와 같은 SHA만 PASS로 기록한다", () => {
  const provenance = createVerifyProvenance({
    publish,
    publishArtifactName: artifactName,
    repository: publish.repository,
    verifyRun: {
      runId: 400,
      runAttempt: 1,
      trustedCodeSha,
    },
    verifiedHeadSha: publishedHeadSha,
  });

  assert.equal(provenance.type, "VERIFY");
  assert.equal(provenance.result, "PASS");
  assert.equal(provenance.verifiedHeadSha, publish.publishedHeadSha);
  assert.equal(provenance.verifiedBranch, publish.publishedBranch);
  assert.equal(provenance.sourcePublish.publishedHeadSha, publish.publishedHeadSha);
});

test("검증한 SHA가 publishedHeadSha와 다르면 fail-closed 한다", () => {
  assert.throws(
    () =>
      createVerifyProvenance({
        publish,
        publishArtifactName: artifactName,
        repository: publish.repository,
        verifyRun: {
          runId: 400,
          runAttempt: 1,
          trustedCodeSha,
        },
        verifiedHeadSha: "d".repeat(40),
      }),
    /publishedHeadSha/,
  );
});

test("VERIFY는 PUBLISH와 같은 Trusted Rail run에 귀속되어야 한다", () => {
  assert.throws(
    () =>
      createVerifyProvenance({
        publish,
        publishArtifactName: artifactName,
        repository: publish.repository,
        verifyRun: {
          runId: 401,
          runAttempt: 1,
          trustedCodeSha,
        },
        verifiedHeadSha: publishedHeadSha,
      }),
    /같은 Trusted Rail run/,
  );
});
