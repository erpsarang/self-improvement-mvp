import "../src/self-improvement/learn-test-execution.test.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { requirementDigest as planRequirementDigest } from "../src/self-improvement/plan-authorization.js";
import { verifyLearnInputPack } from "../src/self-improvement/learn-input-pack.js";
import { createPlanReviewChain, PLAN_REVIEW_CHAIN } from "./support/plan-review-chain.js";
import {
  createTrustedLearnSourceArtifacts,
  type TrustedLearnSourceFacts,
} from "../src/self-improvement/learn-source.js";

const title = "[업무 요구] 예외 주문 원인을 한눈에 파악하고 싶다";
const body = "예외 주문의 원인을 사유별로 집계하고 최다 사유를 보여준다.";
const requirementDigest = createHash("sha256")
  .update(JSON.stringify([title, body]), "utf8")
  .digest("hex");
const reviewedHeadSha = "fdfc6996aade470efbea1fb8ec4e4185a7dcc3fc";
const mergeCommitSha = "ab2c1e7a85e76ea69e393b81dcada11d54cd9801";
const trustedCodeSha = "bd3b6883063c1a11d23f5dff3da2d738e76e8a6c";
const frameworkSourceSha = "d35f04c7bfc9430c3cc3e7ee6af416f32ba75c42";
const artifactDigest = "4ae0287f9e902c45f267da94b58cc504d6da89f2785032ad31c0520973e19c5d";

const facts: TrustedLearnSourceFacts = {
  repository: "erpsarang/sales-order-exception-analyzer",
  defaultBranch: "main",
  requirement: {
    issueNumber: 8,
    title,
    body,
    digest: requirementDigest,
  },
  humanMerge: {
    pullRequestNumber: 24,
    merged: true,
    headSha: reviewedHeadSha,
    mergeCommitSha,
    mergedAt: "2026-09-15T12:27:59Z",
    baseBranch: "main",
  },
  trustedRail: {
    runId: 34968101704,
    runAttempt: 1,
    status: "completed",
    conclusion: "success",
    workflowPath: ".github/workflows/trusted-rail.yml",
    headBranch: "main",
    headSha: trustedCodeSha,
  },
  orchestrationArtifact: {
    name: "orchestration-provenance-issue-8-34968101704-attempt-1",
    id: 10395838542,
    digest: `sha256:${artifactDigest}`,
  },
  frameworkSourceSha,
};

function orchestration() {
  return {
    type: "ORCHESTRATION",
    repository: facts.repository,
    issueNumber: 8,
    fromState: "REVIEWING",
    decision: "PASS",
    nextState: "MERGE_READY",
    completedFixCount: 0,
    reviewedHeadSha,
    requirementsDigest: requirementDigest,
    orchestratorWorkflow: {
      workflowPath: ".github/workflows/orchestrator.yml",
      runId: 34968101704,
      runAttempt: 1,
      trustedCodeSha,
    },
    sourceReview: {
      type: "REVIEW",
      decision: "PASS",
      reviewedHeadSha,
      requirementsDigest: requirementDigest,
      summary: "요구사항을 충족했고 주요 문제는 발견되지 않았다.",
      findings: [],
      reviewWorkflow: {
        workflowPath: ".github/workflows/trusted-rail.yml",
        runId: 34968101704,
        runAttempt: 1,
        trustedCodeSha,
      },
    },
    mergeBoundary: {
      type: "HUMAN_PULL_REQUEST",
      number: 24,
      baseBranch: "main",
      headSha: reviewedHeadSha,
    },
  };
}

