import assert from "node:assert/strict";
import test from "node:test";
import {
  handleAuthorization,
  markerFor,
  parseTrustedApproverPolicy,
  type AuthorizationCommentStore,
  type IssueCommentEvent,
} from "../src/self-improvement/authorize-handler.js";

const policy = { version: 1, approvers: ["erpsarang"] } as const;
const event = (body = "SI-승인", login = "erpsarang"): IssueCommentEvent => ({
  action: "created",
  issue: { number: 3 },
  comment: {
    id: 101,
    body,
    created_at: "2026-09-06T00:00:00Z",
    user: { login },
  },
});

function memoryStore(initial: string[] = []): AuthorizationCommentStore & { bodies: string[] } {
  const bodies = [...initial];
  return {
    bodies,
    async listBodies() { return bodies; },
    async create(_issueNumber, body) { bodies.push(body); },
  };
}

test("정확한 SI-승인으로 machine-readable AUTHORIZE provenance를 기록한다", async () => {
  const store = memoryStore();
  assert.equal(await handleAuthorization(event(), policy, store), "authorized");
  assert.match(store.bodies[0]!, new RegExp(markerFor(101)));
  assert.match(store.bodies[0]!, /"type": "AUTHORIZE"/);
  assert.match(store.bodies[0]!, /"approvalCommand": "SI-승인"/);
  assert.doesNotMatch(store.bodies[0]!, /IMPLEMENT/);
});

test("같은 approval event 재처리는 comment를 중복 생성하지 않는다", async () => {
  const store = memoryStore();
  assert.equal(await handleAuthorization(event(), policy, store), "authorized");
  assert.equal(await handleAuthorization(event(), policy, store), "already-authorized");
  assert.equal(store.bodies.length, 1);
});

test("오타, 공백, 일반 댓글과 PR 댓글은 무시한다", async () => {
  for (const candidate of [event("SI-승인 "), event("승인"), event("일반 댓글")]) {
    assert.equal(await handleAuthorization(candidate, policy, memoryStore()), "ignored");
  }
  const pullRequestEvent = { ...event(), issue: { number: 3, pull_request: {} } };
  assert.equal(await handleAuthorization(pullRequestEvent, policy, memoryStore()), "ignored");
});

test("untrusted approver와 잘못된 policy version을 거부한다", async () => {
  await assert.rejects(handleAuthorization(event("SI-승인", "intruder"), policy, memoryStore()));
  await assert.rejects(handleAuthorization(event(), { version: 0, approvers: ["erpsarang"] }, memoryStore()));
});

test("versioned YAML policy를 읽고 비정상 형식을 거부한다", () => {
  assert.deepEqual(parseTrustedApproverPolicy("version: 1\n\napprovers:\n  - erpsarang\n"), policy);
  assert.throws(() => parseTrustedApproverPolicy("approvers: []"));
});
