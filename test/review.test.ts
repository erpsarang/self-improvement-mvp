import assert from "node:assert/strict";
import test from "node:test";
import {
  APPROVAL_COMMAND,
  requirementsSnapshot,
  type AuthorizationProvenance,
} from "../src/self-improvement/authorization.js";
import type { PublishProvenance } from "../src/self-improvement/publish.js";
import {
  createSemanticReviewProvenance,
  validateSemanticReviewerOutput,
  validateVerifiedCandidateForReview,
} from "../src/self-improvement/review.js";
import { createVerifyProvenance } from "../src/self-improvement/verify.js";

const repository = "erpsarang/self-improvement-mvp";
const issueNumber = 23;
const baseSha = "a".repeat(40);
const publishedHeadSha = "b".repeat(40);
const trustedCodeSha = "c".repeat(40);
const patchDigest = `sha256:${"1".repeat(64)}`;
const requirements = requirementsSnapshot(
  "Semantic Review 테스트",
  "정확한 verified SHA가 요구사항을 만족하는지 검토한다.",
);

const authorization: AuthorizationProvenance = {
  type: "AUTHORIZE",
  issueNumber,
  requirements,
  approvalCommentId: 200,
  approverId: 8370921,
  approver: "erpsarang",
  policyVersion: 1,
  policySnapshot: `sha256:${"2".repeat(64)}`,
  approvedAt: "2026-09-08T00:00:00Z",
  approvalCommand: APPROVAL_COMMAND,
  repository,
  workflowPath: ".github/workflows/authorize.yml",
  runId: 100,
  runAttempt: 1,
  githubSha: baseSha,
};

