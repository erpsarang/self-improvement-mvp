import assert from "node:assert/strict";
import test from "node:test";
import {
  APPROVAL_COMMAND,
  authorize,
} from "../src/self-improvement/authorization.js";

const policy = { version: 1, approvers: ["erpsarang"] } as const;

test("versioned trusted approver의 SI-승인을 provenance로 기록한다", () => {
  assert.deepEqual(
    authorize(
      {
        approver: "erpsarang",
        command: APPROVAL_COMMAND,
        approvedAt: "2026-09-06T00:00:00Z",
      },
      policy,
    ),
    {
      approver: "erpsarang",
      policyVersion: 1,
      approvedAt: "2026-09-06T00:00:00Z",
    },
  );
});

test("승인 명령이 없거나 approver가 신뢰되지 않으면 거부한다", () => {
  assert.throws(() =>
    authorize(
      {
        approver: "erpsarang",
        command: "approve",
        approvedAt: "2026-09-06T00:00:00Z",
      },
      policy,
    ),
  );
  assert.throws(() =>
    authorize(
      {
        approver: "intruder",
        command: APPROVAL_COMMAND,
        approvedAt: "2026-09-06T00:00:00Z",
      },
      policy,
    ),
  );
});
