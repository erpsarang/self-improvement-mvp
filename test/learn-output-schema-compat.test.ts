import assert from "node:assert/strict";
import test from "node:test";
import { createCompletedCycleRecord } from "../src/self-improvement/completed-cycle.js";
import { createLearnInputPack, type LearnInputPack } from "../src/self-improvement/learn-input-pack.js";
import { createLearnReport, createLearnReportOutputSchema } from "../src/self-improvement/learn-report.js";

const schemaPack = {
  packDigest: "a".repeat(64),
} as unknown as LearnInputPack;

test("Codex structured output schema는 지원되는 keyword만 사용한다", () => {
  const schema = createLearnReportOutputSchema(schemaPack) as {
    properties: {
      schemaVersion: { type?: string; const?: unknown };
      kind: { type?: string; const?: unknown };
      sourcePackDigest: { type?: string; const?: unknown };
      observations: {
        items: {
          properties: { evidenceIds: Record<string, unknown> };
        };
      };
    };
  };

  assert.deepEqual(schema.properties.schemaVersion, { type: "integer", const: 1 });
  assert.deepEqual(schema.properties.kind, { type: "string", const: "untrusted-learn-report" });
  assert.deepEqual(schema.properties.sourcePackDigest, { type: "string", const: schemaPack.packDigest });
  assert.equal(Object.hasOwn(schema.properties.observations.items.properties.evidenceIds, "uniqueItems"), false);
});

const record = createCompletedCycleRecord({
  repository: "erpsarang/sales-order-exception-analyzer",
  requirement: {
    issueNumber: 8,
    digest: "52c35e90af7cb1681c69c3eb980bdc0c85ec452a712cef42b91b18e512300714",
  },
  mergedPullRequest: {
    number: 24,
    merged: true,
    headSha: "fdfc6996aade470efbea1fb8ec4e4185a7dcc3fc",
    mergeCommitSha: "ab2c1e7a85e76ea69e393b81dcada11d54cd9801",
    mergedAt: "2026-09-15T12:27:59Z",
  },
  source: {
    requirement: {
      issueNumber: 8,
      digest: "52c35e90af7cb1681c69c3eb980bdc0c85ec452a712cef42b91b18e512300714",
    },
    review: {
      decision: "PASS",
      reviewedHeadSha: "fdfc6996aade470efbea1fb8ec4e4185a7dcc3fc",
    },
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
  reviewedHeadSha: "fdfc6996aade470efbea1fb8ec4e4185a7dcc3fc",
} as const;
const pack = createLearnInputPack(record, [{
  evidenceId: "recovery-01",
  kind: "recovery-event",
  repository: record.repository,
  cycle,
  source: { kind: "workflow-run", runId: 34968101704, runAttempt: 1 },
  content: "recovery evidence",
}]);
const identity = {
  sourceRun: { runId: 4001, runAttempt: 1 },
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

test("trusted finalize는 duplicate evidenceId를 계속 fail-closed 한다", () => {
  assert.throws(() => createLearnReport(pack, {
    schemaVersion: 1,
    kind: "untrusted-learn-report",
    sourcePackDigest: pack.packDigest,
    observations: [{
      id: "observation-01",
      statement: "중복 evidence 검증",
      evidenceIds: ["recovery-01", "recovery-01"],
      confidence: "high",
    }],
    lessons: [],
    improvementHypotheses: [],
    uncertainties: [],
  }, identity), /evidenceIds must be unique/);
});
