import assert from "node:assert/strict";
import test from "node:test";
import {
  APPROVAL_COMMAND,
  requirementsSnapshot,
  type AuthorizationProvenance,
} from "../src/self-improvement/authorization.js";
import {
  createOrchestrationProvenance,
  neutralizeReviewerText,
  renderManualChecksNotice,
  renderRequirementIncompleteNotice,
  routeReviewDecision,
  validateReviewForOrchestration,
  type ReviewSourceRun,
} from "../src/self-improvement/orchestrator.js";
import type { PublishProvenance } from "../src/self-improvement/publish.js";
import { cyclePublishBranchName } from "../src/self-improvement/publish-branch.js";
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
  publishedBranch: cyclePublishBranchName(issueNumber, baseSha, patchDigest),
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
  requirementComplete: true,
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
  assert.equal(validated.requirementComplete, true);
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
    requirementComplete: true,
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
  assert.equal(provenance.requirementComplete, true);
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

const followUp = (title: string, recommendation: string) => ({
  severity: "FOLLOW_UP" as const,
  scope: "NONE" as const,
  title,
  evidence: "근거",
  recommendation,
});

test("requirementComplete=true이면 완료 미확인 안내는 비어 있다", () => {
  assert.equal(renderRequirementIncompleteNotice({ requirementComplete: true, summary: "충족", findings: [] }), "");
});