const publish: PublishProvenance = {
  type: "PUBLISH",
  repository,
  issueNumber,
  baseSha,
  sourceSealArtifactName: "sealed-candidate-300-attempt-1-400-attempt-1",
  sourceSeal: {
    type: "SEAL",
    repository,
    issueNumber,
    baseSha,
    sourceAuthorization: {
      runId: authorization.runId,
      runAttempt: authorization.runAttempt,
      approvalCommentId: authorization.approvalCommentId,
      policySnapshot: authorization.policySnapshot,
      requirementsDigest: requirements.digest,
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
  publishedBranch: `ai-publish/issue-${issueNumber}`,
  publishedHeadSha,
};

const verify = createVerifyProvenance({
  publish,
  publishArtifactName: `publish-provenance-issue-${issueNumber}-400-attempt-1`,
  repository,
  verifyRun: { runId: 400, runAttempt: 1, trustedCodeSha },
  verifiedHeadSha: publishedHeadSha,
});

const verifyArtifactName = `verify-provenance-issue-${issueNumber}-400-attempt-1`;
const authorizationArtifactName = `authorize-approval-${authorization.approvalCommentId}-attempt-1`;

const passOutput = {
  decision: "PASS",
  summary: "승인된 요구사항을 만족하며 blocker가 없다.",
  findings: [
    {
      severity: "FOLLOW_UP",
      scope: "NONE",
      title: "후속 문서 개선",
      evidence: "기능 동작과 무관한 설명 개선 여지가 있다.",
      recommendation: "후속 Issue에서 문서를 다듬는다.",
    },
  ],
} as const;

test("REVIEW는 VERIFY provenance와 원본 AUTHORIZE 요구사항 snapshot을 exact binding한다", () => {
  const validated = validateVerifiedCandidateForReview({
    verify,
    verifyArtifactName,
    authorization,
    authorizationArtifactName,
    repository,
  });
  assert.equal(validated.verify.verifiedHeadSha, publishedHeadSha);
  assert.equal(validated.authorization.requirements.digest, requirements.digest);
});

test("승인 요구사항 snapshot이 compact authorization digest와 다르면 fail-closed 한다", () => {
  const changedAuthorization = {
    ...authorization,
    requirements: requirementsSnapshot("Semantic Review 테스트", "변경된 본문"),
  };
  assert.throws(
    () => validateVerifiedCandidateForReview({
      verify,
      verifyArtifactName,
      authorization: changedAuthorization,
      authorizationArtifactName,
      repository,
    }),
    /authorization binding/,
  );
});

test("PASS는 BLOCKER가 없을 때만 허용한다", () => {
  assert.equal(validateSemanticReviewerOutput(passOutput).decision, "PASS");
  assert.throws(
    () => validateSemanticReviewerOutput({
      decision: "PASS",
      summary: "잘못된 PASS",
      findings: [{
        severity: "BLOCKER",
        scope: "LOCAL",
        title: "결함",
        evidence: "구체적 결함",
        recommendation: "수정 필요",
      }],
    }),
    /PASS decision/,
  );
});

test("LOCAL_FIX와 STRUCTURAL_CHANGE는 blocker scope와 일관되어야 한다", () => {
  assert.equal(validateSemanticReviewerOutput({
    decision: "LOCAL_FIX",
    summary: "국소 수정 필요",
    findings: [{
      severity: "BLOCKER",
      scope: "LOCAL",
      title: "국소 결함",
      evidence: "한 파일의 조건식 문제",
      recommendation: "조건식을 수정한다.",
    }],
  }).decision, "LOCAL_FIX");

  assert.equal(validateSemanticReviewerOutput({
    decision: "STRUCTURAL_CHANGE",
    summary: "구조 변경 필요",
    findings: [{
      severity: "BLOCKER",
      scope: "STRUCTURAL",
      title: "요구사항 구조 충돌",
      evidence: "현재 Trust Boundary로는 요구사항을 만족할 수 없다.",
      recommendation: "Human 경계에서 요구사항을 재설계한다.",
    }],
  }).decision, "STRUCTURAL_CHANGE");

  assert.throws(() => validateSemanticReviewerOutput({
    decision: "LOCAL_FIX",
    summary: "잘못된 local fix",
    findings: [{
      severity: "BLOCKER",
      scope: "STRUCTURAL",
      title: "구조 결함",
      evidence: "구조 변경 필요",
      recommendation: "재설계",
    }],
  }), /LOCAL_FIX/);
});

test("trusted REVIEW provenance는 exact verified SHA와 requirements digest를 기록한다", () => {
  const raw = `${JSON.stringify(passOutput)}\n`;
  const provenance = createSemanticReviewProvenance({
    verify,
    verifyArtifactName,
    authorization,
    authorizationArtifactName,
    repository,
    reviewerOutput: passOutput,
    rawReviewerOutput: raw,
    reviewerOutputArtifactName: `reviewer-output-issue-${issueNumber}-400-attempt-1`,
    reviewerProvider: "openai-codex-action",
    reviewRun: { runId: 400, runAttempt: 1, trustedCodeSha },
  });

  assert.equal(provenance.type, "REVIEW");
  assert.equal(provenance.reviewedHeadSha, verify.verifiedHeadSha);
  assert.equal(provenance.requirementsDigest, requirements.digest);
  assert.equal(provenance.decision, "PASS");
  assert.match(provenance.reviewer.outputDigest, /^sha256:[0-9a-f]{64}$/);
});

test("다른 run의 reviewer output artifact는 trusted provenance로 승격하지 않는다", () => {
  assert.throws(() => createSemanticReviewProvenance({
    verify,
    verifyArtifactName,
    authorization,
    authorizationArtifactName,
    repository,
    reviewerOutput: passOutput,
    rawReviewerOutput: JSON.stringify(passOutput),
    reviewerOutputArtifactName: `reviewer-output-issue-${issueNumber}-999-attempt-1`,
    reviewerProvider: "openai-codex-action",
    reviewRun: { runId: 400, runAttempt: 1, trustedCodeSha },
  }), /artifact identity/);
});
