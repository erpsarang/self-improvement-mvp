import assert from "node:assert/strict";
import test from "node:test";
import type { AuthorizationProvenance } from "../src/self-improvement/authorization.js";
import {
  initialState,
  transition,
  type WorkflowSnapshot,
} from "../src/self-improvement/state.js";

const provenance: AuthorizationProvenance = {
  type: "AUTHORIZE",
  issueNumber: 3,
  approvalCommentId: 101,
  approver: "erpsarang",
  policyVersion: 1,
  policySnapshot: "sha256:test",
  approvedAt: "2026-09-06T00:00:00Z",
  approvalCommand: "SI-승인",
};
const sha = "a".repeat(40);

function authorized(): WorkflowSnapshot {
  return transition(initialState(), { type: "AUTHORIZE", provenance });
}

function reviewing(fixCount = 0): WorkflowSnapshot {
  let state: WorkflowSnapshot = {
    ...authorized(),
    state: fixCount === 0 ? "AUTHORIZED" : "FIXING",
    fixCount,
  };
  if (state.state === "AUTHORIZED")
    state = transition(state, { type: "START_IMPLEMENT" });
  state = transition(state, { type: "SEAL" });
  state = transition(state, {
    type: "RECORD_PUBLISHED",
    publishedHeadSha: sha,
  });
  state = transition(state, { type: "VERIFY", targetSha: sha });
  return transition(state, { type: "START_REVIEW" });
}

test("정상 흐름은 MERGE_READY에서 멈추며 Human merge만 별도로 기록한다", () => {
  const ready = transition(reviewing(), {
    type: "REVIEW_DECISION",
    decision: "PASS",
  });
  assert.equal(ready.state, "MERGE_READY");
  assert.equal(
    transition(ready, { type: "RECORD_HUMAN_MERGE" }).state,
    "MERGED",
  );
});

test("승인 없는 구현과 SEAL 우회를 차단한다", () => {
  assert.throws(() => transition(initialState(), { type: "START_IMPLEMENT" }));
  const implementing = transition(authorized(), { type: "START_IMPLEMENT" });
  assert.throws(() =>
    transition(implementing, {
      type: "RECORD_PUBLISHED",
      publishedHeadSha: sha,
    }),
  );
});

test("exact SHA VERIFY 및 VERIFY 우회를 강제한다", () => {
  let state = transition(
    transition(authorized(), { type: "START_IMPLEMENT" }),
    { type: "SEAL" },
  );
  state = transition(state, {
    type: "RECORD_PUBLISHED",
    publishedHeadSha: sha,
  });
  assert.throws(() => transition(state, { type: "START_REVIEW" }));
  assert.throws(() =>
    transition(state, { type: "VERIFY", targetSha: "b".repeat(40) }),
  );
});

test("SHA 표기를 소문자로 정규화한 뒤 동일 객체인지 검증한다", () => {
  let state = transition(
    transition(authorized(), { type: "START_IMPLEMENT" }),
    { type: "SEAL" },
  );
  state = transition(state, {
    type: "RECORD_PUBLISHED",
    publishedHeadSha: "A".repeat(40),
  });
  assert.equal(state.publishedHeadSha, sha);
  state = transition(state, { type: "VERIFY", targetSha: sha });
  assert.equal(state.verifiedSha, sha);
});

test("첫 번째와 두 번째 LOCAL_FIX만 허용하고 세 번째에는 STOPPED가 된다", () => {
  let state = transition(reviewing(), {
    type: "REVIEW_DECISION",
    decision: "LOCAL_FIX",
  });
  assert.deepEqual([state.state, state.fixCount], ["FIXING", 1]);
  state = transition(reviewing(1), {
    type: "REVIEW_DECISION",
    decision: "LOCAL_FIX",
  });
  assert.deepEqual([state.state, state.fixCount], ["FIXING", 2]);
  state = transition(reviewing(2), {
    type: "REVIEW_DECISION",
    decision: "LOCAL_FIX",
  });
  assert.deepEqual([state.state, state.fixCount], ["STOPPED", 2]);
});

test("STRUCTURAL_CHANGE는 FIX 없이 STOPPED가 된다", () => {
  const stopped = transition(reviewing(), {
    type: "REVIEW_DECISION",
    decision: "STRUCTURAL_CHANGE",
  });
  assert.deepEqual([stopped.state, stopped.fixCount], ["STOPPED", 0]);
  assert.throws(() => transition(stopped, { type: "SEAL" }));
});

test("알 수 없는 review decision은 LOCAL_FIX로 처리하지 않고 거부한다", () => {
  const unsupportedEvent = {
    type: "REVIEW_DECISION",
    decision: "AUTO_MERGE",
  } as unknown as Parameters<typeof transition>[1];

  assert.throws(
    () => transition(reviewing(), unsupportedEvent),
    /지원하지 않는 review decision입니다: AUTO_MERGE/,
  );
});

test("알 수 없는 workflow event type은 상태를 잃지 않고 거부한다", () => {
  const state = initialState();
  const unsupportedEvent = {
    type: "START_REVEIW",
  } as unknown as Parameters<typeof transition>[1];

  assert.throws(
    () => transition(state, unsupportedEvent),
    /지원하지 않는 workflow event type입니다: START_REVEIW/,
  );
  assert.deepEqual(state, initialState());
});

test("REVIEWING에서 직접 MERGED로 전환하거나 Auto Merge할 수 없다", () => {
  assert.throws(() => transition(reviewing(), { type: "RECORD_HUMAN_MERGE" }));
  assert.equal(JSON.stringify(reviewing()).includes("AUTO_MERGE"), false);
});
