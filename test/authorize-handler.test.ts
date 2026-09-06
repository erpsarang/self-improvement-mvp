import assert from "node:assert/strict";
import test from "node:test";
import { authorize } from "../src/self-improvement/authorization.js";
import {
  handleAuthorization,
  isTrustedAuthorizationComment,
  markerFor,
  parseTrustedApproverPolicy,
  type AuthorizationCommentStore,
  type AuthorizationIssueComment,
  type IssueCommentEvent,
} from "../src/self-improvement/authorize-handler.js";

const policy = { version: 1, approvers: ["erpsarang"] } as const;
const event = (body = "SI-승인", login = "erpsarang"): IssueCommentEvent => ({
  action: "created", issue: { number: 3 },
  comment: { id: 101, body, created_at: "2026-09-06T00:00:00Z", user: { login } },
});
const workflowAuthor = { login: "github-actions[bot]", type: "Bot" } as const;

function approval(overrides: Partial<AuthorizationIssueComment> = {}): AuthorizationIssueComment {
  return { id: 101, issueNumber: 3, isPullRequest: false, body: "SI-승인", createdAt: "2026-09-06T00:00:00Z", user: { login: "erpsarang", type: "User" }, ...overrides };
}

function provenanceBody(policyValue = policy): string {
  const value = authorize({ issueNumber: 3, approvalCommentId: 101, approver: "erpsarang", command: "SI-승인", approvedAt: "2026-09-06T00:00:00Z" }, policyValue);
  return `${markerFor(101)}\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function memoryStore(initial: AuthorizationIssueComment[] = [], original = approval()): AuthorizationCommentStore & { bodies: string[] } {
  const comments = [...initial];
  const bodies = comments.map(({ body }) => body);
  return {
    bodies,
    async list() { return comments; },
    async get(id) { return id === original.id ? original : undefined; },
    async create(_issueNumber, body) {
      bodies.push(body);
      comments.push({ id: 999, issueNumber: 3, isPullRequest: false, body, createdAt: "2026-09-06T00:01:00Z", user: workflowAuthor });
    },
  };
}

test("정확한 SI-승인으로 machine-readable AUTHORIZE provenance를 기록한다", async () => {
  const store = memoryStore();
  assert.equal(await handleAuthorization(event(), policy, store), "authorized");
  assert.match(store.bodies[0]!, new RegExp(markerFor(101)));
  assert.match(store.bodies[0]!, /"policySnapshot": "sha256:/);
  assert.doesNotMatch(store.bodies[0]!, /IMPLEMENT/);
});

test("정상 approval과 provenance replay만 already-authorized로 인정한다", async () => {
  const comment = { id: 999, issueNumber: 3, isPullRequest: false, body: provenanceBody(), createdAt: "2026-09-06T00:01:00Z", user: workflowAuthor };
  const store = memoryStore([comment]);
  assert.equal(await isTrustedAuthorizationComment(comment, 101, 3, policy, store), true);
  assert.equal(await handleAuthorization(event(), policy, store), "already-authorized");
  assert.equal(store.bodies.length, 1);
});

test("다른 workflow가 Actions bot으로 위조한 marker/JSON은 거부한다", async () => {
  const forged = { id: 999, issueNumber: 3, isPullRequest: false, body: `${markerFor(101)}\n\`\`\`json\n{"type":"AUTHORIZE"}\n\`\`\``, createdAt: "2026-09-06T00:01:00Z", user: workflowAuthor };
  const store = memoryStore([forged]);
  assert.equal(await isTrustedAuthorizationComment(forged, 101, 3, policy, store), false);
  assert.equal(await handleAuthorization(event(), policy, store), "authorized");
});

test("원본 approval의 body, author 또는 policy가 불일치하면 provenance를 거부한다", async () => {
  const recorded = { id: 999, issueNumber: 3, isPullRequest: false, body: provenanceBody(), createdAt: "2026-09-06T00:01:00Z", user: workflowAuthor };
  for (const original of [approval({ body: "SI-승인 " }), approval({ user: { login: "intruder", type: "User" } }), approval({ isPullRequest: true })]) {
    assert.equal(await handleAuthorization(event(), policy, memoryStore([recorded], original)), "authorized");
  }
  assert.equal(await handleAuthorization(event(), { version: 2, approvers: ["erpsarang"] }, memoryStore([recorded])), "authorized");
});

test("오타, 공백, 일반 댓글, PR 댓글 및 untrusted approver를 거부한다", async () => {
  for (const candidate of [event("SI-승인 "), event("승인"), { ...event(), issue: { number: 3, pull_request: {} } }])
    assert.equal(await handleAuthorization(candidate, policy, memoryStore()), "ignored");
  await assert.rejects(handleAuthorization(event("SI-승인", "intruder"), policy, memoryStore()));
});

test("approvers 뒤의 다른 top-level list를 승인자로 섞지 않는다", () => {
  const parsed = parseTrustedApproverPolicy("version: 1\napprovers:\n  - erpsarang\nreviewers:\n  - intruder\n");
  assert.deepEqual(parsed, policy);
  assert.throws(() => parseTrustedApproverPolicy("approvers: []"));
});