test("Human Merge 완료 cycle에서 deterministic Completed Cycle / LEARN Input Pack을 생성한다", () => {
  const first = createTrustedLearnSourceArtifacts(facts, orchestration());
  const second = createTrustedLearnSourceArtifacts(facts, orchestration());

  assert.deepEqual(first, second);
  assert.equal(first.completedCycle.kind, "trusted-completed-cycle-record");
  assert.equal(first.completedCycle.requirement.issueNumber, 8);
  assert.equal(first.completedCycle.humanMerge.pullRequestNumber, 24);
  assert.equal(first.completedCycle.source.review.reviewedHeadSha, reviewedHeadSha);
  assert.equal(first.completedCycle.source.trustedRail.runId, 34968101704);
  assert.equal(first.completedCycle.source.frameworkSourceSha, frameworkSourceSha);
  assert.equal(first.learnInputPack.kind, "trusted-learn-input-pack");
  assert.equal(first.learnInputPack.completedCycle.recordDigest, first.completedCycle.recordDigest);
  assert.deepEqual(
    first.learnInputPack.evidence.map(({ evidenceId }) => evidenceId),
    ["final-review-01", "human-boundary-01", "orchestration-01", "requirement-01"],
  );
  assert.equal(first.completedCycleArtifactName, "completed-cycle-issue-8-pr-24");
  assert.match(first.learnInputArtifactName, /^learn-input-issue-8-pr-24-record-[0-9a-f]{64}$/);
});

test("requirement / Human Merge / Trusted Rail GitHub facts가 exact하지 않으면 fail-closed 한다", () => {
  assert.throws(
    () => createTrustedLearnSourceArtifacts({
      ...facts,
      requirement: { ...facts.requirement, digest: "1".repeat(64) },
    }, orchestration()),
    /requirement digest/,
  );
  assert.throws(
    () => createTrustedLearnSourceArtifacts({
      ...facts,
      humanMerge: { ...facts.humanMerge, merged: false },
    }, orchestration()),
    /actually merged/,
  );
  assert.throws(
    () => createTrustedLearnSourceArtifacts({
      ...facts,
      trustedRail: { ...facts.trustedRail, conclusion: "failure" },
    }, orchestration()),
    /completed success/,
  );
  assert.throws(
    () => createTrustedLearnSourceArtifacts({
      ...facts,
      trustedRail: { ...facts.trustedRail, workflowPath: ".github/workflows/other.yml" },
    }, orchestration()),
    /workflow path mismatch/,
  );
});

test("Semantic REVIEW / MERGE_READY / exact source identity drift를 거부한다", () => {
  assert.throws(
    () => createTrustedLearnSourceArtifacts(facts, { ...orchestration(), decision: "LOCAL_FIX" }),
    /decision must be PASS/,
  );
  assert.throws(
    () => createTrustedLearnSourceArtifacts(facts, { ...orchestration(), nextState: "STOPPED" }),
    /nextState must be MERGE_READY/,
  );
  assert.throws(
    () => createTrustedLearnSourceArtifacts(facts, {
      ...orchestration(),
      sourceReview: { ...orchestration().sourceReview, reviewedHeadSha: "1".repeat(40) },
    }),
    /reviewed SHA mismatch/,
  );
  assert.throws(
    () => createTrustedLearnSourceArtifacts(facts, {
      ...orchestration(),
      mergeBoundary: { ...orchestration().mergeBoundary, number: 25 },
    }),
    /PR number/,
  );
  assert.throws(
    () => createTrustedLearnSourceArtifacts(facts, {
      ...orchestration(),
      orchestratorWorkflow: { ...orchestration().orchestratorWorkflow, runAttempt: 2 },
    }),
    /run identity/,
  );
});

test("recovery guard가 provenance에 실제 존재할 때만 bounded recovery evidence를 포함한다", () => {
  const normal = createTrustedLearnSourceArtifacts(facts, orchestration());
  assert.equal(normal.learnInputPack.evidence.some(({ evidenceId }) => evidenceId === "recovery-01"), false);

  const source = orchestration();
  const recovered = {
    ...source,
    sourceReview: {
      ...source.sourceReview,
      sourceVerify: {
        sourcePublish: {
          sourceSeal: {
            sourcePlanBridge: {
              bridge: {
                recoveryGuard: {
                  kind: "trusted-recovery-compare-v1",
                  baseSha: "4309db58905eacbe33c8d1378646babd63bcf7c1",
                  currentDefaultSha: trustedCodeSha,
                },
              },
            },
          },
        },
      },
    },
  };
  const result = createTrustedLearnSourceArtifacts(facts, recovered);
  assert.equal(result.learnInputPack.evidence.some(({ evidenceId }) => evidenceId === "recovery-01"), true);
});

