import assert from "node:assert/strict";
import test from "node:test";
import {
  APPROVAL_COMMAND,
  authorize,
  policySnapshot,
  requirementsSnapshot,
} from "../src/self-improvement/authorization.js";

const policy = { version: 1, approvers: [{ id: 178057708, login: "erpsarang" }] } as const;
const workflow = { repository: "owner/repo", workflowPath: ".github/workflows/authorize.yml", runId: 42, runAttempt: 1, githubSha: "a".repeat(40) } as const;
const issue = { issueNumber: 3, issueTitle: "승인된 요구사항", issueBody: "정확한 본문" } as const;

test("versioned trusted approver의 SI-승인과 Issue snapshot을 provenance로 기록한다", () => {
  assert.deepEqual(
    authorize(
      {
        ...issue,
        approvalCommentId: 101,
        approverId: 178057708,
        approver: "erpsarang",
        command: APPROVAL_COMMAND,
        approvedAt: "2026-09-06T00:00:00Z",
        ...workflow,
      },
      policy,
    ),
    {
      type: "AUTHORIZE",
      issueNumber: 3,
      requirements: requirementsSnapshot(issue.issueTitle, issue.issueBody),
      approvalCommentId: 101,
      approverId: 178057708,
      approver: "erpsarang",
      policyVersion: 1,
      policySnapshot: policySnapshot(policy),
      approvedAt: "2026-09-06T00:00:00Z",
      approvalCommand: APPROVAL_COMMAND,
      ...workflow,
    },
  );
});

test("Issue title/body가 바뀌면 requirements digest도 달라진다", () => {
  const original = requirementsSnapshot("제목", "본문");
  assert.notEqual(original.digest, requirementsSnapshot("수정된 제목", "본문").digest);
  assert.notEqual(original.digest, requirementsSnapshot("제목", "수정된 본문").digest);
});

test("승인 명령이 없거나 approver가 신뢰되지 않으면 거부한다", () => {
  assert.throws(() =>
    authorize(
      {
        ...issue,
        approvalCommentId: 101,
        approverId: 178057708,
        approver: "erpsarang",
        command: "approve",
        approvedAt: "2026-09-06T00:00:00Z",
        ...workflow,
      },
      policy,
    ),
  );
  assert.throws(() =>
    authorize(
      {
        ...issue,
        approvalCommentId: 101,
        approverId: 999,
        approver: "intruder",
        command: APPROVAL_COMMAND,
        approvedAt: "2026-09-06T00:00:00Z",
        ...workflow,
      },
      policy,
    ),
  );
});

test("approvedAt은 실제로 존재하는 엄격한 RFC 3339 timestamp여야 한다", () => {
  for (const approvedAt of [
    "2026-02-30T00:00:00Z",
    "2026-09-06",
    "2026-09-06T24:00:00Z",
    "2026-09-06T00:00:00+24:00",
  ]) {
    assert.throws(() =>
      authorize(
        { ...issue, approvalCommentId: 101, approverId: 178057708, approver: "erpsarang", command: APPROVAL_COMMAND, approvedAt, ...workflow },
        policy,
      ),
    );
  }

  assert.equal(
    authorize(
      {
        ...issue,
        approvalCommentId: 101,
        approverId: 178057708,
        approver: "erpsarang",
        command: APPROVAL_COMMAND,
        approvedAt: "2024-02-29T23:59:59.123+09:00",
        ...workflow,
      },
      policy,
    ).approvedAt,
    "2024-02-29T23:59:59.123+09:00",
  );
});
