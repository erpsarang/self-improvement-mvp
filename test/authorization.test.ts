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

test("approvedAt은 실제로 존재하는 엄격한 RFC 3339 timestamp여야 한다", () => {
  for (const approvedAt of [
    "2026-02-30T00:00:00Z",
    "2026-09-06",
    "2026-09-06T24:00:00Z",
    "2026-09-06T00:00:00+24:00",
  ]) {
    assert.throws(() =>
      authorize(
        { approver: "erpsarang", command: APPROVAL_COMMAND, approvedAt },
        policy,
      ),
    );
  }

  assert.equal(
    authorize(
      {
        approver: "erpsarang",
        command: APPROVAL_COMMAND,
        approvedAt: "2024-02-29T23:59:59.123+09:00",
      },
      policy,
    ).approvedAt,
    "2024-02-29T23:59:59.123+09:00",
  );
});
