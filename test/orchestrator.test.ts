import assert from "node:assert/strict";
import test from "node:test";
import {
  APPROVAL_COMMAND,
  requirementsSnapshot,
  type AuthorizationProvenance,
} from "../src/self-improvement/authorization.js";
import {
  createOrchestrationProvenance,
  routeReviewDecision,
  validateReviewForOrchestration,
  type ReviewSourceRun,
} from "../src/self-improvement/orchestrator.js";
import type { PublishProvenance } from "../src/self-improvement/publish.js";
import { createSemanticReviewProvenance } from "../src/self-improvement/review.js";
import { createVerifyProvenance } from "../src/self-improvement/verify.js";

const repository = "erpsarang/self-improvement-mvp";
const issueNumber = 26;
const baseSha = "a".repeat(40);
const reviewedHeadSha = "b".repeat(40);
const trustedCodeSha = "c".repeat(40);
const orchestratorCodeSha = "d".repeat(40);
const patchDigest = `sha256:${"1".repeat(64)}`;
const requirements = requirementsSnapshot(
  "Embedded Orchestrator 테스트",
  "trusted REVIEW decision을 다음 상태로 결정론적으로 연결한다.",
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
  publishedHeadSha: reviewedHeadSha,
};

const verify = createVerifyProvenance({
  publish,
  publishArtifactName: `publish-provenance-issue-${issueNumber}-400-attempt-1`,
  repository,
  verifyRun: { runId: 400, runAttempt: 1, trustedCodeSha },
  verifiedHeadSha: reviewedHeadSha,
});

const reviewerOutput = {
  decision: "PASS",
  summary: "승인된 요구사항을 만족하고 blocker가 없다.",
  findings: [],
} as const;

const review = createSemanticReviewProvenance({
  verify,
  verifyArtifactName: `verify-provenance-issue-${issueNumber}-400-attempt-1`,
  authorization,
  authorizationArtifactName: `authorize-approval-${authorization.approvalCommentId}-attempt-1`,
  repository,
  reviewerOutput,
  rawReviewerOutput: `${JSON.stringify(reviewerOutput)}\n`,
  reviewerOutputArtifactName: `reviewer-output-issue-${issueNumber}-400-attempt-1`,
  reviewerProvider: "openai-codex-action",
  reviewRun: { runId: 400, runAttempt: 1, trustedCodeSha },
});

const reviewArtifactName = `review-provenance-issue-${issueNumber}-400-attempt-1`;
const sourceRun: ReviewSourceRun = {
  id: 400,
  runAttempt: 1,
  repository,
  conclusion: "success",
  workflowPath: ".github/workflows/trusted-rail.yml",
};

test("trusted REVIEW artifact와 source Trusted Rail identity가 exact match할 때만 route 입력으로 승인한다", () => {
  const validated = validateReviewForOrchestration({
    review,
    reviewArtifactName,
    sourceRun,
  });
  assert.equal(validated.reviewedHeadSha, reviewedHeadSha);
  assert.equal(validated.requirementsDigest, requirements.digest);
});

test("REVIEW artifact 또는 source run identity가 다르면 fail-closed 한다", () => {
  assert.throws(() => validateReviewForOrchestration({
    review,
    reviewArtifactName: `review-provenance-issue-${issueNumber}-999-attempt-1`,
    sourceRun,
  }), /artifact identity/);
  assert.throws(() => validateReviewForOrchestration({
    review,
    reviewArtifactName,
    sourceRun: { ...sourceRun, id: 401 },
  }), /source Trusted Rail run identity/);
});

test("REVIEW decision은 새 AI 판단 없이 다음 상태로 결정론적으로 route한다", () => {
  assert.deepEqual(routeReviewDecision(review), {
    fromState: "REVIEWING",
    nextState: "MERGE_READY",
    shouldCreatePullRequest: true,
    shouldDispatchFix: false,
    completedFixCount: 0,
    nextFixAttempt: null,
  });

  const localFixReview = {
    ...review,
    decision: "LOCAL_FIX" as const,
    findings: [{
      severity: "BLOCKER" as const,
      scope: "LOCAL" as const,
      title: "국소 수정 필요",
      evidence: "한 파일의 구현 오류",
      recommendation: "해당 파일만 수정",
    }],
  };
  const localFixRoute = routeReviewDecision(localFixReview);
  assert.equal(localFixRoute.nextState, "FIXING");
  assert.equal(localFixRoute.shouldDispatchFix, true);
  assert.equal(localFixRoute.completedFixCount, 0);
  assert.equal(localFixRoute.nextFixAttempt, 1);

  const structuralReview = {
    ...review,
    decision: "STRUCTURAL_CHANGE" as const,
    findings: [{
      severity: "BLOCKER" as const,
      scope: "STRUCTURAL" as const,
      title: "구조 변경 필요",
      evidence: "승인 범위를 넘어서는 설계 변경 필요",
      recommendation: "사람이 요구사항과 PLAN을 다시 승인",
    }],
  };
  const structuralRoute = routeReviewDecision(structuralReview);
  assert.equal(structuralRoute.nextState, "STOPPED");
  assert.equal(structuralRoute.shouldDispatchFix, false);
});