// Reuse the canonical PLAN provenance fixture shared by REVIEW and FIX tests.
function planExecutionFixture() {
  const chain = createPlanReviewChain();
  const c = PLAN_REVIEW_CHAIN;
  const workflow = {
    workflowPath: ".github/workflows/trusted-rail.yml",
    runId: c.railRunId,
    runAttempt: 1,
    trustedCodeSha: c.trustedCodeSha,
  };
  const facts: TrustedLearnSourceFacts = {
    repository: c.repository,
    defaultBranch: "main",
    requirement: { issueNumber: c.issueNumber, title: c.title, body: c.body,
      digest: planRequirementDigest(c.title, c.body) },
    humanMerge: { pullRequestNumber: 24, merged: true, headSha: c.publishedHeadSha,
      mergeCommitSha: "a".repeat(40), mergedAt: "2026-09-15T12:27:59Z", baseBranch: "main" },
    trustedRail: { ...workflow, status: "completed", conclusion: "success",
      headBranch: "main", headSha: c.trustedCodeSha },
    orchestrationArtifact: { name: `orchestration-provenance-issue-${c.issueNumber}-${c.railRunId}-attempt-1`,
      id: 100, digest: "d".repeat(64) },
    frameworkSourceSha: c.targetSha,
  };
  const verify = chain.verify;
  const publish = verify.sourcePublish;
  const seal = publish.sourceSeal;
  const orchestration = {
    type: "ORCHESTRATION", repository: c.repository, issueNumber: c.issueNumber,
    decision: "PASS", nextState: "MERGE_READY", reviewedHeadSha: c.publishedHeadSha,
    requirementsDigest: facts.requirement.digest,
    orchestratorWorkflow: { ...workflow, workflowPath: ".github/workflows/orchestrator.yml" },
    sourceReview: { decision: "PASS", reviewedHeadSha: c.publishedHeadSha,
      requirementsDigest: facts.requirement.digest, reviewWorkflow: workflow,
      sourceVerifyArtifactName: chain.verifyArtifactName, sourceVerify: verify },
    mergeBoundary: { type: "HUMAN_PULL_REQUEST", number: 24,
      headSha: c.publishedHeadSha, baseBranch: "main" },
  };
  return { facts, orchestration, bridge: chain.bridge, seal, publish, verify };
}

