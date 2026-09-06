import assert from "node:assert/strict";
import test from "node:test";
import { authorize } from "../src/self-improvement/authorization.js";
import { artifactNameFor, handleAuthorization, isTrustedAuthorizationArtifact, parseTrustedApproverPolicy, pointerFor, WORKFLOW_PATH, type AuthorizationArtifact, type AuthorizationIssueComment, type AuthorizationStore, type IssueCommentEvent, type WorkflowIdentity } from "../src/self-improvement/authorize-handler.js";

const policy = { version: 1, approvers: ["erpsarang"] } as const;
const identity: WorkflowIdentity = { repository: "owner/repo", workflowPath: WORKFLOW_PATH, runId: 42, runAttempt: 1, githubSha: "a".repeat(40) };
const event = (body = "SI-승인", login = "erpsarang"): IssueCommentEvent => ({ action: "created", issue: { number: 3 }, comment: { id: 101, body, created_at: "2026-09-06T00:00:00Z", user: { login } } });
const approval = (overrides: Partial<AuthorizationIssueComment> = {}): AuthorizationIssueComment => ({ id: 101, issueNumber: 3, isPullRequest: false, body: "SI-승인", createdAt: "2026-09-06T00:00:00Z", user: { login: "erpsarang", type: "User" }, ...overrides });
const provenance = (run = identity) => authorize({ issueNumber: 3, approvalCommentId: 101, approver: "erpsarang", command: "SI-승인", approvedAt: "2026-09-06T00:00:00Z", ...run }, policy);
const artifact = (overrides: Partial<AuthorizationArtifact> = {}): AuthorizationArtifact => ({ name: artifactNameFor(101), provenance: provenance(), run: identity, ...overrides });

function memoryStore(original: AuthorizationIssueComment | null = approval(), artifacts: AuthorizationArtifact[] = []): AuthorizationStore & { pointers: string[]; written: unknown[] } {
  const pointers: string[] = [], written: unknown[] = [];
  return { pointers, written, async getComment(id) { return original?.id === id ? original : undefined; }, async listArtifacts() { return artifacts; }, async stagePointer(body) { pointers.push(body); }, async writeProvenance(value) { written.push(value); } };
}

test("정상 approval을 재조회한 뒤 artifact provenance와 최소 pointer를 생성한다", async () => {
  const store = memoryStore();
  assert.equal(await handleAuthorization(event(), policy, identity, store), "authorized");
  assert.deepEqual(store.written, [provenance()]);
  assert.deepEqual(store.pointers, [pointerFor(101, 42, 1)]);
  assert.doesNotMatch(store.pointers[0]!, /policySnapshot|IMPLEMENT/);
});

test("삭제/수정된 원본 또는 Issue/author 불일치는 기록하지 않는다", async () => {
  const originals = [null, approval({ body: "SI-승인 " }), approval({ issueNumber: 4 }), approval({ isPullRequest: true }), approval({ user: { login: "intruder", type: "User" } })];
  for (const original of originals) {
    const store = memoryStore(original);
    assert.equal(await handleAuthorization(event(), policy, identity, store), "ignored");
    assert.equal(store.written.length, 0);
  }
});

test("검증 가능한 trusted workflow artifact replay만 already-authorized이다", async () => {
  const valid = artifact();
  assert.equal(isTrustedAuthorizationArtifact(valid, provenance()), true);
  const store = memoryStore(approval(), [valid]);
  assert.equal(await handleAuthorization(event(), policy, identity, store), "already-authorized");
  assert.equal(store.written.length, 0);
});

test("forged bot Issue comment는 trust anchor가 아니며 artifact metadata 위조도 거부한다", async () => {
  const forged = artifact({ run: { ...identity, workflowPath: ".github/workflows/other.yml" as typeof WORKFLOW_PATH } });
  assert.equal(isTrustedAuthorizationArtifact(forged, provenance()), false);
  const store = memoryStore(); // comments are deliberately not an input to trust decisions
  assert.equal(await handleAuthorization(event(), policy, identity, store), "authorized");
});

test("approvers는 top-level flat string array만 허용한다", () => {
  assert.deepEqual(parseTrustedApproverPolicy("version: 1\napprovers:\n  - erpsarang\n"), policy);
  assert.deepEqual(parseTrustedApproverPolicy('version: 1\napprovers: ["erpsarang", "alice"]\n'), { version: 1, approvers: ["erpsarang", "alice"] });
  assert.throws(() => parseTrustedApproverPolicy("version: 1\napprovers:\n  metadata:\n    - intruder\n"));
  assert.throws(() => parseTrustedApproverPolicy("version: 1\napprovers:\n  - erpsarang\nreviewers:\n  - intruder\n"));
});

test("exact SI-승인, trusted approver 및 Issue만 처리한다", async () => {
  for (const candidate of [event("SI-승인 "), event("승인"), { ...event(), issue: { number: 3, pull_request: {} } }]) assert.equal(await handleAuthorization(candidate, policy, identity, memoryStore()), "ignored");
  assert.equal(await handleAuthorization(event("SI-승인", "intruder"), policy, identity, memoryStore(approval({ user: { login: "intruder", type: "User" } }))), "ignored");
});
