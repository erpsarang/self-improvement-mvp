import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

const workflow = readFileSync(".github/workflows/plan-implement-worker.yml", "utf8");
const exchange = readFileSync(".github/workflows/subscription-exchange.yml", "utf8");

/** workflow 원문의 BEGIN/END 사이 코드를 들여쓰기만 걷어 그대로 돌려준다. mock 복제본을 검증하지 않는다. */
function blocks(source: string, name: string): string[] {
  const pattern = new RegExp(`\\n( *)// BEGIN ${name}\\n([\\s\\S]*?)\\n\\1// END ${name}\\n`, "g");
  return [...source.matchAll(pattern)].map(([, indent, body]) =>
    body!.split("\n").map((line) => (line.startsWith(indent!) ? line.slice(indent!.length) : line)).join("\n"),
  );
}

const coreBlocks = blocks(exchange, "subscription-exchange");
const identityBlocks = blocks(workflow, "implement-identity");

interface SubscriptionApi {
  canonicalJson(value: unknown): string;
  implementRequestId(identity: unknown, artifactId: number, artifactDigest: string): string;
  implementRequestMarker(identity: unknown, requestId: string, artifactId: number, artifactDigest: string): string;
  implementResultMarker(identity: unknown, requestId: string, artifactId: number, artifactDigest: string): string;
  selectImplementResult(comments: unknown[], expected: Record<string, unknown>): { commentId: number; raw: string } | null;
  buildImplementIdentity(input: Record<string, unknown>): Record<string, unknown>;
  loadImplementRequest(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  subscriptionRequestMarker(kind: string, identity: unknown, requestId: string, artifactId: number, artifactDigest: string): string;
  subscriptionResultMarker(kind: string, identity: unknown, requestId: string, artifactId: number, artifactDigest: string): string;
  selectSubscriptionResult(kind: string, comments: unknown[], expected: Record<string, unknown>): { commentId: number; raw: string } | null;
  loadSubscriptionRequest(input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

const api = new Function(
  "require",
  `${identityBlocks[0]}\n${coreBlocks[0]}\nreturn {
    canonicalJson,
    implementRequestId: subscriptionRequestId,
    implementRequestMarker: (...args) => subscriptionRequestMarker('IMPLEMENT', ...args),
    implementResultMarker: (...args) => subscriptionResultMarker('IMPLEMENT', ...args),
    selectImplementResult: (comments, expected) => selectSubscriptionResult('IMPLEMENT', comments, expected),
    buildImplementIdentity,
    loadImplementRequest: (input) => loadSubscriptionRequest({ kind: 'IMPLEMENT', ...input }),
    subscriptionRequestMarker,
    subscriptionResultMarker,
    selectSubscriptionResult,
    loadSubscriptionRequest,
  };`,
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

test("공통 request/result 함수는 exchange workflow의 두 job이 같은 사본을 쓰고 identity 생성 함수는 prepare0에만 있다", () => {
  assert.equal(coreBlocks.length, 2);
  assert.equal(coreBlocks[0], coreBlocks[1]);
  assert.equal(identityBlocks.length, 1);
  assert.doesNotMatch(workflow, /BEGIN subscription-exchange/);
  assert.doesNotMatch(exchange, /BEGIN implement-identity/);
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

test("identity는 sha256 Handoff digest와 일치하는 Handoff manifest에서만 만든다", () => {
  const otherRepository = (repository: string) => () =>
    api.buildImplementIdentity({ handoff: handoff({ repository }), repository, baseSha: BASE_SHA, source: { runId: 1, runAttempt: 1, name: "h", id: 1, digest: `sha256:${"b".repeat(64)}` }, worker: { runId: 1, runAttempt: 1 } });
  // 어느 repository를 받을지는 그 repository의 executor allowlist(EXECUTOR_ALLOWED_REPOSITORIES)가 정한다. Public에는 목록이 없다.
  assert.equal(otherRepository("blueward/other-team-app")().repository, "blueward/other-team-app");
  assert.doesNotMatch(workflow, /erpsarang\//);
  assert.throws(() => identity({}, { digest: "b".repeat(64) }), /sha256:<64hex>/);
  assert.throws(() => identity({}, { digest: "" }), /sha256:<64hex>/);
  assert.throws(() => identity({ baseSha: "0".repeat(40) }), /Handoff manifest identity mismatch/);
  assert.throws(() => identity({ kind: "other" }), /Handoff manifest identity mismatch/);
  assert.throws(() => identity({ approvalCommentId: 0 }), /approvalCommentId/);
  assert.throws(() => identity({ handoffDigest: "C".repeat(64) }), /handoffDigest/);
  assert.throws(() => identity({ sourcePlanAuthorize: { runId: 303, runAttempt: 1, artifact: { name: "a", id: 404, digest: `sha256:${"a".repeat(64)}` } } }), /planAuthorize\.artifact\.digest/);
  assert.doesNotMatch(JSON.stringify(identity()), /token|secret|api[-_]?key/i);
});

test("IMPLEMENT_REQUEST marker는 Private 계약의 field 순서 그대로다", () => {
  const value = identity();
  const requestId = api.implementRequestId(value, ARTIFACT_ID, ARTIFACT_DIGEST);
  const marker = api.implementRequestMarker(value, requestId, ARTIFACT_ID, ARTIFACT_DIGEST);
  assert.equal(
    marker,
    `<!-- ai-dev-framework:IMPLEMENT_REQUEST v=1 request=${requestId} issue=345 repository=erpsarang/self-improvement-mvp base=${BASE_SHA} worker-run=707 worker-attempt=1 artifact=808 digest=${ARTIFACT_DIGEST} model=sonnet -->`,
  );
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

/** upload-artifact처럼 root에 파일만 담은 zip과 그 sha256을 만든다. */
function requestArchive(files: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), "implement-request-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, name), content);
  const archive = join(directory, "request.zip");
  execFileSync("zip", ["-q", "-j", archive, ...Object.keys(files).map((name) => join(directory, name))]);
  const data = readFileSync(archive);
  rmSync(directory, { recursive: true, force: true });
  return { data, digest: createHash("sha256").update(data).digest("hex") };
}

function fakeGithub(data: Buffer, digest: string, metadata: Record<string, unknown> = {}) {
  return {
    rest: {
      actions: {
        getArtifact: async () => ({ data: { name: "implement-request-a", expired: false, workflow_run: { id: 707 }, digest: `sha256:${digest}`, ...metadata } }),
        downloadArtifact: async () => ({ data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) }),
      },
    },
  };
}

test("request artifact는 id로 다시 받아 zip digest, 파일 집합, 이 run/Issue binding을 확인한다", async () => {
  const value = identity();
  const files = { "identity.json": JSON.stringify(value), "prompt.md": "prompt", "schema.json": "{}" };
  const { data, digest } = requestArchive(files);
  const context = { repo: { owner: "erpsarang", repo: "self-improvement-mvp" }, runId: 707 };
  const root = mkdtempSync(join(tmpdir(), "implement-request-load-"));
  const previousAttempt = process.env.GITHUB_RUN_ATTEMPT;
  process.env.GITHUB_RUN_ATTEMPT = "1";
  const load = (overrides: Record<string, unknown> = {}) =>
    api.loadImplementRequest({
      github: fakeGithub(data, digest),
      context,
      artifactName: "implement-request-a",
      artifactId: 808,
      artifactDigest: digest,
      issueNumber: 345,
      directory: join(root, "request"),
      ...overrides,
    });
  try {
    assert.deepEqual(await load(), value);
    assert.deepEqual(readdirSync(join(root, "request")).sort(), ["identity.json", "prompt.md", "schema.json"]);

    await assert.rejects(load({ artifactDigest: "0".repeat(64), github: fakeGithub(data, "0".repeat(64)) }), /digest mismatch/);
    await assert.rejects(load({ github: fakeGithub(data, digest, { name: "other" }) }), /metadata mismatch/);
    await assert.rejects(load({ github: fakeGithub(data, digest, { workflow_run: { id: 1 } }) }), /metadata mismatch/);
    await assert.rejects(load({ github: fakeGithub(data, digest, { expired: true }) }), /metadata mismatch/);
    await assert.rejects(load({ issueNumber: 346 }), /identity mismatch/);
    await assert.rejects(load({ context: { ...context, runId: 708 }, github: fakeGithub(data, digest, { workflow_run: { id: 708 } }) }), /identity mismatch/);

    const extra = requestArchive({ ...files, "token.txt": "x" });
    await assert.rejects(load({ github: fakeGithub(extra.data, extra.digest), artifactDigest: extra.digest }), /file set mismatch/);
  } finally {
    if (previousAttempt === undefined) delete process.env.GITHUB_RUN_ATTEMPT;
    else process.env.GITHUB_RUN_ATTEMPT = previousAttempt;
    rmSync(root, { recursive: true, force: true });
  }
});

/** Semantic REVIEW job이 만드는 trusted-review-request identity (Private review_bridge 계약). */
function reviewIdentity(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: "trusted-review-request",
    repository: "erpsarang/self-improvement-mvp",
    issueNumber: 349,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    reviewInput: { name: "review-input-issue-349-901-attempt-1", id: 404, digest: "c".repeat(64) },
    rail: { runId: 901, runAttempt: 1 },
    model: "opus",
    ...overrides,
  };
}

test("REVIEW marker는 head와 Trusted Rail run을 담고 IMPLEMENT 결과와 섞이지 않는다", () => {
  const value = reviewIdentity();
  const requestId = api.implementRequestId(value, ARTIFACT_ID, ARTIFACT_DIGEST);
  const marker = api.subscriptionRequestMarker("REVIEW", value, requestId, ARTIFACT_ID, ARTIFACT_DIGEST);
  assert.equal(
    marker,
    `<!-- ai-dev-framework:REVIEW_REQUEST v=1 request=${requestId} issue=349 repository=erpsarang/self-improvement-mvp base=${"a".repeat(40)} head=${"b".repeat(40)} run=901 run-attempt=1 artifact=808 digest=${ARTIFACT_DIGEST} model=opus -->`,
  );
  const expectedMarker = api.subscriptionResultMarker("REVIEW", value, requestId, ARTIFACT_ID, ARTIFACT_DIGEST);
  const review = { decision: "PASS", requirementComplete: true, summary: "ok", findings: [] };
  const body = `${expectedMarker}\nREVIEW_RESULT_GZIP_BASE64:\n${gzipSync(Buffer.from(JSON.stringify(review), "utf8")).toString("base64")}`;
  const expected = { requestId, requestCommentId: 10, owner: "erpsarang", expectedMarker };
  const accepted = api.selectSubscriptionResult("REVIEW", [resultComment(body)], expected);
  assert.deepEqual(accepted && JSON.parse(accepted.raw), review);
  // IMPLEMENT 교환은 같은 request_id의 REVIEW 결과를 결과로 보지 않는다.
  assert.equal(api.selectSubscriptionResult("IMPLEMENT", [resultComment(body)], { ...expected, expectedMarker: "x" }), null);
  assert.throws(() => api.subscriptionRequestMarker("SMOKE", value, requestId, ARTIFACT_ID, ARTIFACT_DIGEST), /unsupported subscription kind/);
});

/** bounded FIX Worker가 만드는 trusted-fix-request identity (Private fix_bridge 계약). */
function fixIdentity(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: "trusted-fix-request",
    repository: "erpsarang/self-improvement-mvp",
    issueNumber: 350,
    baseSha: "a".repeat(40),
    fixAttempt: 1,
    fixRequest: { runId: 600, runAttempt: 1, artifactName: "fix-request-500-fix-1-600-attempt-1" },
    worker: { runId: 707, runAttempt: 2 },
    model: "sonnet",
    ...overrides,
  };
}

test("FIX marker는 FIX Worker run과 sonnet을 담고 IMPLEMENT·REVIEW 결과와 섞이지 않는다", async () => {
  const value = fixIdentity();
  const requestId = api.implementRequestId(value, ARTIFACT_ID, ARTIFACT_DIGEST);
  assert.equal(
    api.subscriptionRequestMarker("FIX", value, requestId, ARTIFACT_ID, ARTIFACT_DIGEST),
    `<!-- ai-dev-framework:FIX_REQUEST v=1 request=${requestId} issue=350 repository=erpsarang/self-improvement-mvp base=${"a".repeat(40)} worker-run=707 worker-attempt=2 artifact=808 digest=${ARTIFACT_DIGEST} model=sonnet -->`,
  );
  const expectedMarker = api.subscriptionResultMarker("FIX", value, requestId, ARTIFACT_ID, ARTIFACT_DIGEST);
  const proposal = { summary: "ok", complete: true, changes: [] };
  const body = `${expectedMarker}\nFIX_RESULT_GZIP_BASE64:\n${gzipSync(Buffer.from(JSON.stringify(proposal), "utf8")).toString("base64")}`;
  const expected = { requestId, requestCommentId: 10, owner: "erpsarang", expectedMarker };
  const accepted = api.selectSubscriptionResult("FIX", [resultComment(body)], expected);
  assert.deepEqual(accepted && JSON.parse(accepted.raw), proposal);
  for (const kind of ["IMPLEMENT", "REVIEW"]) {
    assert.equal(api.selectSubscriptionResult(kind, [resultComment(body)], { ...expected, expectedMarker: "x" }), null);
  }

  const files = (identity: unknown) => ({ "identity.json": JSON.stringify(identity), "prompt.md": "prompt", "schema.json": "{}" });
  const root = mkdtempSync(join(tmpdir(), "fix-request-load-"));
  const previousAttempt = process.env.GITHUB_RUN_ATTEMPT;
  process.env.GITHUB_RUN_ATTEMPT = "2";
  const load = (identity: unknown, kind = "FIX") => {
    const { data, digest } = requestArchive(files(identity));
    return api.loadSubscriptionRequest({
      kind,
      github: fakeGithub(data, digest, { workflow_run: { id: 707 } }),
      context: { repo: { owner: "erpsarang", repo: "self-improvement-mvp" }, runId: 707 },
      artifactName: "implement-request-a",
      artifactId: 808,
      artifactDigest: digest,
      issueNumber: 350,
      directory: join(root, "request"),
    });
  };
  try {
    assert.deepEqual(await load(fixIdentity()), fixIdentity());
    await assert.rejects(load(fixIdentity({ model: "opus" })), /identity mismatch/);
    await assert.rejects(load(fixIdentity({ kind: "trusted-implement-request" })), /identity mismatch/);
    await assert.rejects(load(fixIdentity({ worker: { runId: 707, runAttempt: 1 } })), /identity mismatch/);
    await assert.rejects(load(fixIdentity(), "IMPLEMENT"), /identity mismatch/);
  } finally {
    if (previousAttempt === undefined) delete process.env.GITHUB_RUN_ATTEMPT;
    else process.env.GITHUB_RUN_ATTEMPT = previousAttempt;
    rmSync(root, { recursive: true, force: true });
  }
});

test("REVIEW request artifact는 Trusted Rail run과 opus에 묶인 identity만 받는다", async () => {
  const files = (value: unknown) => ({ "identity.json": JSON.stringify(value), "prompt.md": "prompt", "schema.json": "{}" });
  const context = { repo: { owner: "erpsarang", repo: "self-improvement-mvp" }, runId: 901 };
  const root = mkdtempSync(join(tmpdir(), "review-request-load-"));
  const previousAttempt = process.env.GITHUB_RUN_ATTEMPT;
  process.env.GITHUB_RUN_ATTEMPT = "1";
  const load = (value: unknown, kind = "REVIEW") => {
    const { data, digest } = requestArchive(files(value));
    return api.loadSubscriptionRequest({
      kind,
      github: fakeGithub(data, digest, { workflow_run: { id: 901 } }),
      context,
      artifactName: "implement-request-a",
      artifactId: 808,
      artifactDigest: digest,
      issueNumber: 349,
      directory: join(root, "request"),
    });
  };
  try {
    assert.deepEqual(await load(reviewIdentity()), reviewIdentity());
    await assert.rejects(load(reviewIdentity({ model: "sonnet" })), /identity mismatch/);
    await assert.rejects(load(reviewIdentity({ kind: "trusted-implement-request" })), /identity mismatch/);
    await assert.rejects(load(reviewIdentity({ rail: { runId: 902, runAttempt: 1 } })), /identity mismatch/);
    await assert.rejects(load(reviewIdentity(), "IMPLEMENT"), /identity mismatch/);
  } finally {
    if (previousAttempt === undefined) delete process.env.GITHUB_RUN_ATTEMPT;
    else process.env.GITHUB_RUN_ATTEMPT = previousAttempt;
    rmSync(root, { recursive: true, force: true });
  }
});

/** LEARN run이 만드는 trusted-learn-request identity (Private learn_bridge 계약). */
function learnIdentity(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: "trusted-learn-request",
    repository: "erpsarang/self-improvement-mvp",
    issueNumber: 349,
    baseSha: "a".repeat(40),
    humanMergePullRequest: 350,
    packDigest: "c".repeat(64),
    sourceRun: { runId: 600, runAttempt: 1 },
    worker: { runId: 707, runAttempt: 1 },
    model: "sonnet",
    ...overrides,
  };
}

test("LEARN marker는 LEARN run과 sonnet을 담고 FIX·IMPLEMENT 결과와 섞이지 않는다", async () => {
  const value = learnIdentity();
  const requestId = api.implementRequestId(value, ARTIFACT_ID, ARTIFACT_DIGEST);
  assert.equal(
    api.subscriptionRequestMarker("LEARN", value, requestId, ARTIFACT_ID, ARTIFACT_DIGEST),
    `<!-- ai-dev-framework:LEARN_REQUEST v=1 request=${requestId} issue=349 repository=erpsarang/self-improvement-mvp base=${"a".repeat(40)} worker-run=707 worker-attempt=1 artifact=808 digest=${ARTIFACT_DIGEST} model=sonnet -->`,
  );
  const expectedMarker = api.subscriptionResultMarker("LEARN", value, requestId, ARTIFACT_ID, ARTIFACT_DIGEST);
  const report = { schemaVersion: 1, kind: "untrusted-learn-report" };
  const body = `${expectedMarker}\nLEARN_RESULT_GZIP_BASE64:\n${gzipSync(Buffer.from(JSON.stringify(report), "utf8")).toString("base64")}`;
  const expected = { requestId, requestCommentId: 10, owner: "erpsarang", expectedMarker };
  const accepted = api.selectSubscriptionResult("LEARN", [resultComment(body)], expected);
  assert.deepEqual(accepted && JSON.parse(accepted.raw), report);
  for (const kind of ["IMPLEMENT", "FIX"]) {
    assert.equal(api.selectSubscriptionResult(kind, [resultComment(body)], { ...expected, expectedMarker: "x" }), null);
  }

  const files = (identity: unknown) => ({ "identity.json": JSON.stringify(identity), "prompt.md": "prompt", "schema.json": "{}" });
  const root = mkdtempSync(join(tmpdir(), "learn-request-load-"));
  const previousAttempt = process.env.GITHUB_RUN_ATTEMPT;
  process.env.GITHUB_RUN_ATTEMPT = "1";
  const load = (identity: unknown, kind = "LEARN") => {
    const { data, digest } = requestArchive(files(identity));
    return api.loadSubscriptionRequest({
      kind,
      github: fakeGithub(data, digest, { workflow_run: { id: 707 } }),
      context: { repo: { owner: "erpsarang", repo: "self-improvement-mvp" }, runId: 707 },
      artifactName: "implement-request-a",
      artifactId: 808,
      artifactDigest: digest,
      issueNumber: 349,
      directory: join(root, "request"),
    });
  };
  try {
    assert.deepEqual(await load(learnIdentity()), learnIdentity());
    await assert.rejects(load(learnIdentity({ model: "opus" })), /identity mismatch/);
    await assert.rejects(load(learnIdentity({ kind: "trusted-fix-request" })), /identity mismatch/);
    await assert.rejects(load(learnIdentity({ worker: { runId: 708, runAttempt: 1 } })), /identity mismatch/);
    await assert.rejects(load(learnIdentity(), "FIX"), /identity mismatch/);
  } finally {
    if (previousAttempt === undefined) delete process.env.GITHUB_RUN_ATTEMPT;
    else process.env.GITHUB_RUN_ATTEMPT = previousAttempt;
    rmSync(root, { recursive: true, force: true });
  }
});