function fixedExecutionFixture() {
  const original = planExecutionFixture();
  const candidateBDigest = `sha256:${"8".repeat(64)}`;
  const candidateCDigest = `sha256:${"9".repeat(64)}`;
  const candidateAHeadSha = original.publish.publishedHeadSha;
  const candidateBHeadSha = "f".repeat(40);
  const candidateCHeadSha = "d".repeat(40);
  const firstReviewRunId = 480;
  const firstRequestRunId = 481;
  const firstFixRunId = 482;
  const secondReviewRunId = 490;
  const secondRequestRunId = 491;
  const secondFixRunId = 492;
  const branch = "ai-publish/issue-83";
  const controlPlaneSha = original.facts.trustedRail.headSha;
  const requirementsDigest = original.bridge.requirement.digest;

  // The first LOCAL_FIX review is bound to candidate A's published head.
  const firstReview = {
    artifactName: `review-provenance-issue-83-${firstReviewRunId}-attempt-1`,
    runId: firstReviewRunId,
    runAttempt: 1,
    reviewedBranch: branch,
    reviewedHeadSha: candidateAHeadSha,
    requirementsDigest,
    findingsDigest: `sha256:${"1".repeat(64)}`,
  };
  const firstFix = {
    workflowPath: ".github/workflows/fix-worker.yml",
    runId: firstFixRunId,
    runAttempt: 1,
    controlPlaneSha,
    candidateArtifactName: `implement-candidate-${firstRequestRunId}-${firstFixRunId}-attempt-1`,
    candidatePatchDigest: candidateBDigest,
    fixAttempt: 1,
    sourceReview: firstReview,
    sourceRequest: {
      workflowPath: ".github/workflows/fix-request.yml",
      runId: firstRequestRunId,
      runAttempt: 1,
      artifactName: `fix-request-${firstReviewRunId}-fix-1-${firstRequestRunId}-attempt-1`,
      trustedCodeSha: controlPlaneSha,
    },
    aiExecution: { provider: "openai-codex-action", resultId: "codex-action-run:482:1" },
  };
  const firstSeal = {
    ...original.seal,
    baseSha: firstReview.reviewedHeadSha,
    sealedPatchDigest: candidateBDigest,
    sourceFix: firstFix,
  };
  const firstPublish = {
    ...original.publish,
    baseSha: firstReview.reviewedHeadSha,
    sourceSealArtifactName: `sealed-candidate-${firstFixRunId}-attempt-1-500-attempt-1`,
    sourceSeal: firstSeal,
    publishedBranch: branch,
    publishedHeadSha: candidateBHeadSha,
  };
  const firstVerify = {
    ...original.verify,
    sourcePublish: firstPublish,
    verifiedBranch: branch,
    verifiedHeadSha: candidateBHeadSha,
  };
  const secondReview = {
    decision: "LOCAL_FIX",
    reviewedBranch: branch,
    reviewedHeadSha: candidateBHeadSha,
    requirementsDigest,
    reviewWorkflow: {
      workflowPath: ".github/workflows/trusted-rail.yml",
      runId: secondReviewRunId,
      runAttempt: 1,
      trustedCodeSha: controlPlaneSha,
    },
    sourceVerify: firstVerify,
  };
  const sourceFix = {
    workflowPath: ".github/workflows/fix-worker.yml",
    runId: secondFixRunId,
    runAttempt: 1,
    controlPlaneSha,
    candidateArtifactName: `implement-candidate-${secondRequestRunId}-${secondFixRunId}-attempt-1`,
    candidatePatchDigest: candidateCDigest,
    fixAttempt: 2,
    sourceReview: {
      ...secondReview,
      artifactName: `review-provenance-issue-83-${secondReviewRunId}-attempt-1`,
      runId: secondReview.reviewWorkflow.runId,
      runAttempt: secondReview.reviewWorkflow.runAttempt,
      reviewedBranch: secondReview.reviewedBranch,
      reviewedHeadSha: secondReview.reviewedHeadSha,
      requirementsDigest: secondReview.requirementsDigest,
      findingsDigest: `sha256:${"2".repeat(64)}`,
    },
    sourceRequest: {
      workflowPath: ".github/workflows/fix-request.yml",
      runId: secondRequestRunId,
      runAttempt: 1,
      artifactName: `fix-request-${secondReviewRunId}-fix-2-${secondRequestRunId}-attempt-1`,
      trustedCodeSha: controlPlaneSha,
    },
    aiExecution: { provider: "openai-codex-action", resultId: "codex-action-run:492:1" },
  };
  const seal = {
    ...original.seal,
    baseSha: secondReview.reviewedHeadSha,
    sealedPatchDigest: candidateCDigest,
    sourceFix,
  };
  const publish = {
    ...original.publish,
    baseSha: secondReview.reviewedHeadSha,
    sourceSealArtifactName: `sealed-candidate-${secondFixRunId}-attempt-1-500-attempt-1`,
    sourceSeal: seal,
    publishedBranch: branch,
    publishedHeadSha: candidateCHeadSha,
  };
  const verify = {
    ...original.verify,
    sourcePublish: publish,
    verifiedBranch: publish.publishedBranch,
    verifiedHeadSha: candidateCHeadSha,
  };
  const facts = {
    ...original.facts,
    humanMerge: { ...original.facts.humanMerge, headSha: candidateCHeadSha },
  };
  const orchestration = {
    ...original.orchestration,
    completedFixCount: 2,
    reviewedHeadSha: candidateCHeadSha,
    sourceReview: { ...original.orchestration.sourceReview, reviewedHeadSha: candidateCHeadSha,
      sourceVerify: verify },
    mergeBoundary: { ...original.orchestration.mergeBoundary, headSha: candidateCHeadSha },
  };
  return { ...original, facts, orchestration, firstFix, firstSeal, firstPublish, firstVerify,
    secondReview, seal, sourceFix, candidateAHeadSha, candidateBDigest, candidateBHeadSha,
    candidateCDigest, candidateCHeadSha };
}

