import assert from "node:assert/strict";
import test from "node:test";
import { authorize } from "../src/self-improvement/authorization.js";
import { artifactNameFor, getAuthorizationComment, GitHubApiError, handleAuthorization, isTrustedAuthorizationArtifact, parseTrustedApproverPolicy, pointerFor, WORKFLOW_PATH, type AuthorizationArtifact, type AuthorizationIssueComment, type AuthorizationStore, type IssueCommentEvent, type WorkflowIdentity } from "../src/self-improvement/authorize-handler.js";

const policy = { version: 1, approvers: [{ id: 178057708, login: "erpsarang" }] } as const;
const identity: WorkflowIdentity = { repository: "owner/repo", workflowPath: WORKFLOW_PATH, runId: 42, runAttempt: 1, githubSha: "a".repeat(40) };
const event = (body = "SI-승인", login = "erpsarang"): IssueCommentEvent => ({ action: "created", issue: { number: 3 }, comment: { id: 101, body, created_at: "2026-09-06T00:00:00Z", user: { id: login === "erpsarang" ? 178057708 : 999, login } } });
const approval = (overrides: Partial<AuthorizationIssueComment> = {}): AuthorizationIssueComment => ({ id: 101, issueNumber: 3, isPullRequest: false, body: "SI-승인", createdAt: "2026-09-06T00:00:00Z", user: { id: 178057708, login: "erpsarang", type: "User" }, ...overrides });
const provenance = (run = identity) => authorize({ issueNumber: 3, approvalCommentId: 101, approverId: 178057708, approver: "erpsarang", command: "SI-승인", approvedAt: "2026-09-06T00:00:00Z", ...run }, policy);
const artifact = (run = identity, overrides: Partial<AuthorizationArtifact> = {}): AuthorizationArtifact => ({ name: artifactNameFor(101, run.runAttempt), provenance: provenance(run), run, ...overrides });

function memoryStore(original: AuthorizationIssueComment | null = approval(), artifacts: AuthorizationArtifact[] = [], existingPointers: string[] = []): AuthorizationStore & { pointers: string[]; written: unknown[] } {
  const pointers: string[] = [], written: unknown[] = [];
  return { pointers, written, async getComment(id) { return original?.id === id ? original : undefined; }, async hasPointer(_issueNumber, body) { return existingPointers.includes(body); }, async listArtifacts() { return artifacts; }, async stagePointer(body) { pointers.push(body); }, async writeProvenance(value) { written.push(value); } };
}

test("정상 approval을 재조회한 뒤 artifact provenance와 최소 pointer를 생성한다", async () => {
  const store = memoryStore();
  assert.equal(await handleAuthorization(event(), policy, identity, store), "authorized");
  assert.deepEqual(store.written, [provenance()]);
  assert.deepEqual(store.pointers, [pointerFor(101, 42, 1)]);
  assert.doesNotMatch(store.pointers[0]!, /policySnapshot|IMPLEMENT/);
});

test("삭제/수정된 원본 또는 Issue/author 불일치는 기록하지 않는다", async () => {
  const originals = [null, approval({ body: "SI-승인 " }), approval({ issueNumber: 4 }), approval({ isPullRequest: true }), approval({ user: { id: 999, login: "intruder", type: "User" } })];
  for (const original of originals) {
    const store = memoryStore(original);
    assert.equal(await handleAuthorization(event(), policy, identity, store), "ignored");
    assert.equal(store.written.length, 0);
  }
});

test("검증 가능한 trusted workflow artifact replay만 already-authorized이다", async () => {
  const valid = artifact();
  assert.equal(isTrustedAuthorizationArtifact(valid, provenance()), true);
  const store = memoryStore(approval(), [valid], [pointerFor(101, 42, 1)]);
  assert.equal(await handleAuthorization(event(), policy, identity, store), "already-authorized");
  assert.equal(store.written.length, 0);
});

