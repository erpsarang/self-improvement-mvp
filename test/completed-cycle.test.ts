import assert from "node:assert/strict";
import test from "node:test";
import {
  completedCycleRecordArtifactName,
  createCompletedCycleRecord,
  verifyCompletedCycleRecord,
  type CompletedCycleEvidence,
  type CompletedCycleRecord,
} from "../src/self-improvement/completed-cycle.js";

const requirementDigest = "52c35e90af7cb1681c69c3eb980bdc0c85ec452a712cef42b91b18e512300714";
const reviewedHeadSha = "fdfc6996aade470efbea1fb8ec4e4185a7dcc3fc";
const mergeCommitSha = "ab2c1e7a85e76ea69e393b81dcada11d54cd9801";
const controlPlaneSha = "bd3b6883063c1a11d23f5dff3da2d738e76e8a6c";
const frameworkSourceSha = "d35f04c7bfc9430c3cc3e7ee6af416f32ba75c42";
const orchestrationDigest = "4ae0287f9e902c45f267da94b58cc504d6da89f2785032ad31c0520973e19c5d";

const evidence: CompletedCycleEvidence = {
  repository: "erpsarang/sales-order-exception-analyzer",
  requirement: {
    issueNumber: 8,
    digest: requirementDigest,
  },
  mergedPullRequest: {
    number: 24,
    merged: true,
    headSha: reviewedHeadSha,
    mergeCommitSha,
    mergedAt: "2026-09-15T12:27:59Z",
  },
  source: {
    requirement: {
      issueNumber: 8,
      digest: requirementDigest,
    },
    review: {
      decision: "PASS",
      reviewedHeadSha,
    },
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

test("Issue #8 Human Merge 완료 사실을 deterministic completed cycle record로 고정한다", () => {
  const first = createCompletedCycleRecord(evidence);
  const second = createCompletedCycleRecord(evidence);

  assert.deepEqual(first, second);
  assert.equal(first.kind, "trusted-completed-cycle-record");
  assert.deepEqual(first.requirement, { issueNumber: 8, digest: requirementDigest });
  assert.equal(first.humanMerge.pullRequestNumber, 24);
  assert.equal(first.humanMerge.headSha, reviewedHeadSha);
  assert.equal(first.humanMerge.mergeCommitSha, mergeCommitSha);
  assert.equal(first.source.review.decision, "PASS");
  assert.equal(first.source.trustedRail.runId, 34968101704);
  assert.equal(first.source.trustedRail.controlPlaneSha, controlPlaneSha);
  assert.equal(first.source.frameworkSourceSha, frameworkSourceSha);
  assert.equal(first.source.orchestrationProvenance.artifact.digest, orchestrationDigest);
  assert.match(first.recordDigest, /^[0-9a-f]{64}$/);
  assert.doesNotThrow(() => verifyCompletedCycleRecord(first));
  assert.equal(completedCycleRecordArtifactName(evidence), "completed-cycle-issue-8-pr-24");
});

test("SHA-256 transport prefix 차이는 canonical record에서 동일하게 정규화한다", () => {
  const prefixed: CompletedCycleEvidence = {
    ...evidence,
    requirement: { ...evidence.requirement, digest: `sha256:${requirementDigest}` },
    source: {
      ...evidence.source,
      requirement: { ...evidence.source.requirement, digest: `sha256:${requirementDigest}` },
      orchestrationProvenance: {
        artifact: { ...evidence.source.orchestrationProvenance.artifact, digest: orchestrationDigest },
      },
    },
  };

  assert.deepEqual(createCompletedCycleRecord(prefixed), createCompletedCycleRecord(evidence));
});

test("merge되지 않은 PR은 completed cycle로 기록하지 않는다", () => {
  assert.throws(
    () => createCompletedCycleRecord({
      ...evidence,
      mergedPullRequest: { ...evidence.mergedPullRequest, merged: false },
    }),
    /actually merged/,
  );
});

test("Human Merge PR HEAD가 reviewed exact SHA와 다르면 fail-closed 한다", () => {
  assert.throws(
    () => createCompletedCycleRecord({
      ...evidence,
      mergedPullRequest: { ...evidence.mergedPullRequest, headSha: "1".repeat(40) },
    }),
    /head SHA must equal reviewed exact SHA/,
  );
});

test("requirement identity가 source provenance와 다르면 fail-closed 한다", () => {
  assert.throws(
    () => createCompletedCycleRecord({
      ...evidence,
      requirement: { ...evidence.requirement, digest: "2".repeat(64) },
    }),
    /requirement identity does not match source provenance/,
  );
});

test("final REVIEW가 PASS가 아니면 completed cycle로 기록하지 않는다", () => {
  assert.throws(
    () => createCompletedCycleRecord({
      ...evidence,
      source: {
        ...evidence.source,
        review: { ...evidence.source.review, decision: "LOCAL_FIX" },
      },
    }),
    /final REVIEW decision must be PASS/,
  );
});

test("merge identity와 source provenance 위변조는 verifier에서 거부한다", () => {
  const record = createCompletedCycleRecord(evidence);

  const wrongMerge: CompletedCycleRecord = {
    ...record,
    humanMerge: { ...record.humanMerge, mergeCommitSha: "3".repeat(40) },
  };
  assert.throws(() => verifyCompletedCycleRecord(wrongMerge), /digest|canonical shape/);

  const wrongSource: CompletedCycleRecord = {
    ...record,
    source: {
      ...record.source,
      orchestrationProvenance: {
        artifact: { ...record.source.orchestrationProvenance.artifact, id: 999999 },
      },
    },
  };
  assert.throws(() => verifyCompletedCycleRecord(wrongSource), /digest|canonical shape/);
});

test("merge commit, merged_at, source run/artifact identity가 없거나 잘못되면 fail-closed 한다", () => {
  assert.throws(
    () => createCompletedCycleRecord({
      ...evidence,
      mergedPullRequest: { ...evidence.mergedPullRequest, mergeCommitSha: null },
    }),
    /mergeCommitSha is required/,
  );
  assert.throws(
    () => createCompletedCycleRecord({
      ...evidence,
      mergedPullRequest: { ...evidence.mergedPullRequest, mergedAt: null },
    }),
    /mergedAt is required/,
  );
  assert.throws(
    () => createCompletedCycleRecord({
      ...evidence,
      source: {
        ...evidence.source,
        trustedRail: { ...evidence.source.trustedRail, runAttempt: 0 },
      },
    }),
    /runAttempt/,
  );
  assert.throws(
    () => createCompletedCycleRecord({
      ...evidence,
      source: {
        ...evidence.source,
        orchestrationProvenance: {
          artifact: { ...evidence.source.orchestrationProvenance.artifact, digest: "invalid" },
        },
      },
    }),
    /SHA-256 digest/,
  );
});
