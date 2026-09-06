import assert from "node:assert/strict";
import test from "node:test";
import {
  handleAuthorization,
  hasTrustedAuthorizationMarker,
  isTrustedAuthorizationComment,
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

const workflowAuthor = { login: "github-actions[bot]", type: "Bot" } as const;
// Even a forged payload claiming the reserved login is untrusted without the Bot type.
const userAuthor = { login: "github-actions[bot]", type: "User" } as const;

function memoryStore(
  initial: Array<{ body: string; user: { login: string; type: string } }> = [],
): AuthorizationCommentStore & { bodies: string[] } {
  const comments = [...initial];
  const bodies = comments.map(({ body }) => body);
  return {
    bodies,
    async list() { return comments; },
    async create(_issueNumber, body) {
      bodies.push(body);
      comments.push({ body, user: workflowAuthor });
    },
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

test("사용자가 위조한 marker/JSON은 AUTHORIZE로 신뢰하지 않고 승인을 차단하지 않는다", async () => {
  const forgedBody = `${markerFor(101)}\n\`\`\`json\n{"type":"AUTHORIZE"}\n\`\`\``;
  const forgedComment = { body: forgedBody, user: userAuthor };
  const store = memoryStore([forgedComment]);

  assert.equal(isTrustedAuthorizationComment(forgedComment), false);
  assert.equal(hasTrustedAuthorizationMarker(forgedComment, 101), false);
  assert.equal(await handleAuthorization(event(), policy, store), "authorized");
  assert.equal(store.bodies.length, 2);
});

test("workflow bot이 작성한 기존 marker만 idempotency provenance로 인정한다", async () => {
  const trustedComment = { body: markerFor(101), user: workflowAuthor };
  const store = memoryStore([trustedComment]);

  assert.equal(isTrustedAuthorizationComment(trustedComment), true);
  assert.equal(hasTrustedAuthorizationMarker(trustedComment, 101), true);
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