test("같은 run의 rerun은 artifact 생성 attempt를 검증하고 중복 AUTHORIZE하지 않는다", async () => {
  const firstAttempt = artifact(identity);
  const rerunIdentity = { ...identity, runAttempt: 2 };
  const store = memoryStore(approval(), [firstAttempt]);
  assert.equal(await handleAuthorization(event(), policy, rerunIdentity, store), "already-authorized");
  assert.equal(store.written.length, 0);
  assert.deepEqual(store.pointers, [pointerFor(101, 42, 1)]);
  assert.equal(isTrustedAuthorizationArtifact(firstAttempt, firstAttempt.provenance), true);
  assert.equal(isTrustedAuthorizationArtifact({ ...firstAttempt, name: artifactNameFor(101, 2) }, firstAttempt.provenance), false);
});

test("기존 artifact의 pointer가 누락되면 실제 생성 run/attempt pointer만 복구한다", async () => {
  const firstAttempt = artifact(identity);
  const store = memoryStore(approval(), [firstAttempt]);
  assert.equal(await handleAuthorization(event(), policy, { ...identity, runAttempt: 2 }, store), "already-authorized");
  assert.deepEqual(store.written, []);
  assert.deepEqual(store.pointers, [pointerFor(101, identity.runId, identity.runAttempt)]);
});

test("approval comment 404만 undefined로 변환하고 다른 API 오류는 전파한다", async () => {
  assert.equal(await getAuthorizationComment(101, async () => { throw new GitHubApiError(404); }), undefined);
  await assert.rejects(() => getAuthorizationComment(101, async () => { throw new GitHubApiError(500); }), /500/);
  await assert.rejects(() => getAuthorizationComment(101, async () => { throw new Error("network"); }), /network/);
});

test("forged bot Issue comment는 trust anchor가 아니며 artifact metadata 위조도 거부한다", async () => {
  const forged = artifact(identity, { run: { ...identity, workflowPath: ".github/workflows/other.yml" as typeof WORKFLOW_PATH } });
  assert.equal(isTrustedAuthorizationArtifact(forged, provenance()), false);
  const store = memoryStore(); // comments are deliberately not an input to trust decisions
  assert.equal(await handleAuthorization(event(), policy, identity, store), "authorized");
});

test("approvers는 immutable ID/login record의 flat array만 허용한다", () => {
  assert.deepEqual(parseTrustedApproverPolicy("version: 1\napprovers:\n  - id: 178057708\n    login: erpsarang\n"), policy);
  assert.throws(() => parseTrustedApproverPolicy("version: 1\napprovers:\n  - erpsarang\n"));
  assert.throws(() => parseTrustedApproverPolicy("version: 1\napprovers:\n  metadata:\n    - intruder\n"));
  assert.throws(() => parseTrustedApproverPolicy("version: 1\napprovers:\n  - id: 178057708\n    login: erpsarang\nreviewers:\n  - intruder\n"));
});

test("같은 login을 재사용한 다른 immutable user ID는 거부한다", async () => {
  const impostor = approval({ user: { id: 999, login: "erpsarang", type: "User" } });
  const impostorEvent = { ...event(), comment: { ...event().comment, user: { id: 999, login: "erpsarang" } } };
  const store = memoryStore(impostor);
  assert.equal(await handleAuthorization(impostorEvent, policy, identity, store), "ignored");
  assert.deepEqual(store.written, []);
});

test("login이 변경되어도 immutable user ID로 신뢰하고 현재 login을 provenance에 남긴다", async () => {
  const renamed = approval({ user: { id: 178057708, login: "renamed-user", type: "User" } });
  const renamedEvent = { ...event(), comment: { ...event().comment, user: { id: 178057708, login: "renamed-user" } } };
  const store = memoryStore(renamed);
  assert.equal(await handleAuthorization(renamedEvent, policy, identity, store), "authorized");
  assert.equal((store.written[0] as { approverId: number }).approverId, 178057708);
  assert.equal((store.written[0] as { approver: string }).approver, "renamed-user");
});

test("exact SI-승인, trusted approver 및 Issue만 처리한다", async () => {
  for (const candidate of [event("SI-승인 "), event("승인"), { ...event(), issue: { number: 3, pull_request: {} } }]) assert.equal(await handleAuthorization(candidate, policy, identity, memoryStore()), "ignored");
  assert.equal(await handleAuthorization(event("SI-승인", "intruder"), policy, identity, memoryStore(approval({ user: { id: 999, login: "intruder", type: "User" } }))), "ignored");
});
