import assert from "node:assert/strict";
import test from "node:test";
import {
  createCompletedCycleRecord,
  type CompletedCycleEvidence,
} from "../src/self-improvement/completed-cycle.js";
import {
  LEARN_INPUT_BUDGET,
  createLearnInputPack,
  learnInputPackArtifactName,
  verifyLearnInputPack,
  type LearnEvidenceInput,
  type LearnInputPack,
} from "../src/self-improvement/learn-input-pack.js";

const requirementDigest = "52c35e90af7cb1681c69c3eb980bdc0c85ec452a712cef42b91b18e512300714";
const reviewedHeadSha = "fdfc6996aade470efbea1fb8ec4e4185a7dcc3fc";
const mergeCommitSha = "ab2c1e7a85e76ea69e393b81dcada11d54cd9801";
const controlPlaneSha = "bd3b6883063c1a11d23f5dff3da2d738e76e8a6c";
const frameworkSourceSha = "d35f04c7bfc9430c3cc3e7ee6af416f32ba75c42";
const orchestrationDigest = "4ae0287f9e902c45f267da94b58cc504d6da89f2785032ad31c0520973e19c5d";

const completedEvidence: CompletedCycleEvidence = {
  repository: "erpsarang/sales-order-exception-analyzer",
  requirement: { issueNumber: 8, digest: requirementDigest },
  mergedPullRequest: {
    number: 24,
    merged: true,
    headSha: reviewedHeadSha,
    mergeCommitSha,
    mergedAt: "2026-09-15T12:27:59Z",
  },
  source: {
    requirement: { issueNumber: 8, digest: requirementDigest },
    review: { decision: "PASS", reviewedHeadSha },
    trustedRail: {
      runId: 34968101704,
      runAttempt: 1,
      controlPlaneSha,
    },
    orchestrationProvenance: {
      artifact: {
        name: "orchestration-provenance-issue-8-34968101704-attempt-1",
        id: 10395838542,
        digest: `sha256:${orchestrationDigest}`,
      },
    },
    frameworkSourceSha,
  },
};

const record = createCompletedCycleRecord(completedEvidence);

function cycleBinding() {
  return {
    recordDigest: record.recordDigest,
    requirementIssueNumber: 8,
    humanMergePullRequestNumber: 24,
    reviewedHeadSha,
  } as const;
}

const evidence: readonly LearnEvidenceInput[] = [
  {
    evidenceId: "01-requirement",
    kind: "requirement-summary",
    repository: record.repository,
    cycle: cycleBinding(),
    source: { kind: "issue", issueNumber: 8 },
    content: "Issue #8은 예외 주문의 사유별 건수와 최다 사유를 summary에서 확인하는 업무 요구다.",
  },
  {
    evidenceId: "02-final-review",
    kind: "final-review",
    repository: record.repository,
    cycle: cycleBinding(),
    source: {
      kind: "artifact",
      artifactId: 10395523751,
      name: "review-provenance-issue-8-34968101704-attempt-1",
      digest: `sha256:${"e13f242c0e2d7ce1e431784ffc950fa74915459db153ed4a01e7cf3537657ffd"}`,
    },
    content: `Semantic REVIEW는 PASS였고 reviewed exact SHA는 ${reviewedHeadSha}다.`,
  },
  {
    evidenceId: "03-orchestration",
    kind: "orchestration-summary",
    repository: record.repository,
    cycle: cycleBinding(),
    source: { kind: "workflow-run", runId: 34968101704, runAttempt: 1 },
    content: "Trusted Rail은 SEAL → PUBLISH → VERIFY → REVIEW → MERGE_READY를 완료했다.",
  },
  {
    evidenceId: "04-recovery",
    kind: "recovery-event",
    repository: record.repository,
    cycle: cycleBinding(),
    source: { kind: "workflow-run", runId: 34965399707, runAttempt: 1 },
    content: "오래된 정상 Worker candidate를 recovery guard 아래에서 재사용했고 legacy Handoff freshness 충돌을 수정했다.",
  },
  {
    evidenceId: "05-human-merge",
    kind: "human-boundary",
    repository: record.repository,
    cycle: cycleBinding(),
    source: { kind: "pull-request", pullRequestNumber: 24 },
    content: "최종 Merge는 자동화하지 않았고 사람이 PR #24를 직접 Merge했다.",
  },
];

test("Completed Cycle Record와 bounded evidence를 deterministic LEARN Input Pack으로 고정한다", () => {
  const first = createLearnInputPack(record, evidence);
  const second = createLearnInputPack(record, [...evidence].reverse());

  assert.deepEqual(first, second);
  assert.equal(first.kind, "trusted-learn-input-pack");
  assert.equal(first.completedCycle.recordDigest, record.recordDigest);
  assert.equal(first.completedCycle.repository, record.repository);
  assert.equal(first.completedCycle.requirementIssueNumber, 8);
  assert.equal(first.completedCycle.humanMergePullRequestNumber, 24);
  assert.equal(first.completedCycle.reviewedHeadSha, reviewedHeadSha);
  assert.equal(first.completedCycle.mergeCommitSha, mergeCommitSha);
  assert.equal(first.completedCycle.trustedRailRunId, 34968101704);
  assert.equal(first.frameworkSourceSha, frameworkSourceSha);
  assert.deepEqual(first.budget, LEARN_INPUT_BUDGET);
  assert.equal(first.evidenceCount, evidence.length);
  assert.deepEqual(first.evidence.map(({ evidenceId }) => evidenceId), [
    "01-requirement",
    "02-final-review",
    "03-orchestration",
    "04-recovery",
    "05-human-merge",
  ]);
  assert.match(first.packDigest, /^[0-9a-f]{64}$/);
  assert.doesNotThrow(() => verifyLearnInputPack(first, record));
  assert.equal(
    learnInputPackArtifactName(record),
    `learn-input-issue-8-pr-24-record-${record.recordDigest}`,
  );
});

