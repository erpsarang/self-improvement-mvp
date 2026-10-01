import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  FIX_CONTEXT_MAX_BYTES,
  createFixRequestProvenance,
  createFixSubscriptionRequest,
  createFixWorkerPrompt,
  materializeFixSubscriptionProposal,
} from "../src/self-improvement/fix.js";
import { PLAN_WORKER_OUTPUT_SCHEMA } from "../src/self-improvement/single-pass-worker.js";
import { validateReviewForOrchestration } from "../src/self-improvement/orchestrator.js";
import {
  createSemanticReviewPrompt,
  createSemanticReviewProvenance,
  validateApprovedPlanReviewScope,
  validateApprovedPlanReviewScopeShape,
  type ReviewProvenance,
} from "../src/self-improvement/review.js";
import { createPlanReviewChain, PLAN_REVIEW_CHAIN } from "./support/plan-review-chain.js";

// self-improvement-mvp #244, Trusted Rail run 35999983436: 사람이 승인한 PLAN은 새 파일 3개짜리 첫 bounded slice였고
// workflow/모델 변경은 forbiddenChanges와 approach의 후속 범위였다. 그런데 Semantic Reviewer는 Issue 본문 전체를
// "승인된 요구사항"으로 받아 slice 밖 목표 미구현을 LOCAL BLOCKER로 냈고, FIX Worker는 그 권고를 따라
// workflow 7개를 고쳤다. 이 테스트들은 REVIEW/FIX의 authority가 Issue 본문이 아니라 승인된 PLAN slice임을 고정한다.

const chain = createPlanReviewChain();
const c = PLAN_REVIEW_CHAIN;
const scope = validateApprovedPlanReviewScope(chain.planJson, {
  type: "PLAN_AUTHORIZE",
  artifact: chain.bridge.sourcePlanAuthorize.artifact,
  authorization: chain.bridge.sourcePlanAuthorize.authorization,
  requirement: chain.bridge.requirement,
  bridgeDigest: chain.bridge.bridgeDigest,
});
const requirements = { title: c.title, body: c.body, digest: chain.bridge.requirement.digest };

const passOutput = { decision: "PASS", requirementComplete: false, summary: "승인된 slice를 만족한다.", findings: [] } as const;
const localFixOutput = {
  decision: "LOCAL_FIX",
  requirementComplete: false,
  summary: "README 상태 설명에 MERGE_READY가 빠졌다.",
  findings: [{
    severity: "BLOCKER",
    scope: "LOCAL",
    title: "MERGE_READY 상태 설명 누락",
    evidence: "README.md patch에 PLAN만 있고 VERIFY, MERGE_READY 설명이 없다.",
    recommendation: "README.md에 VERIFY와 MERGE_READY 설명을 추가한다.",
  }],
} as const;

function planReview(
  reviewerOutput: unknown,
  options: { readonly approvedPlan?: unknown } = { approvedPlan: chain.planJson },
): ReviewProvenance {
  return createSemanticReviewProvenance({
    verify: chain.verify,
    verifyArtifactName: chain.verifyArtifactName,
    planAuthorization: chain.authorization,
    planAuthorizationArtifactName: chain.planAuthorizationArtifactName,
    ...options,
    repository: c.repository,
    reviewerOutput,
    rawReviewerOutput: `${JSON.stringify(reviewerOutput)}\n`,
    reviewerOutputArtifactName: `reviewer-output-issue-${c.issueNumber}-${c.railRunId}-attempt-1`,
    reviewerProvider: "openai-codex-action",
    reviewRun: chain.railRun,
  });
}
const reviewArtifactName = `review-provenance-issue-${c.issueNumber}-${c.railRunId}-attempt-1`;
const sourceRun = {
  id: c.railRunId,
  runAttempt: 1,
  repository: c.repository,
  conclusion: "success",
  workflowPath: ".github/workflows/trusted-rail.yml",
} as const;