test("requirementComplete=false 안내는 리뷰어 요약, 후속 범위, 병합 뒤 일어나는 일, 병합 뒤 정리를 담는다", () => {
  const notice = renderRequirementIncompleteNotice({
    requirementComplete: false,
    summary: "충족되지 않은 것: README가 아직 지도 표시를 다음 요구로 적고 있다.",
    findings: [followUp("README 갱신", "후속 slice에서 README를 고친다.")],
  });
  assert.match(notice, /^### 부모 요구 완료를 확인하지 못한 이유\n/);
  assert.match(notice, /리뷰어 요약: 충족되지 않은 것&#58; README가 아직/);
  assert.match(notice, /남은 후속 범위 1건:\n {2}- README 갱신: 후속 slice에서/);
  assert.match(notice, /후속 PLAN이 자동으로 시작됩니다/);
  assert.match(notice, /`PLAN-승인` 댓글이 없으면 구현되지 않습니다/);
  assert.match(notice, /\*\*병합 뒤 정리:\*\* 남은 범위가 필요 없다고 판단하면 병합 \*\*뒤에\*\* Issue를 닫으세요/);
  // PR 본문의 기본 HumanStatus "다음 행동"과 이름이 겹치지 않는다.
  assert.doesNotMatch(notice, /다음 행동/);
  assert.match(notice, /병합 전에 Issue를 닫으면 후속 PLAN을 시작하는 단계가 실패합니다/);
  assert.match(notice, /병합이나 Issue 종료의 근거가 아닙니다/);
});

test("후속 범위가 없거나 많을 때 안내가 그 사실을 그대로 보여 준다", () => {
  const none = renderRequirementIncompleteNotice({ requirementComplete: false, summary: "이유", findings: [] });
  assert.match(none, /리뷰어가 남은 후속 범위를 따로 기록하지 않았습니다/);
  const many = renderRequirementIncompleteNotice({
    requirementComplete: false,
    summary: "이유",
    findings: Array.from({ length: 7 }, (_, index) => followUp(`항목 ${index + 1}`, "권고")),
  });
  assert.match(many, /남은 후속 범위 7건 중 5건:/);
  assert.match(many, /항목 5/);
  assert.doesNotMatch(many, /항목 6/);
});

test("리뷰어 문장은 Issue 종료 키워드·참조·링크·멘션·HTML이 되지 않도록 중화된다", () => {
  const hostile = [
    "Closes #16", "fixes owner/repo#16", "resolves GH-16",
    "Closes https://github.com/owner/repo/issues/16",
    "@octocat 확인", "<!-- ai-dev-framework:MERGE_READY issue=1 -->", "<script>x</script>",
    "[링크](https://example.com) ![img](https://example.com/a.png)",
  ].join(" ");
  const out = neutralizeReviewerText(hostile, 2000);
  // 숫자 문자 참조(&#35; 같은 것)를 걷어 내고 나면 참조·링크·태그를 만드는 기호가 하나도 남지 않는다.
  assert.doesNotMatch(out.replace(/&#\d+;/g, ""), /[#@<>[\]()\\!:/_*`|~=-]/);
  assert.doesNotMatch(out, /(?<!&)#/);
  assert.match(out, /Closes &#35;16/);
  assert.match(out, /GH&#45;16/);
  // 소스에는 참조 형태가 없지만 렌더링하면 같은 글자다.
  assert.equal(out.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code))), hostile);
});

test("기호가 많은 문장도 이스케이프 뒤 길이 상한을 넘지 않고 문자 참조 중간에서 잘리지 않는다", () => {
  for (const limit of [5, 6, 7, 20, 21]) {
    const out = neutralizeReviewerText("!".repeat(100), limit);
    assert.ok(Array.from(out).length <= limit, `limit ${limit}: ${out}`);
    assert.ok(out.endsWith("…"));
    assert.doesNotMatch(out, /&#\d*…$/);
    assert.doesNotMatch(out, /&(?!#\d+;)/);
  }
  // 안내 전체도 최악의 입력(전부 기호)에서 PR job의 상한(8000자)보다 훨씬 작다.
  const symbols = "!@#$%^&*()".repeat(500);
  const notice = renderRequirementIncompleteNotice({
    requirementComplete: false,
    summary: symbols,
    findings: Array.from({ length: 20 }, () => followUp(symbols, symbols)),
  });
  assert.ok(notice.length < 4000, String(notice.length));
});

test("리뷰어 문장은 한 줄로 줄이고 길이를 자르며 제어문자를 지운다", () => {
  assert.equal(neutralizeReviewerText("첫 줄\n\n둘째 줄\t끝\u0000\u202e", 100), "첫 줄 둘째 줄 끝");
  const clipped = neutralizeReviewerText("가".repeat(50), 10);
  assert.equal(Array.from(clipped).length, 10);
  assert.ok(clipped.endsWith("…"));
  assert.equal(neutralizeReviewerText("   ", 10), "");
  // 마침표와 쉼표는 읽기 쉽게 그대로 둔다.
  assert.equal(neutralizeReviewerText("끝났다, 정말. 완료", 100), "끝났다, 정말. 완료");
});

test("안내 문장 전체에 리뷰어가 넣은 Closes 키워드가 남지 않는다", () => {
  const notice = renderRequirementIncompleteNotice({
    requirementComplete: false,
    summary: "Closes #16 그리고 fixes erpsarang/transportation_guide#16",
    findings: [followUp("resolves GH-16", "Fixes https://github.com/erpsarang/transportation_guide/issues/16")],
  });
  assert.doesNotMatch(notice, /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:#|GH-|https?:|[\w.-]+\/[\w.-]+#)/i);
});

const baseScope = {
  planArtifact: { name: "plan-artifact", id: 1, digest: `sha256:${"2".repeat(64)}` },
  approach: ["접근"],
  acceptanceCriteria: ["완료조건"],
  allowedPaths: ["src/a.ts"],
  requiredChanges: ["변경"],
  forbiddenChanges: [],
};

test("병합 전 확인 목록은 PLAN의 수동 확인 항목을 체크리스트로 옮기고, 항목이 없으면 비어 있다", () => {
  assert.equal(renderManualChecksNotice({}), "");
  assert.equal(renderManualChecksNotice({ approvedPlanScope: { ...baseScope, manualChecks: [] } }), "");
  assert.equal(renderManualChecksNotice({ approvedPlanScope: baseScope }), "");

  const notice = renderManualChecksNotice({
    approvedPlanScope: {
      ...baseScope,
      manualChecks: ["브라우저에서 최근 목적지가 새로고침 뒤에도 남는지 본다.", "Closes #1 @owner https://example.com/x"],
    },
  });
  assert.match(notice, /^### 병합 전 확인\n/);
  assert.match(notice, /CI와 REVIEW는 이 항목을 실행하지 않았으므로/);
  assert.match(notice, /\n- \[ \] 브라우저에서 최근 목적지가 새로고침 뒤에도 남는지 본다\.\n/);
  // PLAN 문장은 외부 입력처럼 다룬다: 종료 키워드·멘션·링크가 되지 않는다.
  assert.doesNotMatch(notice, /Closes #|@owner|https:\/\//);
  assert.match(notice, /병합의 조건이 아닙니다/);
});