test("artifact source digest의 sha256 transport prefix를 canonical raw hex로 정규화한다", () => {
  const pack = createLearnInputPack(record, evidence);
  const finalReview = pack.evidence.find(({ evidenceId }) => evidenceId === "02-final-review");
  assert.ok(finalReview);
  assert.equal(finalReview.source.kind, "artifact");
  if (finalReview.source.kind === "artifact") {
    assert.equal(finalReview.source.digest, "e13f242c0e2d7ce1e431784ffc950fa74915459db153ed4a01e7cf3537657ffd");
  }
});

test("다른 repository나 completed cycle identity를 가리키는 evidence는 fail-closed 한다", () => {
  assert.throws(
    () => createLearnInputPack(record, [{ ...evidence[0]!, repository: "erpsarang/other-repo" }]),
    /repository mismatch/,
  );
  assert.throws(
    () => createLearnInputPack(record, [{
      ...evidence[0]!,
      cycle: { ...cycleBinding(), recordDigest: "1".repeat(64) },
    }]),
    /completed-cycle identity mismatch/,
  );
  assert.throws(
    () => createLearnInputPack(record, [{
      ...evidence[0]!,
      cycle: { ...cycleBinding(), reviewedHeadSha: "2".repeat(40) },
    }]),
    /completed-cycle identity mismatch/,
  );
});

test("Issue/PR evidence는 완료 cycle의 exact Requirement/ Human Merge PR만 참조한다", () => {
  assert.throws(
    () => createLearnInputPack(record, [{
      ...evidence[0]!,
      source: { kind: "issue", issueNumber: 9 },
    }]),
    /completed-cycle requirement Issue/,
  );
  assert.throws(
    () => createLearnInputPack(record, [{
      ...evidence[4]!,
      source: { kind: "pull-request", pullRequestNumber: 23 },
    }]),
    /completed-cycle Human Merge PR/,
  );
});

test("unknown evidence kind와 kind에 맞지 않는 source를 거부한다", () => {
  const unknown = {
    ...evidence[0]!,
    kind: "repository-dump",
  } as unknown as LearnEvidenceInput;
  assert.throws(() => createLearnInputPack(record, [unknown]), /unsupported LEARN evidence kind/);

  const wrongSource = {
    ...evidence[0]!,
    source: { kind: "workflow-run", runId: 1, runAttempt: 1 },
  } as LearnEvidenceInput;
  assert.throws(() => createLearnInputPack(record, [wrongSource]), /unsupported source kind/);
});

test("empty content, duplicate evidenceId, invalid artifact digest를 거부한다", () => {
  assert.throws(
    () => createLearnInputPack(record, [{ ...evidence[0]!, content: "   " }]),
    /content must be non-empty/,
  );
  assert.throws(
    () => createLearnInputPack(record, [evidence[0]!, { ...evidence[1]!, evidenceId: evidence[0]!.evidenceId }]),
    /must be unique/,
  );
  assert.throws(
    () => createLearnInputPack(record, [{
      ...evidence[1]!,
      source: {
        kind: "artifact",
        artifactId: 10395523751,
        name: "review-provenance",
        digest: "invalid",
      },
    }]),
    /SHA-256 digest/,
  );
});

test("item/count/total byte budget을 초과하면 fail-closed 한다", () => {
  assert.throws(
    () => createLearnInputPack(record, [{ ...evidence[0]!, content: "x".repeat(LEARN_INPUT_BUDGET.maxItemBytes + 1) }]),
    /maxItemBytes/,
  );

  const tooMany = Array.from({ length: LEARN_INPUT_BUDGET.maxEvidenceItems + 1 }, (_, index) => ({
    ...evidence[2]!,
    evidenceId: `run-${String(index).padStart(2, "0")}`,
    source: { kind: "workflow-run" as const, runId: 1000 + index, runAttempt: 1 },
  }));
  assert.throws(() => createLearnInputPack(record, tooMany), /maxEvidenceItems/);

  const tooLargeTotal = Array.from({ length: 9 }, (_, index) => ({
    ...evidence[2]!,
    evidenceId: `large-${String(index).padStart(2, "0")}`,
    source: { kind: "workflow-run" as const, runId: 2000 + index, runAttempt: 1 },
    content: "x".repeat(LEARN_INPUT_BUDGET.maxItemBytes),
  }));
  assert.throws(() => createLearnInputPack(record, tooLargeTotal), /maxTotalBytes/);
});

test("content/source/budget/pack digest 위변조를 verifier가 거부한다", () => {
  const pack = createLearnInputPack(record, evidence);

  const forgedContent: LearnInputPack = {
    ...pack,
    evidence: pack.evidence.map((item, index) => index === 0 ? { ...item, content: `${item.content} tampered` } : item),
  };
  assert.throws(() => verifyLearnInputPack(forgedContent, record), /digest|canonical shape|byte/);

  const forgedBudget: LearnInputPack = {
    ...pack,
    budget: { ...pack.budget, maxTotalBytes: pack.budget.maxTotalBytes + 1 },
  };
  assert.throws(() => verifyLearnInputPack(forgedBudget, record), /resource budget mismatch/);

  const forgedPackDigest: LearnInputPack = { ...pack, packDigest: "3".repeat(64) };
  assert.throws(() => verifyLearnInputPack(forgedPackDigest, record), /digest|canonical shape/);
});