test("PASS orchestration provenance는 exact reviewed SHA Human Merge PR을 요구한다", () => {
  const provenance = createOrchestrationProvenance({
    review,
    reviewArtifactName,
    sourceRun,
    orchestratorRun: {
      runId: 500,
      runAttempt: 1,
      trustedCodeSha: orchestratorCodeSha,
    },
    defaultBranch: "main",
    mergeBoundary: {
      type: "HUMAN_PULL_REQUEST",
      number: 27,
      url: `https://github.com/${repository}/pull/27`,
      baseBranch: "main",
      headBranch: review.reviewedBranch,
      headSha: review.reviewedHeadSha,
      createdBy: { identity: "GITHUB_APP", login: "ai-dev-framework-merge-ready[bot]", appSlug: "ai-dev-framework-merge-ready" },
    },
  });

  assert.equal(provenance.nextState, "MERGE_READY");
  assert.equal(provenance.mergeBoundary?.headSha, review.reviewedHeadSha);
  assert.equal(provenance.requirementsDigest, requirements.digest);
  assert.deepEqual(provenance.mergeBoundary?.createdBy, {
    identity: "GITHUB_APP",
    login: "ai-dev-framework-merge-ready[bot]",
    appSlug: "ai-dev-framework-merge-ready",
  });

  assert.throws(() => createOrchestrationProvenance({
    review,
    reviewArtifactName,
    sourceRun,
    orchestratorRun: { runId: 500, runAttempt: 1, trustedCodeSha: orchestratorCodeSha },
    defaultBranch: "main",
    mergeBoundary: null,
  }), /Merge PR identity/);
});

test("Human Merge PR head SHA가 reviewedHeadSha와 다르면 거부한다", () => {
  assert.throws(() => createOrchestrationProvenance({
    review,
    reviewArtifactName,
    sourceRun,
    orchestratorRun: { runId: 500, runAttempt: 1, trustedCodeSha: orchestratorCodeSha },
    defaultBranch: "main",
    mergeBoundary: {
      type: "HUMAN_PULL_REQUEST",
      number: 27,
      url: `https://github.com/${repository}/pull/27`,
      baseBranch: "main",
      headBranch: review.reviewedBranch,
      headSha: "e".repeat(40),
      createdBy: { identity: "GITHUB_TOKEN", login: "github-actions[bot]", appSlug: null },
    },
  }), /exact reviewed SHA/);
});

test("Human Merge PR 생성 identity는 Framework identity(App bot 또는 github-actions[bot])만 인정한다", () => {
  const withCreator = (createdBy: unknown) => createOrchestrationProvenance({
    review,
    reviewArtifactName,
    sourceRun,
    orchestratorRun: { runId: 500, runAttempt: 1, trustedCodeSha: orchestratorCodeSha },
    defaultBranch: "main",
    mergeBoundary: {
      type: "HUMAN_PULL_REQUEST",
      number: 27,
      url: `https://github.com/${repository}/pull/27`,
      baseBranch: "main",
      headBranch: review.reviewedBranch,
      headSha: review.reviewedHeadSha,
      createdBy: createdBy as never,
    },
  });

  // GITHUB_TOKEN fallback은 github-actions[bot]만, GitHub App은 `<slug>[bot]`만 통과한다.
  assert.equal(withCreator({ identity: "GITHUB_TOKEN", login: "github-actions[bot]", appSlug: null }).mergeBoundary?.createdBy.identity, "GITHUB_TOKEN");
  assert.equal(withCreator({ identity: "GITHUB_APP", login: "merge-ready[bot]", appSlug: "merge-ready" }).mergeBoundary?.createdBy.appSlug, "merge-ready");

  const rejected: unknown[] = [
    undefined,
    { identity: "GITHUB_APP", login: "erpsarang", appSlug: "merge-ready" },              // 사람 계정이 App identity를 주장
    { identity: "GITHUB_APP", login: "other[bot]", appSlug: "merge-ready" },             // slug와 작성자 불일치
    { identity: "GITHUB_APP", login: "merge-ready[bot]", appSlug: null },                // slug 없음
    { identity: "GITHUB_APP", login: "merge-ready[bot]", appSlug: "Merge Ready" },       // slug 형식 위반
    { identity: "GITHUB_TOKEN", login: "erpsarang", appSlug: null },                     // 사람이 만든 PR
    { identity: "GITHUB_TOKEN", login: "github-actions[bot]", appSlug: "merge-ready" },  // fallback인데 slug 있음
    { identity: "HUMAN", login: "erpsarang", appSlug: null },                            // 정의되지 않은 identity
    { identity: "GITHUB_TOKEN", login: "github-actions[bot]", appSlug: null, extra: 1 }, // 알 수 없는 필드
  ];
  for (const createdBy of rejected) {
    assert.throws(() => withCreator(createdBy), /생성 identity가 올바르지 않습니다/, JSON.stringify(createdBy));
  }
});
