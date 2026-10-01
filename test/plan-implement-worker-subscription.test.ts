import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { gzipSync } from "node:zlib";

const workflow = readFileSync(".github/workflows/plan-implement-worker.yml", "utf8");

/** workflow 원문의 BEGIN/END 사이 코드를 들여쓰기만 걷어 그대로 돌려준다. mock 복제본을 검증하지 않는다. */
function blocks(name: string): string[] {
  const pattern = new RegExp(`\\n( *)// BEGIN ${name}\\n([\\s\\S]*?)\\n\\1// END ${name}\\n`, "g");
  return [...workflow.matchAll(pattern)].map(([, indent, body]) =>
    body!.split("\n").map((line) => (line.startsWith(indent!) ? line.slice(indent!.length) : line)).join("\n"),
  );
}

const coreBlocks = blocks("implement-subscription");
const identityBlocks = blocks("implement-identity");

interface SubscriptionApi {
  canonicalJson(value: unknown): string;
  implementRequestId(identity: unknown, artifactId: number, artifactDigest: string): string;
  implementRequestMarker(identity: unknown, requestId: string, artifactId: number, artifactDigest: string): string;
  implementResultMarker(identity: unknown, requestId: string, artifactId: number, artifactDigest: string): string;
  selectImplementResult(comments: unknown[], expected: Record<string, unknown>): { commentId: number; raw: string } | null;
  buildImplementIdentity(input: Record<string, unknown>): Record<string, unknown>;
}

const api = new Function(
  "require",
  `${identityBlocks[0]}\n${coreBlocks[0]}\nreturn { canonicalJson, implementRequestId, implementRequestMarker, implementResultMarker, selectImplementResult, buildImplementIdentity };`,
)(createRequire(import.meta.url)) as SubscriptionApi;

const BASE_SHA = "f690a1ae3685d2aeddbfe3509b719690898854f5";
const ARTIFACT_ID = 808;
const ARTIFACT_DIGEST = "d".repeat(64);

function handoff(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: "trusted-plan-implement-handoff",
    repository: "erpsarang/self-improvement-mvp",
    baseSha: BASE_SHA,
    issueNumber: 345,
    sourcePlanAuthorize: { runId: 303, runAttempt: 1, artifact: { name: "plan-authorize-a", id: 404, digest: "a".repeat(64) } },
    approvedPlan: { runId: 101, runAttempt: 1, artifactName: "plan-issue-345-101-attempt-1" },
    approvalCommentId: 202,
    contractDigest: "e".repeat(64),
    contextDigest: "f".repeat(64),
    contextMaterialization: { representation: "full", excerptPaths: [], approvedPlanContextDigest: null },
    handoffDigest: "c".repeat(64),
    ...overrides,
  };
}

function identity(overrides: Record<string, unknown> = {}, source: Record<string, unknown> = {}) {
  return api.buildImplementIdentity({
    handoff: handoff(overrides),
    repository: "erpsarang/self-improvement-mvp",
    baseSha: BASE_SHA,
    // workflow는 step output 문자열을 그대로 넘긴다.
    source: { runId: "505", runAttempt: "1", name: "plan-implement-handoff-b", id: "606", digest: `sha256:${"b".repeat(64)}`, ...source },
    worker: { runId: 707, runAttempt: "1" },
  });
}

/** Private implement_bridge.result_comment와 같은 형식의 결과 댓글. */
function resultComment(body: string, overrides: Record<string, unknown> = {}) {
  return { id: 20, author_association: "OWNER", user: { type: "User", login: "erpsarang" }, body, ...overrides };
}

function resultBody(marker: string, value: unknown): string {
  return `${marker}\nIMPLEMENT_RESULT_GZIP_BASE64:\n${gzipSync(Buffer.from(JSON.stringify(value), "utf8")).toString("base64")}`;
}

test("공통 request/result 함수는 두 사본이 같고 identity 생성 함수는 prepare0에만 있다", () => {
  assert.equal(coreBlocks.length, 2);
  assert.equal(coreBlocks[0], coreBlocks[1]);
  assert.equal(identityBlocks.length, 1);
});

