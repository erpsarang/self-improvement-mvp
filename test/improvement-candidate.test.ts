import assert from "node:assert/strict";
import test from "node:test";
import { createCompletedCycleRecord } from "../src/self-improvement/completed-cycle.js";
import { createLearnInputPack, type LearnEvidenceInput } from "../src/self-improvement/learn-input-pack.js";
import { createLearnReport } from "../src/self-improvement/learn-report.js";
import {
  createImprovementCandidatePack,
  improvementCandidatePackArtifactName,
  verifyImprovementCandidatePack,
  type ImprovementCandidatePack,
} from "../src/self-improvement/improvement-candidate.js";

const requirementDigest = "52c35e90af7cb1681c69c3eb980bdc0c85ec452a712cef42b91b18e512300714";
const reviewedHeadSha = "fdfc6996aade470efbea1fb8ec4e4185a7dcc3fc";

const record = createCompletedCycleRecord({
  repository: "erpsarang/sales-order-exception-analyzer",
  requirement: { issueNumber: 8, digest: requirementDigest },
  mergedPullRequest: {
    number: 24,
    merged: true,
    headSha: reviewedHeadSha,
    mergeCommitSha: "ab2c1e7a85e76ea69e393b81dcada11d54cd9801",
    mergedAt: "2026-09-15T12:27:59Z",
  },
  source: {
    requirement: { issueNumber: 8, digest: requirementDigest },
    review: { decision: "PASS", reviewedHeadSha },
    trustedRail: {
      runId: 34968101704,
      runAttempt: 1,
      controlPlaneSha: "bd3b6883063c1a11d23f5dff3da2d738e76e8a6c",
    },
    orchestrationProvenance: {
      artifact: {
        name: "orchestration-provenance-issue-8-34968101704-attempt-1",
        id: 10395838542,
        digest: "4ae0287f9e902c45f267da94b58cc504d6da89f2785032ad31c0520973e19c5d",
      },
    },
    frameworkSourceSha: "4c6ac9938dc1d6e36da51c94fb05258e1cd46d05",
  },
});

const cycle = {
  recordDigest: record.recordDigest,
  requirementIssueNumber: 8,
  humanMergePullRequestNumber: 24,
  reviewedHeadSha,
} as const;

const evidence: LearnEvidenceInput[] = [
  {
    evidenceId: "recovery-01",
    kind: "recovery-event",
    repository: record.repository,
    cycle,
    source: { kind: "workflow-run", runId: 34968101704, runAttempt: 1 },
    content: "기존 candidate를 trusted recovery validation 뒤 재사용했다.",
  },
  {
    evidenceId: "final-review-01",
    kind: "final-review",
    repository: record.repository,
    cycle,
    source: { kind: "workflow-run", runId: 34968101704, runAttempt: 1 },
    content: "Semantic REVIEW는 PASS였지만 테스트를 직접 실행하지 않았다고 기록했다.",
  },
];

const pack = createLearnInputPack(record, evidence);
const report = createLearnReport(
  pack,
  {
    schemaVersion: 1,
    kind: "untrusted-learn-report",
    sourcePackDigest: pack.packDigest,
    observations: [],
    lessons: [],
    improvementHypotheses: [
      {
        id: "hypothesis-02",
        statement: "recovery evidence에 재검증 항목을 더 구체적으로 남기는 방안을 검토한다.",
        evidenceIds: ["recovery-01"],
        confidence: "medium",
      },
      {
        id: "hypothesis-01",
        statement: "exact reviewed SHA에 결합된 테스트 실행 evidence를 LEARN Input Pack에 추가하는 방안을 검토한다.",
        evidenceIds: ["final-review-01"],
        confidence: "medium",
      },
    ],
    uncertainties: [],
  },
  {
    sourceRun: { runId: 35063167421, runAttempt: 1 },
    inputPackArtifact: {
      name: `learn-input-issue-8-pr-24-record-${record.recordDigest}`,
      id: 10410000001,
      digest: `sha256:${"a".repeat(64)}`,
    },
    learner: {
      provider: "OpenAI",
      action: "openai/codex-action@v1",
      model: "gpt-6-astra",
      reasoningEffort: "medium",
    },
  },
);