test("승인된 PLAN.json에서 REVIEW authority가 되는 slice만 꺼내고 PLAN_AUTHORIZE identity에 묶는다", () => {
  assert.deepEqual(scope.planArtifact, chain.authorization.plan.artifact);
  assert.deepEqual(scope.allowedPaths, c.allowedPaths);
  assert.deepEqual(scope.requiredChanges, c.requiredChanges);
  assert.deepEqual(scope.forbiddenChanges, c.forbiddenChanges);
  assert.deepEqual(scope.acceptanceCriteria, c.acceptanceCriteria);
  assert.deepEqual(scope.approach, c.approach);
  assert.deepEqual(validateApprovedPlanReviewScopeShape(JSON.parse(JSON.stringify(scope))), scope);

  const authority = {
    type: "PLAN_AUTHORIZE" as const,
    artifact: chain.bridge.sourcePlanAuthorize.artifact,
    authorization: chain.bridge.sourcePlanAuthorize.authorization,
    requirement: chain.bridge.requirement,
    bridgeDigest: chain.bridge.bridgeDigest,
  };
  const plan = chain.planJson;
  assert.throws(() => validateApprovedPlanReviewScope({ ...plan, sha: "f".repeat(40) }, authority), /SHA mismatch/);
  assert.throws(() => validateApprovedPlanReviewScope({ ...plan, repository: "other/repo" }, authority), /repository mismatch/);
  assert.throws(
    () => validateApprovedPlanReviewScope({ ...plan, plan: { ...plan.plan, implementationScope: { ...plan.plan.implementationScope, ready: false } } }, authority),
    /not ready/,
  );
  assert.throws(() => validateApprovedPlanReviewScope({ ...plan, plan: { ...plan.plan, questions: ["아직 질문"] } }, authority), /blocking questions/);
  assert.throws(() => validateApprovedPlanReviewScope({ ...plan, plan: { ...plan.plan, acceptanceCriteria: [] } }, authority), /acceptanceCriteria/);
  assert.throws(() => validateApprovedPlanReviewScopeShape({ ...scope, allowedPaths: ["../escape.md"] }), /allowedPaths/);
  assert.throws(() => validateApprovedPlanReviewScopeShape({ ...scope, extra: true }), /구조/);
});