test("request_id는 Private canonical_request_id test vector와 같다 (#346)", () => {
  const value = identity();
  assert.deepEqual(value, {
    schemaVersion: 1,
    kind: "trusted-implement-request",
    repository: "erpsarang/self-improvement-mvp",
    issueNumber: 345,
    baseSha: BASE_SHA,
    approvedPlan: { runId: 101, runAttempt: 1, artifactName: "plan-issue-345-101-attempt-1" },
    approvalCommentId: 202,
    planAuthorize: { runId: 303, runAttempt: 1, artifact: { name: "plan-authorize-a", id: 404, digest: "a".repeat(64) } },
    handoff: { runId: 505, runAttempt: 1, artifact: { name: "plan-implement-handoff-b", id: 606, digest: "b".repeat(64) }, handoffDigest: "c".repeat(64) },
    worker: { runId: 707, runAttempt: 1 },
    model: "sonnet",
  });
  assert.equal(
    api.implementRequestId(value, ARTIFACT_ID, ARTIFACT_DIGEST),
    "76d99867586f906135c5f74bf0bfe36266b3c60fbe4e776b200c2a9825037339",
  );
  // key 순서가 달라도 같은 id다 (Python sort_keys).
  assert.equal(api.canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}');
});

test("identity는 Framework repository와 sha256 Handoff digest, 일치하는 Handoff manifest에서만 만든다", () => {
  assert.throws(
    () => api.buildImplementIdentity({ handoff: handoff({ repository: "erpsarang/app" }), repository: "erpsarang/app", baseSha: BASE_SHA, source: { runId: 1, runAttempt: 1, name: "h", id: 1, digest: `sha256:${"b".repeat(64)}` }, worker: { runId: 1, runAttempt: 1 } }),
    /supports only the Framework repository/,
  );
  assert.throws(() => identity({}, { digest: "b".repeat(64) }), /sha256:<64hex>/);
  assert.throws(() => identity({}, { digest: "" }), /sha256:<64hex>/);
  assert.throws(() => identity({ baseSha: "0".repeat(40) }), /Handoff manifest identity mismatch/);
  assert.throws(() => identity({ kind: "other" }), /Handoff manifest identity mismatch/);
  assert.throws(() => identity({ approvalCommentId: 0 }), /approvalCommentId/);
  assert.throws(() => identity({ handoffDigest: "C".repeat(64) }), /handoffDigest/);
  assert.throws(() => identity({ sourcePlanAuthorize: { runId: 303, runAttempt: 1, artifact: { name: "a", id: 404, digest: `sha256:${"a".repeat(64)}` } } }), /planAuthorize\.artifact\.digest/);
  assert.doesNotMatch(JSON.stringify(identity()), /token|secret|api[-_]?key/i);
});

test("IMPLEMENT_REQUEST marker는 Private 계약의 field 순서 그대로이며 request0 검증을 통과한다", () => {
  const value = identity();
  const requestId = api.implementRequestId(value, ARTIFACT_ID, ARTIFACT_DIGEST);
  const marker = api.implementRequestMarker(value, requestId, ARTIFACT_ID, ARTIFACT_DIGEST);
  assert.equal(
    marker,
    `<!-- ai-dev-framework:IMPLEMENT_REQUEST v=1 request=${requestId} issue=345 repository=erpsarang/self-improvement-mvp base=${BASE_SHA} worker-run=707 worker-attempt=1 artifact=808 digest=${ARTIFACT_DIGEST} model=sonnet -->`,
  );
  const source = /const match = (\/\^<!-- ai-dev-framework:IMPLEMENT_REQUEST[^\n]*\$\/)\.exec\(marker\);/.exec(workflow)?.[1];
  assert.ok(source, "request0 marker regex not found");
  const requestPattern = new Function(`return ${source};`)() as RegExp;
  assert.ok(requestPattern.test(marker));
  assert.equal(
    api.implementResultMarker(value, requestId, ARTIFACT_ID, ARTIFACT_DIGEST),
    marker.replace("IMPLEMENT_REQUEST", "IMPLEMENT_RESULT").replace(" -->", " encoding=gzip-base64 -->"),
  );
  assert.throws(() => api.implementRequestMarker(value, requestId, ARTIFACT_ID, `sha256:${ARTIFACT_DIGEST}`), /digest/);
});

