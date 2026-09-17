import "../src/self-improvement/learn-test-execution.test.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
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