test("LEARN Source accepts a completed cycle without FIX and binds execution evidence", () => {
  const fixture = planExecutionFixture();
  const result = createTrustedLearnSourceArtifacts(fixture.facts, fixture.orchestration);
  verifyLearnInputPack(result.learnInputPack, result.completedCycle);
  const item = result.learnInputPack.evidence.find(({ evidenceId }) => evidenceId === "test-execution-01");
  if (!item) throw new Error("missing test execution evidence");
  const execution = JSON.parse(item.content);
  assert.equal(execution.candidatePatchDigest, fixture.bridge.candidatePatchDigest);
  assert.equal(execution.sealedPatchDigest, fixture.bridge.candidatePatchDigest);
  assert.equal(execution.reviewedHeadSha, result.completedCycle.source.review.reviewedHeadSha);
  assert.equal(item.cycle.recordDigest, result.completedCycle.recordDigest);
  assert.equal(result.learnInputPack.completedCycle.recordDigest, result.completedCycle.recordDigest);
});

test("LEARN Source accepts FIX1 candidate B followed by FIX2 candidate C", () => {
  const fixture = fixedExecutionFixture();
  const finalVerify = fixture.orchestration.sourceReview.sourceVerify;
  const finalPublish = finalVerify.sourcePublish;
  const finalSeal = finalPublish.sourceSeal;
  const finalFix = finalSeal.sourceFix;
  const reviewAfterFix1 = finalFix.sourceReview;
  const verifyAfterFix1 = reviewAfterFix1.sourceVerify;
  const publishAfterFix1 = verifyAfterFix1.sourcePublish;
  const sealAfterFix1 = publishAfterFix1.sourceSeal;
  assert.equal(sealAfterFix1.sourceFix, fixture.firstFix);
  assert.equal(fixture.firstFix.sourceReview.reviewedHeadSha, fixture.candidateAHeadSha);
  assert.equal(sealAfterFix1.sealedPatchDigest, fixture.candidateBDigest);
  assert.equal(publishAfterFix1.publishedHeadSha, fixture.candidateBHeadSha);
  assert.equal(verifyAfterFix1.verifiedHeadSha, fixture.candidateBHeadSha);
  assert.equal(reviewAfterFix1.decision, fixture.secondReview.decision);
  assert.equal(reviewAfterFix1.reviewWorkflow, fixture.secondReview.reviewWorkflow);
  assert.equal(reviewAfterFix1.reviewedHeadSha, verifyAfterFix1.verifiedHeadSha);
  assert.equal(reviewAfterFix1.runId, fixture.secondReview.reviewWorkflow.runId);
  assert.equal(finalSeal.baseSha, reviewAfterFix1.reviewedHeadSha);
  assert.equal(finalSeal.sealedPatchDigest, fixture.candidateCDigest);
  assert.equal(finalPublish.publishedHeadSha, fixture.candidateCHeadSha);
  assert.equal(finalVerify.verifiedHeadSha, fixture.candidateCHeadSha);
  assert.equal(fixture.orchestration.sourceReview.reviewedHeadSha, fixture.candidateCHeadSha);
  assert.equal(fixture.facts.humanMerge.headSha, fixture.candidateCHeadSha);
  assert.notEqual(fixture.candidateAHeadSha, fixture.candidateBHeadSha);
  assert.notEqual(fixture.candidateBHeadSha, fixture.candidateCHeadSha);
  assert.notEqual(fixture.bridge.candidatePatchDigest, fixture.candidateBDigest);
  assert.notEqual(fixture.candidateBDigest, fixture.candidateCDigest);
  assert.notEqual(fixture.bridge.candidatePatchDigest, fixture.candidateCDigest);

  const result = createTrustedLearnSourceArtifacts(fixture.facts, fixture.orchestration);
  verifyLearnInputPack(result.learnInputPack, result.completedCycle);
  const item = result.learnInputPack.evidence.find(({ evidenceId }) => evidenceId === "test-execution-01");
  if (!item) throw new Error("missing test execution evidence");
  const execution = JSON.parse(item.content);
  assert.equal(execution.candidatePatchDigest, fixture.bridge.candidatePatchDigest);
  assert.equal(execution.sealedPatchDigest, fixture.candidateCDigest);
  assert.equal(execution.baseSha, fixture.bridge.baseSha);
  assert.equal(execution.reviewedHeadSha, fixture.facts.humanMerge.headSha);
  assert.equal(item.cycle.recordDigest, result.completedCycle.recordDigest);
  assert.equal(item.cycle.reviewedHeadSha, result.completedCycle.source.review.reviewedHeadSha);
  assert.equal(result.learnInputPack.completedCycle.recordDigest, result.completedCycle.recordDigest);
});