test("결과는 request 이후 owner의 exact marker 1개만 받고 payload를 그대로 raw-proposal로 돌려준다", () => {
  const value = identity();
  const requestId = api.implementRequestId(value, ARTIFACT_ID, ARTIFACT_DIGEST);
  const expectedMarker = api.implementResultMarker(value, requestId, ARTIFACT_ID, ARTIFACT_DIGEST);
  const expected = { requestId, requestCommentId: 10, owner: "erpsarang", expectedMarker };
  const proposal = { summary: "완료", complete: true, changes: [{ path: "a.ts", operation: "create", baseContentDigest: null, content: "x", edits: null }] };
  const body = resultBody(expectedMarker, proposal);

  const accepted = api.selectImplementResult([resultComment(body)], expected);
  assert.deepEqual(accepted && { commentId: accepted.commentId, value: JSON.parse(accepted.raw) }, { commentId: 20, value: proposal });

  // 아직 없거나, request 이전 댓글이거나, owner가 아닌 댓글은 결과가 아니다.
  assert.equal(api.selectImplementResult([], expected), null);
  assert.equal(api.selectImplementResult([resultComment(body, { id: 9 })], expected), null);
  assert.equal(api.selectImplementResult([resultComment(body, { author_association: "CONTRIBUTOR" })], expected), null);
  assert.equal(api.selectImplementResult([resultComment(body, { user: { type: "Bot", login: "erpsarang" } })], expected), null);
  assert.equal(api.selectImplementResult([resultComment(body, { user: { type: "User", login: "someone" } })], expected), null);

  // 중복은 어느 쪽도 받지 않는다.
  assert.throws(() => api.selectImplementResult([resultComment(body), resultComment(body, { id: 21 })], expected), /Duplicate IMPLEMENT_RESULT/);
});

test("marker field 하나라도 다르거나 payload가 손상되면 fail-closed 한다", () => {
  const value = identity();
  const requestId = api.implementRequestId(value, ARTIFACT_ID, ARTIFACT_DIGEST);
  const expectedMarker = api.implementResultMarker(value, requestId, ARTIFACT_ID, ARTIFACT_DIGEST);
  const expected = { requestId, requestCommentId: 10, owner: "erpsarang", expectedMarker };
  const proposal = { summary: "ok", complete: true, changes: [] };

  for (const [field, replacement] of [
    ["issue=345", "issue=346"],
    ["repository=erpsarang/self-improvement-mvp", "repository=erpsarang/other"],
    [`base=${BASE_SHA}`, `base=${"0".repeat(40)}`],
    ["worker-run=707", "worker-run=708"],
    ["worker-attempt=1", "worker-attempt=2"],
    ["artifact=808", "artifact=809"],
    [`digest=${ARTIFACT_DIGEST}`, `digest=${"e".repeat(64)}`],
    ["model=sonnet", "model=opus"],
    ["encoding=gzip-base64", "encoding=base64"],
  ] as const) {
    const marker = expectedMarker.replace(field, replacement);
    assert.notEqual(marker, expectedMarker, field);
    assert.throws(() => api.selectImplementResult([resultComment(resultBody(marker, proposal))], expected), /identity mismatch/, field);
  }

  assert.throws(() => api.selectImplementResult([resultComment(`${expectedMarker}\nno payload`)], expected), /Missing IMPLEMENT_RESULT payload/);
  assert.throws(() => api.selectImplementResult([resultComment(`${expectedMarker}\nIMPLEMENT_RESULT_GZIP_BASE64:\nbm90LWd6aXA=`)], expected));
  assert.throws(() => api.selectImplementResult([resultComment(resultBody(expectedMarker, [proposal]))], expected), /must be a JSON object/);
});