test("PLAN 계보 Reviewer prompt는 승인된 slice만 심사 기준으로 주고 Issue 본문은 배경으로 내린다", () => {
  const prompt = createSemanticReviewPrompt({
    repository: c.repository,
    issueNumber: c.issueNumber,
    baseSha: c.targetSha,
    verifiedHeadSha: c.publishedHeadSha,
    requirements,
    approvedPlan: scope,
  });
  assert.match(prompt, /## 승인된 PLAN slice \(이번 REVIEW의 유일한 심사 기준\)/);
  assert.match(prompt, /승인된 PLAN artifact: plan-issue-83-34754507865-attempt-1/);
  for (const item of [...c.requiredChanges, ...c.acceptanceCriteria, ...c.allowedPaths, ...c.forbiddenChanges, ...c.approach]) {
    assert.ok(prompt.includes(`- ${item}\n`), item);
  }
  assert.match(prompt, /## Issue 요구 \(배경 정보이며 심사 기준이 아님\)/);
  assert.ok(prompt.includes(c.body));
  assert.doesNotMatch(prompt, /## 승인된 요구사항/);
  // 핵심 규칙: slice 밖 요구는 BLOCKER가 아니고, forbiddenChanges/allowedPaths 밖 변경을 FIX로 요구하지 않는다.
  assert.match(prompt, /slice 밖 항목\(approach의 후속 범위, forbiddenChanges에 해당하는 것\)은 이번 candidate에 없어도 결함이 아닙니다\. BLOCKER로 만들지 말고/);
  assert.match(prompt, /allowedPaths 밖 파일 변경이나 forbiddenChanges에 해당하는 변경을 요구하는 finding은 만들지 마세요/);
  assert.match(prompt, /LOCAL_FIX: allowedPaths 안의 국소 수정만으로 해결 가능한/);
  assert.match(prompt, /STRUCTURAL_CHANGE: 승인된 slice 자체가 잘못되어/);
  // #299: 후속 범위가 남은 부분 slice PASS는 부모 요구 완료가 아니다.
  assert.match(prompt, /approach\/forbiddenChanges에 후속 범위가 남아 있거나 이번 slice acceptanceCriteria의 사용자 가시 완료조건이 candidate에 없으면, slice가 PASS여도 false/);
  // #310: 마지막 slice는 이전 slice 작업이 patch에 없다는 이유만으로 미완료가 되지 않는다(불필요한 continuation PLAN 방지).
  assert.match(prompt, /이전 slice는 이미 base SHA에 merge되어 있어 patch\.diff에 보이지 않습니다/);
  assert.match(prompt, /이전 slice 작업이 patch에 없다는 이유만으로 requirementComplete를 false로 반환하지 마세요/);
  // 배경 절은 심사 기준 절 뒤에 온다.
  assert.ok(prompt.indexOf("## 승인된 PLAN slice") < prompt.indexOf("## Issue 요구"));
  // 기존 read-only 경계는 그대로다.
  assert.match(prompt, /review-context\/patch\.diff/);
  assert.match(prompt, /전체 repository는 제공되지 않습니다/);
  assert.equal(createSemanticReviewPrompt({ repository: c.repository, issueNumber: c.issueNumber, baseSha: c.targetSha, verifiedHeadSha: c.publishedHeadSha, requirements, approvedPlan: scope }), prompt);
});

test("legacy AUTHORIZE 계보 prompt는 그대로 Issue 요구를 승인된 요구사항으로 심사한다", () => {
  const prompt = createSemanticReviewPrompt({
    repository: c.repository,
    issueNumber: c.issueNumber,
    baseSha: c.targetSha,
    verifiedHeadSha: c.publishedHeadSha,
    requirements,
  });
  assert.match(prompt, /## 승인된 요구사항\n제목: /);
  assert.doesNotMatch(prompt, /승인된 PLAN slice|allowedPaths|forbiddenChanges|배경 정보/);
  assert.match(prompt, /1\. 제공된 bounded patch가 승인된 요구사항을 의미적으로 만족하는지 확인하세요/);
  assert.doesNotMatch(prompt, /이전 slice/);
});

test("PLAN 계보 REVIEW provenance는 승인된 PLAN.json 없이는 만들 수 없고, 만들면 심사 기준 scope를 기록한다", () => {
  const review = planReview(passOutput);
  assert.deepEqual(review.approvedPlanScope, scope);
  assert.equal(review.sourcePlanAuthorize?.type, "PLAN_AUTHORIZE");
  assert.equal(review.sourceAuthorizationArtifactName, undefined);

  assert.throws(() => planReview(passOutput, {}), /승인된 PLAN artifact의 PLAN\.json이 필요합니다/);
  assert.throws(() => planReview(passOutput, { approvedPlan: undefined }), /승인된 PLAN artifact의 PLAN\.json이 필요합니다/);
  assert.throws(() => planReview(passOutput, { approvedPlan: { ...chain.planJson, sha: "f".repeat(40) } }), /SHA mismatch/);
});

test("Orchestrator/FIX가 다시 읽는 review.json은 PLAN 계보에서 승인 scope가 없거나 다른 PLAN artifact면 거부한다", () => {
  const review = planReview(localFixOutput);
  const validated = validateReviewForOrchestration({ review, reviewArtifactName, sourceRun });
  assert.deepEqual(validated.approvedPlanScope, scope);

  const { approvedPlanScope: _dropped, ...withoutScope } = review;
  assert.throws(
    () => validateReviewForOrchestration({ review: withoutScope, reviewArtifactName, sourceRun }),
    /승인된 PLAN scope 구조가 올바르지 않습니다/,
  );
  const otherArtifact = {
    ...review,
    approvedPlanScope: { ...scope, planArtifact: { ...scope.planArtifact, id: scope.planArtifact.id + 1 } },
  };
  assert.throws(
    () => validateReviewForOrchestration({ review: otherArtifact, reviewArtifactName, sourceRun }),
    /PLAN artifact와 일치하지 않습니다/,
  );
  const widened = {
    ...review,
    approvedPlanScope: { ...scope, allowedPaths: [...scope.allowedPaths, ".github/workflows/plan.yml"] },
  };
  // scope 자체는 shape가 맞으면 통과한다: allowedPaths 확대는 PLAN_AUTHORIZE→Handoff contract가 아니라 여기서 잡을 수 없다.
  // 대신 Worker/Bridge 단계가 contractDigest로 고정하므로 REVIEW는 기록된 scope를 그대로 authority로 쓴다.
  assert.doesNotThrow(() => validateReviewForOrchestration({ review: widened, reviewArtifactName, sourceRun }));
});

test("PLAN 계보 FIX prompt는 승인된 allowedPaths/forbiddenChanges를 경계로 주고, 경계를 넘는 BLOCKER는 complete=false로 돌려주라고 지시한다", () => {
  const review = planReview(localFixOutput);
  const prompt = createFixWorkerPrompt(review, 1);
  assert.match(prompt, /승인된 PLAN slice \(이 FIX의 경계\):/);
  assert.match(prompt, /allowedPaths \(이 밖의 파일은 절대 변경하지 마세요\):\n  - README\.md\n/);
  for (const item of c.forbiddenChanges) assert.ok(prompt.includes(`  - ${item}\n`), item);
  assert.match(prompt, /BLOCKER 해결이 allowedPaths 밖 변경이나 forbiddenChanges에 해당하는 변경을 요구하면 complete=false와 그 이유를 summary에 반환하세요/);
  assert.match(prompt, /이번 작업은 FIX #1이며 최대 허용 횟수는 2회입니다/);
  assert.match(prompt, new RegExp(`exact reviewed SHA ${c.publishedHeadSha}`));
  assert.ok(prompt.includes(`Issue #${c.issueNumber}: ${c.title}`));
  assert.ok(prompt.includes(JSON.stringify(localFixOutput.findings, null, 2)));
  // 경계 절은 BLOCKER 목록보다 앞에 온다.
  assert.ok(prompt.indexOf("승인된 PLAN slice") < prompt.indexOf("LOCAL BLOCKER:"));

  const { approvedPlanScope: _dropped, ...withoutScope } = review;
  assert.throws(() => createFixWorkerPrompt(withoutScope as ReviewProvenance, 1), /승인된 PLAN scope가 필요합니다/);
  assert.throws(() => createFixWorkerPrompt(planReview(passOutput), 1), /수정할 LOCAL BLOCKER가 없습니다/);
});

test("legacy 계보 FIX prompt는 기존 문구 그대로이고 PLAN slice 절이 없다", () => {
  const review = planReview(localFixOutput);
  const { approvedPlanScope: _scope, sourcePlanAuthorize: _authority, ...rest } = review;
  const legacyShaped = { ...rest, sourceAuthorizationArtifactName: "authorize-approval-1-attempt-1" } as unknown as ReviewProvenance;
  const prompt = createFixWorkerPrompt(legacyShaped, 2);
  assert.doesNotMatch(prompt, /승인된 PLAN slice|allowedPaths|forbiddenChanges/);
  assert.match(prompt, /이번 작업은 FIX #2이며 최대 허용 횟수는 2회입니다/);
  assert.ok(prompt.endsWith(JSON.stringify(localFixOutput.findings, null, 2)));
});

// bounded FIX: exact reviewed SHA의 allowedPaths 원문만 context로 보내고, Worker JSON edit은 같은 원문 digest에서만 적용한다.
const README = "# Framework\n\n상태: PLAN\n";
const readmeDigest = createHash("sha256").update(README, "utf8").digest("hex");
const readReviewed = (path: string): Buffer | null => (path === "README.md" ? Buffer.from(README, "utf8") : null);
const fixReview = planReview(localFixOutput);
const fixRequest = createFixRequestProvenance({
  review: fixReview,
  reviewArtifactName,
  requestRun: { runId: 7001, runAttempt: 1, trustedCodeSha: "c".repeat(40) },
});

test("bounded FIX_REQUEST는 PLAN allowedPaths 원문과 exact identity만 담고 legacy FIX는 AI 호출 전에 멈춘다", () => {
  assert.deepEqual(c.allowedPaths, ["README.md"]);
  const { identity, prompt, schema } = createFixSubscriptionRequest({
    review: fixReview,
    request: fixRequest,
    worker: { runId: 8001, runAttempt: 2 },
    read: readReviewed,
  });
  assert.deepEqual(identity, {
    schemaVersion: 1,
    kind: "trusted-fix-request",
    repository: c.repository,
    issueNumber: c.issueNumber,
    baseSha: c.publishedHeadSha,
    fixAttempt: 1,
    fixRequest: { runId: 7001, runAttempt: 1, artifactName: `fix-request-${c.railRunId}-fix-1-7001-attempt-1` },
    worker: { runId: 8001, runAttempt: 2 },
    model: "sonnet",
  });
  assert.equal(schema, PLAN_WORKER_OUTPUT_SCHEMA);
  assert.ok(prompt.startsWith(createFixWorkerPrompt(fixReview, 1)));
  assert.ok(prompt.endsWith(JSON.stringify([{ path: "README.md", state: "present", contentDigest: readmeDigest, content: README }])));

  const missing = createFixSubscriptionRequest({ review: fixReview, request: fixRequest, worker: { runId: 8001, runAttempt: 1 }, read: () => null });
  assert.ok(missing.prompt.endsWith(JSON.stringify([{ path: "README.md", state: "missing", contentDigest: null, content: null }])));

  const input = { review: fixReview, request: fixRequest, worker: { runId: 8001, runAttempt: 1 } };
  assert.throws(() => createFixSubscriptionRequest({ ...input, read: () => Buffer.from([0x61, 0x00]) }), /binary/);
  assert.throws(() => createFixSubscriptionRequest({ ...input, read: () => Buffer.from([0xff, 0xfe]) }), /UTF-8/);
  assert.throws(
    () => createFixSubscriptionRequest({ ...input, read: () => Buffer.alloc(FIX_CONTEXT_MAX_BYTES + 1, 0x61) }),
    /예산을 넘습니다/,
  );
  const { approvedPlanScope: _scope, sourcePlanAuthorize: _authority, ...rest } = fixReview;
  const legacy = { ...rest, sourceAuthorizationArtifactName: "authorize-approval-1-attempt-1" } as unknown as ReviewProvenance;
  assert.throws(() => createFixSubscriptionRequest({ ...input, review: legacy, read: readReviewed }), /PLAN 계보 REVIEW만 지원합니다/);
});

test("bounded FIX Worker JSON은 allowedPaths와 exact reviewed 원문 digest가 맞을 때만 파일 내용이 된다", () => {
  const modify = {
    path: "README.md",
    operation: "modify",
    baseContentDigest: readmeDigest,
    content: null,
    edits: [{ oldText: "상태: PLAN\n", newText: "상태: PLAN, VERIFY, MERGE_READY\n" }],
  };
  const proposal = (changes: unknown[], extra: Record<string, unknown> = {}) => ({ summary: "MERGE_READY 설명 추가", complete: true, changes, ...extra });
  assert.deepEqual(
    [...materializeFixSubscriptionProposal(fixReview, proposal([modify]), readReviewed)],
    [["README.md", "# Framework\n\n상태: PLAN, VERIFY, MERGE_READY\n"]],
  );
  const create = { path: "README.md", operation: "create", baseContentDigest: null, content: "# 새 README\n", edits: null };
  assert.deepEqual([...materializeFixSubscriptionProposal(fixReview, proposal([create]), () => null)], [["README.md", "# 새 README\n"]]);

  for (const [value, read, message] of [
    [proposal([modify], { extra: true }), readReviewed, /field가 올바르지 않습니다/],
    [proposal([modify], { complete: false }), readReviewed, /complete=false/],
    [proposal([]), readReviewed, /changes가 비어 있습니다/],
    [proposal([{ ...modify, path: ".github/workflows/plan.yml" }]), readReviewed, /allowedPaths 밖/],
    [proposal([modify, modify]), readReviewed, /중복/],
    [proposal([{ ...modify, baseContentDigest: "0".repeat(64) }]), readReviewed, /baseContentDigest/],
    [proposal([{ ...modify, content: "x" }]), readReviewed, /content=null/],
    [proposal([{ ...modify, edits: [{ oldText: "없는 문장", newText: "x" }] }]), readReviewed, /not found/],
    [proposal([modify]), () => null, /reviewed SHA에 없습니다/],
    [proposal([create]), readReviewed, /이미 있습니다/],
    [proposal([{ ...create, edits: [] }]), () => null, /edits=null/],
    [proposal([{ ...modify, operation: "delete" }]), readReviewed, /지원하지 않는 FIX operation/],
  ] as const) {
    assert.throws(() => materializeFixSubscriptionProposal(fixReview, value, read), message);
  }
});

test("#244 run 35999983436 모양: 승인된 slice 밖 요구(workflow/모델 변경)가 Reviewer와 FIX 입력에서 후속 범위·금지 변경으로 명시된다", () => {
  // 승인된 PLAN(run 35999092025)의 implementationScope 발췌
  const approved244 = validateApprovedPlanReviewScopeShape({
    planArtifact: { name: "plan-issue-244-35999092025-attempt-1", id: 10807511076, digest: "58dd4f11a284921adf2e17a4bac31bb92ead55469298af242ae32308011c957f" },
    approach: ["첫 bounded slice로 단계별 현재 정책 명세와 결정론적 비용·품질 비교기를 제안한다. 실행 모델 변경 없이 비교 기반을 먼저 마련하며, 실제 비용 절감과 품질 유지 여부는 후속 App cycle에서 검증한다."],
    acceptanceCriteria: ["일곱 호출 단계의 현재 정책을 구분할 수 있고, 설정되지 않은 모델 또는 effort를 특정 값으로 오인하지 않습니다."],
    allowedPaths: ["src/ai-policy-comparison.ts", "test/ai-policy-comparison.test.ts", "docs/ai-cost-policy.md"],
    requiredChanges: ["src/ai-policy-comparison.ts에 일곱 단계의 현재 모델 미지정 상태와 확인된 effort를 명세하고, 외부 의존성 없는 비교 함수를 추가합니다."],
    forbiddenChanges: [
      "기존 워크플로와 실제 모델·reasoning effort·Action 버전·권한·timeout·재시도 정책 변경",
      "외부 모델 식별자, 가격, API 사용량 필드 또는 서비스 동작을 추측한 구현",
      "AI 호출 추가, 외부 API 조회, 실측 사용량 자동 수집 또는 자동 fallback 실행",
    ],
  });
  // 실제 Reviewer가 냈던 BLOCKER 권고: forbiddenChanges 첫 항목과 정면 충돌한다.
  const actualRecommendation = "기존 실행 경로에 단계별 모델과 reasoning effort를 명시하고, 품질 문제가 관측될 때 상위 모델로 복귀할 수 있는 설정 또는 fallback 경로를 제공하세요.";
  assert.match(actualRecommendation, /모델과 reasoning effort를 명시|fallback/);
  assert.match(approved244.forbiddenChanges[0]!, /실제 모델·reasoning effort/);

  const prompt = createSemanticReviewPrompt({
    repository: "erpsarang/self-improvement-mvp",
    issueNumber: 244,
    baseSha: "0dfdd11d7d95d956ecb4dd1f5d38371864bca467",
    verifiedHeadSha: "af8949f2bdc731cc0046fb5b6b8a18191b037d33",
    requirements: { title: "[업무 요구] AI 호출 비용을 서비스 품질 저하 없이 절감하고 싶다", body: "각 AI 단계의 모델과 reasoning effort를 명시적으로 선택하고 비용·품질을 비교할 수 있어야 한다.", digest: "a".repeat(64) },
    approvedPlan: approved244,
  });
  // Reviewer는 이제 workflow/모델 변경이 금지 변경이자 후속 범위임을 본다.
  assert.ok(prompt.includes(`- ${approved244.forbiddenChanges[0]}\n`));
  assert.ok(prompt.includes("실제 비용 절감과 품질 유지 여부는 후속 App cycle에서 검증한다"));
  assert.ok(prompt.indexOf("### forbiddenChanges") < prompt.indexOf("## Issue 요구 (배경 정보이며 심사 기준이 아님)"));
  assert.match(prompt, /allowedPaths \(candidate가 변경할 수 있는 유일한 파일\)\n- src\/ai-policy-comparison\.ts\n- test\/ai-policy-comparison\.test\.ts\n- docs\/ai-cost-policy\.md\n/);
});

test("review-handler는 PLAN 계보에서만 PLAN.json을 요구하고 source 단계에서 exact PLAN artifact identity를 내보낸다", () => {
  const handler = readFileSync("src/self-improvement/review-handler.ts", "utf8");
  assert.match(handler, /writeOutput\("plan_run_id", sourcePlanAuthorize\.authorization\.plan\.runId\);/);
  assert.match(handler, /writeOutput\("plan_artifact_name", sourcePlanAuthorize\.authorization\.plan\.artifact\.name\);/);
  assert.match(handler, /reviewContext\.authorityKind === "PLAN_AUTHORIZE"\n  \? parseJson\(requiredEnv\("PLAN_JSON"\)\)\n  : undefined;/);
  assert.match(handler, /const approvedPlanScope = resolveApprovedPlanScope\(validated, approvedPlan\);/);
  // prompt와 provenance 둘 다 같은 scope를 받는다.
  assert.match(handler, /\.\.\.\(approvedPlanScope \? \{ approvedPlan: approvedPlanScope \} : \{\}\),/);
  assert.match(handler, /planAuthorizationArtifactName: reviewContext\.planAuthorizationArtifactName,\n      approvedPlan,/);
  // source 단계는 PLAN.json 없이 동작한다 (exit 전에 PLAN_JSON을 읽지 않는다).
  const sourceBlock = handler.slice(handler.indexOf('if (command === "source")'), handler.indexOf("const reviewContext"));
  assert.doesNotMatch(sourceBlock, /PLAN_JSON/);
});