test("LEARN Source rejects tampered final FIX provenance", () => {
  const fixture = fixedExecutionFixture();
  const mutations = [
    (sourceFix: typeof fixture.sourceFix) => { sourceFix.candidatePatchDigest = `sha256:${"7".repeat(64)}`; },
    (sourceFix: typeof fixture.sourceFix) => { sourceFix.sourceReview.reviewedHeadSha = "7".repeat(40); },
    (sourceFix: typeof fixture.sourceFix) => { sourceFix.sourceReview.requirementsDigest = `sha256:${"7".repeat(64)}`; },
    (sourceFix: typeof fixture.sourceFix) => { sourceFix.sourceReview.artifactName += "-wrong"; },
    (sourceFix: typeof fixture.sourceFix) => { sourceFix.sourceRequest.artifactName += "-wrong"; },
    (sourceFix: typeof fixture.sourceFix) => { sourceFix.sourceRequest.trustedCodeSha = "7".repeat(40); },
    (sourceFix: typeof fixture.sourceFix) => { sourceFix.controlPlaneSha = "7".repeat(40); },
    (sourceFix: typeof fixture.sourceFix) => { sourceFix.candidateArtifactName += "-wrong"; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(fixture.orchestration);
    mutate(changed.sourceReview.sourceVerify.sourcePublish.sourceSeal.sourceFix);
    assert.throws(() => createTrustedLearnSourceArtifacts(fixture.facts, changed));
  }
});

test("LEARN Source rejects final SEAL, reviewed SHA, merged PR, and Trusted Rail identity drift after FIX", () => {
  const fixture = fixedExecutionFixture();
  for (const field of ["baseSha", "sealedPatchDigest"] as const) {
    const changed = structuredClone(fixture.orchestration);
    const seal = changed.sourceReview.sourceVerify.sourcePublish.sourceSeal;
    if (field === "baseSha") seal.baseSha = "7".repeat(40);
    else seal.sealedPatchDigest = `sha256:${"7".repeat(64)}`;
    assert.throws(() => createTrustedLearnSourceArtifacts(fixture.facts, changed));
  }
  assert.throws(() => createTrustedLearnSourceArtifacts(fixture.facts, {
    ...fixture.orchestration, reviewedHeadSha: "7".repeat(40),
  }), /reviewed exact SHA/);
  assert.throws(() => createTrustedLearnSourceArtifacts(fixture.facts, {
    ...fixture.orchestration,
    mergeBoundary: { ...fixture.orchestration.mergeBoundary, number: 25 },
  }), /PR number/);
  assert.throws(() => createTrustedLearnSourceArtifacts(fixture.facts, {
    ...fixture.orchestration,
    orchestratorWorkflow: { ...fixture.orchestration.orchestratorWorkflow, runAttempt: 2 },
  }), /run identity/);
});
