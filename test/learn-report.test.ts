import assert from "node:assert/strict";
import test from "node:test";
import { createCompletedCycleRecord } from "../src/self-improvement/completed-cycle.js";
import { createLearnInputPack, type LearnEvidenceInput } from "../src/self-improvement/learn-input-pack.js";
import {
  createLearnReport,
  createLearnReportOutputSchema,
  createLearnReportPrompt,
  learnReportArtifactName,
  verifyLearnReport,
  type LearnReport,
} from "../src/self-improvement/learn-report.js";

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
    frameworkSourceSha: "d35f04c7bfc9430c3cc3e7ee6af416f32ba75c42",
  },
});

function cycle() {
  return {
    recordDigest: record.recordDigest,
    requirementIssueNumber: 8,
    humanMergePullRequestNumber: 24,
    reviewedHeadSha,
  } as const;
}

const evidence: LearnEvidenceInput[] = [
  {
    evidenceId: "requirement-01",
    kind: "requirement-summary",
    repository: record.repository,
    cycle: cycle(),
    source: { kind: "issue", issueNumber: 8 },
    content: "Issue #8은 예외 주문 원인을 집계하고 최빈 사유를 제공하는 업무 요구였다.",
  },
  {
    evidenceId: "review-01",
    kind: "final-review",
    repository: record.repository,
    cycle: cycle(),
    source: { kind: "workflow-run", runId: 34968101704, runAttempt: 1 },
    content: "Semantic REVIEW는 PASS였고 reviewed exact SHA가 Human Merge PR HEAD와 일치했다.",
  },
  {
    evidenceId: "recovery-01",
    kind: "recovery-event",
    repository: record.repository,
    cycle: cycle(),
    source: { kind: "workflow-run", runId: 34968101704, runAttempt: 1 },
    content: "기존 Worker candidate를 recovery guard와 exact-base deterministic CI를 거쳐 재사용했다.",
  },
  {
    evidenceId: "human-01",
    kind: "human-boundary",
    repository: record.repository,
    cycle: cycle(),
    source: { kind: "pull-request", pullRequestNumber: 24 },
    content: "최종 Merge는 Human-only 경계에서 사람이 수행했다.",
  },
];

const pack = createLearnInputPack(record, evidence);
const identity = {
  sourceRun: { runId: 4001, runAttempt: 2 },
  inputPackArtifact: {
    name: "learn-input-issue-8-pr-24",
    id: 777,
    digest: `sha256:${"a".repeat(64)}`,
  },
  learner: {
    provider: "OpenAI",
    action: "openai/codex-action@v1",
    model: "codex",
    reasoningEffort: "medium",
  },
} as const;

const raw = {
  schemaVersion: 1,
  kind: "untrusted-learn-report",
  sourcePackDigest: pack.packDigest,
  observations: [
    {
      id: "observation-01",
      statement: "기존 candidate를 버리지 않고 검증된 recovery 경로로 재사용했다.",
      evidenceIds: ["recovery-01"],
      confidence: "high",
    },
  ],
  lessons: [
    {
      id: "lesson-01",
      statement: "candidate와 control-plane을 분리한 provenance가 복구 가능성을 높였다.",
      evidenceIds: ["review-01", "recovery-01"],
      confidence: "high",
    },
  ],
  improvementHypotheses: [
    {
      id: "hypothesis-01",
      statement: "복구 시 사람이 반복 입력하는 source identity를 더 안전하게 줄일 수 있는지 검토한다.",
      evidenceIds: ["recovery-01", "human-01"],
      confidence: "medium",
    },
  ],
  uncertainties: [
    {
      id: "uncertainty-01",
      statement: "단일 cycle만으로 동일 recovery 패턴의 일반 빈도를 판단하기는 어렵다.",
      evidenceIds: ["recovery-01"],
      confidence: "high",
    },
  ],
} as const;

test("exact LEARN Input Pack에 grounded된 deterministic report를 생성한다", () => {
  const first = createLearnReport(pack, raw, identity);
  const second = createLearnReport(pack, raw, identity);

  assert.deepEqual(first, second);
  assert.equal(first.source.inputPack.packDigest, pack.packDigest);
  assert.equal(first.source.inputPack.artifact.digest, "a".repeat(64));
  assert.deepEqual(first.completedCycle, pack.completedCycle);
  assert.deepEqual(first.lessons[0]?.evidenceIds, ["recovery-01", "review-01"]);
  assert.match(first.reportDigest, /^[0-9a-f]{64}$/);
  assert.doesNotThrow(() => verifyLearnReport(first, pack));
  assert.equal(
    learnReportArtifactName(pack, 9001, 1),
    "learn-report-issue-8-pr-24-9001-attempt-1",
  );
});

test("pack 밖 evidenceId와 wrong pack digest를 fail-closed 한다", () => {
  assert.throws(
    () => createLearnReport(pack, {
      ...raw,
      lessons: [{ ...raw.lessons[0], evidenceIds: ["missing-01"] }],
    }, identity),
    /unknown evidenceId/,
  );
  assert.throws(
    () => createLearnReport(pack, { ...raw, sourcePackDigest: "b".repeat(64) }, identity),
    /source pack digest mismatch/,
  );
});

test("item ID 중복, unsupported confidence, oversize statement를 거부한다", () => {
  assert.throws(
    () => createLearnReport(pack, {
      ...raw,
      lessons: [{ ...raw.lessons[0], id: "observation-01" }],
    }, identity),
    /globally unique/,
  );
  assert.throws(
    () => createLearnReport(pack, {
      ...raw,
      lessons: [{ ...raw.lessons[0], confidence: "certain" }],
    }, identity),
    /confidence is unsupported/,
  );
  assert.throws(
    () => createLearnReport(pack, {
      ...raw,
      observations: [{ ...raw.observations[0], statement: "가".repeat(3_000) }],
    }, identity),
    /maxStatementBytes/,
  );
});

test("report provenance 또는 semantic payload 위변조를 verifier에서 거부한다", () => {
  const report = createLearnReport(pack, raw, identity);
  const forgedSource: LearnReport = {
    ...report,
    source: {
      inputPack: {
        ...report.source.inputPack,
        artifact: { ...report.source.inputPack.artifact, id: 778 },
      },
    },
  };
  assert.throws(() => verifyLearnReport(forgedSource, pack), /digest|canonical shape/);

  const forgedStatement: LearnReport = {
    ...report,
    observations: [{ ...report.observations[0]!, statement: "근거 없이 바꾼 문장" }],
  };
  assert.throws(() => verifyLearnReport(forgedStatement, pack), /digest|canonical shape/);
});

test("prompt와 output schema는 exact pack에 결합되고 read-only/evidence grounding을 명시한다", () => {
  const prompt = createLearnReportPrompt(pack);
  const schema = createLearnReportOutputSchema(pack) as {
    properties: { sourcePackDigest: { const: string } };
  };

  assert.match(prompt, /read-only AI Learner/);
  assert.match(prompt, /GitHub, repository, 웹, 다른 run\/artifact를 탐색하거나 추정하지 마십시오/);
  assert.match(prompt, /evidenceId/);
  assert.ok(prompt.includes(pack.packDigest));
  assert.equal(schema.properties.sourcePackDigest.const, pack.packDigest);
});
