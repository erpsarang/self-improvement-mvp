import assert from "node:assert/strict";
import test from "node:test";
import { requirementsSnapshot, type AuthorizationProvenance } from "../src/self-improvement/authorization.js";
import {
  createImplementProvenance,
  validateAuthorizationForImplement,
  type SourceWorkflowRun,
} from "../src/self-improvement/implement.js";

const requirements = requirementsSnapshot("승인된 요구사항", "정확한 본문");
const authorization: AuthorizationProvenance = {
  type: "AUTHORIZE",
  issueNumber: 10,
  requirements,
  approvalCommentId: 5560484125,
  approverId: 8370921,
  approver: "erpsarang",
  policyVersion: 2,
  policySnapshot: "sha256:" + "a".repeat(64),
  approvedAt: "2026-09-06T16:12:00Z",
  approvalCommand: "SI-승인",
  repository: "erpsarang/self-improvement-mvp",
  workflowPath: ".github/workflows/authorize.yml",
  runId: 34044682422,
  runAttempt: 1,
  githubSha: "6".repeat(40),
};

const sourceRun: SourceWorkflowRun = {
  id: authorization.runId,
  runAttempt: authorization.runAttempt,
  headSha: authorization.githubSha,
  repository: authorization.repository,
  conclusion: "success",
};

test("trusted AUTHORIZE exact run/attempt/SHA만 IMPLEMENT 입력으로 허용한다", () => {
  assert.equal(validateAuthorizationForImplement(authorization, sourceRun), authorization);
});

test("실패하거나 identity가 다른 AUTHORIZE는 fail-closed 한다", () => {
  const cases: SourceWorkflowRun[] = [
    { ...sourceRun, conclusion: "failure" },
    { ...sourceRun, id: sourceRun.id + 1 },
    { ...sourceRun, runAttempt: 2 },
    { ...sourceRun, headSha: "7".repeat(40) },
    { ...sourceRun, repository: "other/repo" },
  ];
  for (const candidate of cases) {
    assert.throws(() => validateAuthorizationForImplement(authorization, candidate));
  }
});

test("malformed AUTHORIZE provenance는 fail-closed 한다", () => {
  const malformed: AuthorizationProvenance[] = [
    { ...authorization, issueNumber: 0 },
    { ...authorization, approvalCommentId: 0 },
    { ...authorization, policyVersion: 0 },
    { ...authorization, policySnapshot: "bad" },
    { ...authorization, approvalCommand: "승인" as "SI-승인" },
    { ...authorization, approvedAt: "not-a-date" },
    { ...authorization, githubSha: "bad" },
    { ...authorization, runId: 0 },
    { ...authorization, requirements: { ...requirements, digest: "bad" } },
    { ...authorization, requirements: { ...requirements, title: "변조된 요구사항" } },
  ];
  for (const candidate of malformed) {
    assert.throws(() => validateAuthorizationForImplement(candidate, sourceRun));
  }
});

test("candidate patch digest와 source authorization provenance를 IMPLEMENT에 결합한다", () => {
  const provenance = createImplementProvenance({
    authorization,
    implementRun: { runId: 500, runAttempt: 1 },
    candidatePatch: "diff --git a/a b/a\n",
    aiResultId: "codex-action-run:500:1",
  });

  assert.equal(provenance.type, "IMPLEMENT");
  assert.equal(provenance.repository, authorization.repository);
  assert.equal(provenance.issueNumber, 10);
  assert.equal(provenance.baseSha, authorization.githubSha);
  assert.deepEqual(provenance.sourceAuthorization, {
    runId: authorization.runId,
    runAttempt: authorization.runAttempt,
    approvalCommentId: authorization.approvalCommentId,
    policySnapshot: authorization.policySnapshot,
    requirementsDigest: requirements.digest,
  });
  assert.match(provenance.candidatePatchDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(provenance.implementWorkflow.workflowPath, ".github/workflows/implement.yml");
  assert.equal(provenance.aiExecution.provider, "openai-codex-action");
});

test("빈 candidate, AI 결과 식별자, 잘못된 IMPLEMENT workflow identity는 거부한다", () => {
  assert.throws(() => createImplementProvenance({ authorization, implementRun: { runId: 1, runAttempt: 1 }, candidatePatch: "diff", aiResultId: "" }));
  assert.throws(() => createImplementProvenance({ authorization, implementRun: { runId: 0, runAttempt: 1 }, candidatePatch: "diff", aiResultId: "x" }));
  assert.throws(() => createImplementProvenance({ authorization, implementRun: { runId: 1, runAttempt: 1 }, candidatePatch: "", aiResultId: "x" }));
});