const sourceIdentity = {
  learnRun: { runId: 35069884974, runAttempt: 1 },
  reportArtifact: {
    name: "learn-report-issue-8-pr-24-35069884974-attempt-1",
    id: 10436270364,
    digest: "sha256:ea78c8934e513b2a8769e1bad6150844f9123d21e685d283341471dc99cd7e32",
  },
} as const;

test("validated LEARN hypotheses를 proposal-only candidate로 deterministic하게 투영한다", () => {
  const first = createImprovementCandidatePack(report, pack, sourceIdentity);
  const second = createImprovementCandidatePack(report, pack, sourceIdentity);

  assert.deepEqual(first, second);
  assert.equal(first.authority, "proposal-only");
  assert.equal(first.source.learnReportDigest, report.reportDigest);
  assert.equal(first.source.inputPackDigest, pack.packDigest);
  assert.equal(first.source.reportArtifact.digest, "ea78c8934e513b2a8769e1bad6150844f9123d21e685d283341471dc99cd7e32");
  assert.deepEqual(first.completedCycle, report.completedCycle);
  assert.deepEqual(
    first.candidates.map(({ id, sourceHypothesisId, decision }) => ({ id, sourceHypothesisId, decision })),
    [
      { id: "candidate-hypothesis-01", sourceHypothesisId: "hypothesis-01", decision: "pending-human" },
      { id: "candidate-hypothesis-02", sourceHypothesisId: "hypothesis-02", decision: "pending-human" },
    ],
  );
  assert.equal(first.candidates[0]?.statement, report.improvementHypotheses[0]?.statement);
  assert.deepEqual(first.candidates[0]?.evidenceIds, report.improvementHypotheses[0]?.evidenceIds);
  assert.equal(first.candidates[0]?.confidence, report.improvementHypotheses[0]?.confidence);
  assert.match(first.candidatePackDigest, /^[0-9a-f]{64}$/);
  assert.doesNotThrow(() => verifyImprovementCandidatePack(first, report, pack));
});

test("candidate semantic/source/authority 변조를 fail-closed 한다", () => {
  const candidatePack = createImprovementCandidatePack(report, pack, sourceIdentity);

  const changedStatement: ImprovementCandidatePack = {
    ...candidatePack,
    candidates: [{ ...candidatePack.candidates[0]!, statement: "변조된 개선안" }, ...candidatePack.candidates.slice(1)],
  };
  assert.throws(
    () => verifyImprovementCandidatePack(changedStatement, report, pack),
    /source, candidate mapping, or digest mismatch/,
  );

  const changedAuthority = {
    ...candidatePack,
    authority: "implementation-authority",
  } as unknown as ImprovementCandidatePack;
  assert.throws(
    () => verifyImprovementCandidatePack(changedAuthority, report, pack),
    /unsupported Improvement Candidate Pack schema or digest/,
  );

  const changedArtifact: ImprovementCandidatePack = {
    ...candidatePack,
    source: {
      ...candidatePack.source,
      reportArtifact: { ...candidatePack.source.reportArtifact, id: candidatePack.source.reportArtifact.id + 1 },
    },
  };
  assert.throws(
    () => verifyImprovementCandidatePack(changedArtifact, report, pack),
    /source, candidate mapping, or digest mismatch/,
  );
});

test("Candidate Pack에는 ranking/priority/approval authority를 생성하지 않는다", () => {
  const candidatePack = createImprovementCandidatePack(report, pack, sourceIdentity);
  const serialized = JSON.stringify(candidatePack);

  assert.ok(!serialized.includes("priority"));
  assert.ok(!serialized.includes("rank"));
  assert.ok(!serialized.includes("score"));
  assert.ok(!serialized.includes("approved"));
  assert.equal(
    improvementCandidatePackArtifactName(report, 35069884974, 1),
    "improvement-candidates-issue-8-pr-24-learn-35069884974-attempt-1",
  );
});
