import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const workflow = readFileSync(".github/workflows/plan.yml", "utf8");
const scripts = [...workflow.matchAll(/          script: \|\n((?:            .*\n|\n)+)/g)]
  .map(match => match[1]!.split("\n").map(line => line.slice(12)).join("\n"));
const freezeScript = scripts.find((script) => script.includes("const raw = process.env.ISSUE_NUMBER"))!;
const provenanceScript = scripts.find((script) => script.includes("kind: 'untrusted-plan-provenance'"))!;
const pointerScript = scripts.find((script) => script.includes("Missing PLAN Decision Packet"))!;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const require = createRequire(import.meta.url);

export interface FreezeOptions {
  readonly attempt?: string;
  readonly event?: string;
  readonly actor?: string;
  readonly user?: { login: string; id: number; type: string } | null;
  readonly association?: string;
  /** Freeze step이 남긴 step output을 받는다 (예: planner_model). */
  readonly outputs?: Record<string, string>;
}

export async function freeze(title: string, body: string, attemptOrOptions: string | FreezeOptions = "1") {
  const options: FreezeOptions = typeof attemptOrOptions === "string" ? { attempt: attemptOrOptions } : attemptOrOptions;
  const attempt = options.attempt ?? "1";
  const user = options.user === undefined ? { login: "member", id: 8370921, type: "User" } : options.user;
  const root = mkdtempSync(join(tmpdir(), "plan-provenance-"));
  const outputs: Record<string, string> = {};
  try {
    await new AsyncFunction("require", "process", "github", "context", "core", freezeScript)(
      require, { env: {
        RUNNER_TEMP: root, ISSUE_NUMBER: "60", GITHUB_RUN_ID: "1234", GITHUB_RUN_ATTEMPT: attempt,
        PLAN_INGRESS_EVENT: options.event ?? "issues", PLAN_INGRESS_ACTOR: options.actor ?? "member",
      } },
      { rest: {
        issues: { get: async () => ({ data: { number: 60, title, body, user, author_association: options.association ?? "OWNER" } }) },
        repos: { get: async () => ({ data: { default_branch: "main" } }), getCommit: async () => ({ data: { sha: "a".repeat(40) } }) },
      } },
      { repo: { owner: "example", repo: "app" }, sha: "b".repeat(40) },
      { setOutput: (key: string, value: string) => { outputs[key] = value; } },
    );
    if (options.outputs) Object.assign(options.outputs, outputs);
    const identity = JSON.parse(outputs.identity!);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "ai-plan/identity.json"), "utf8")), identity);
    return identity;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("trusted freeze records exact requirement, repository, SHA and run attempt", async () => {
  const identity = await freeze("요구\r\n제목", "본문\n");
  assert.equal(identity.requirement.issueNumber, 60);
  assert.equal(identity.requirement.digest, createHash("sha256").update(JSON.stringify(["요구\r\n제목", "본문\n"])).digest("hex"));
  assert.equal(identity.repository, "example/app");
  assert.equal(identity.targetSha, "a".repeat(40));
  assert.deepEqual(identity.workflow, { runId: "1234", runAttempt: "1", sha: "b".repeat(40) });
  assert.equal(identity.artifactName, "plan-issue-60-1234-attempt-1");
  assert.notEqual(identity.requirement.digest, (await freeze("changed", "본문\n")).requirement.digest);
  assert.notEqual(identity.requirement.digest, (await freeze("요구\r\n제목", "본문")).requirement.digest);
  assert.notEqual((await freeze("a\n\nb", "c")).requirement.digest, (await freeze("a", "b\n\nc")).requirement.digest);
  assert.notEqual(identity.artifactName, (await freeze("요구\r\n제목", "본문\n", "2")).artifactName);
});

test("provenance binds upload outputs and pointer contains only trusted metadata", async () => {
  const identity = await freeze("untrusted title", "untrusted body");
  const root = mkdtempSync(join(tmpdir(), "plan-binding-"));
  const env = {
    RUNNER_TEMP: root, PLAN_IDENTITY: JSON.stringify(identity), PLAN_ARTIFACT_ID: "456",
    PLAN_ARTIFACT_DIGEST: "c".repeat(64), PLAN_ARTIFACT_URL: "https://github.com/example/app/actions/runs/1234/artifacts/456",
    PROVENANCE_URL: "https://github.com/example/app/actions/runs/1234/artifacts/457",
    PLAN_REQUEST_ID: "d".repeat(64),
    PLAN_DECISION_PACKET: "### PLAN Decision Packet (사람이 읽는 판단 재료)\n\n**준비 상태:** `ready=true` — Blocking Question 없음.",
    PLAN_READY: "true",
  };
  try {
    const bind = (values: typeof env) => new AsyncFunction("require", "process", "core", provenanceScript)(require, { env: values }, { setOutput() {} });
    await bind(env);
    const provenance = JSON.parse(readFileSync(join(root, "PLAN-provenance.json"), "utf8"));
    assert.deepEqual(provenance.artifact, { name: identity.artifactName, id: "456", digestAlgorithm: "sha256", digest: env.PLAN_ARTIFACT_DIGEST, url: env.PLAN_ARTIFACT_URL });
    assert.deepEqual(provenance.requirement, identity.requirement);
    assert.equal(provenance.targetSha, identity.targetSha);
    await assert.rejects(bind({ ...env, PLAN_ARTIFACT_DIGEST: "" }), /exact uploaded PLAN identity/);
    await assert.rejects(bind({ ...env, PLAN_ARTIFACT_ID: "bad" }), /exact uploaded PLAN identity/);
    let comment: any;
    const pointer = (values: typeof env) => new AsyncFunction("process", "github", "context", pointerScript)(
      { env: values }, { rest: { issues: { createComment: async (value: unknown) => { comment = value; } } } },
      { repo: { owner: "example", repo: "app" } },
    );
    await pointer(env);
    assert.equal(comment.issue_number, 60);
    for (const value of [identity.artifactName, identity.requirement.digest, env.PLAN_ARTIFACT_DIGEST, env.PROVENANCE_URL, identity.targetSha, env.PLAN_REQUEST_ID]) assert.ok(comment.body.includes(value));
    assert.doesNotMatch(comment.body, /untrusted title|untrusted body/);

    // Decision Packet은 trusted validation을 통과한 PLAN의 사람용 발췌로 pointer에 들어가되,
    // PLAN_AUTHORIZE가 파싱하는 접두/Workflow run 줄 뒤, HumanStatus 앞에 위치한다.
    const body: string = comment.body;
    assert.ok(body.startsWith("## PLAN (AI 제안 — 구현 승인 아님)"));
    const runLine = body.indexOf("Workflow run: 1234 / attempt: 1");
    const packet = body.indexOf(env.PLAN_DECISION_PACKET);
    const status = body.indexOf("### HumanStatus: PLAN");
    assert.ok(runLine !== -1 && packet > runLine && status > packet);
    assert.match(body, /\*\*다음 행동:\*\* 위 PLAN Decision Packet을 읽고/);

    comment = undefined;
    await pointer({ ...env, PLAN_READY: "false", PLAN_DECISION_PACKET: "### PLAN Decision Packet (사람이 읽는 판단 재료)\n\n**준비 상태:** `ready=false`" });
    assert.match(comment.body, /\*\*다음 행동:\*\* 이 PLAN은 승인할 수 없습니다/);

    // 판단 재료가 없으면 승인 가능한 pointer를 남기지 않는다.
    comment = undefined;
    await assert.rejects(pointer({ ...env, PLAN_DECISION_PACKET: "" }), /Missing PLAN Decision Packet/);
    await assert.rejects(pointer({ ...env, PLAN_READY: "" }), /Missing PLAN Decision Packet/);
    await assert.rejects(pointer({ ...env, PLAN_DECISION_PACKET: "not a packet" }), /Missing PLAN Decision Packet/);
    assert.equal(comment, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("workflow isolates write permission and uses upload result rather than planner claims", () => {
  assert.equal(scripts.length, 6);
  assert.ok(freezeScript && provenanceScript && pointerScript);
  const planJob = workflow.split("\n  plan:\n")[1]?.split("\n  request:\n", 1)[0] ?? "";
  const requestJob = workflow.split("\n  request:\n")[1]?.split("\n  resolve:\n", 1)[0] ?? "";
  const resolveJob = workflow.split("\n  resolve:\n")[1]?.split("\n  provenance:\n", 1)[0] ?? "";
  const provenanceJob = workflow.split("\n  provenance:\n")[1]?.split("\n  failure_notice:\n", 1)[0] ?? "";
  assert.match(planJob, /github\.event_name == 'workflow_dispatch'[\s\S]*github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/);
  assert.match(planJob, /github\.event_name == 'issues'[\s\S]*startsWith\(github\.event\.issue\.title, '\[업무 요구\]'\)/);
  assert.match(planJob, /ai-plan\/identity.json/);
  assert.match(planJob, /artifactName \}\}-request/);
  assert.doesNotMatch(planJob, /issues: write|codex-action|claude-code-action/);
  assert.match(requestJob, /issues: write/);
  assert.doesNotMatch(requestJob, /checkout@|codex-action|claude-code-action/);
  assert.match(resolveJob, /issues: read/);
  assert.match(resolveJob, /actions: read/);
  assert.match(resolveJob, /download-artifact@v4/);
  assert.match(resolveJob, /raw-plan\.json/);
  assert.match(resolveJob, /artifact_digest: \$\{\{ steps\.upload\.outputs\.artifact-digest \}\}/);
  assert.match(provenanceJob, /needs: resolve/);
  assert.match(provenanceJob, /issues: write/);
  assert.doesNotMatch(provenanceJob, /checkout@|codex-action|claude-code-action|download-artifact|raw-plan/);
});

test("PLAN 결과를 받거나 검증하지 못하면 failure notice job만 Issue에 실패를 알린다 (App #289 run 36982979475)", () => {
  const resolveJob = workflow.split("\n  resolve:\n")[1]?.split("\n  provenance:\n", 1)[0] ?? "";
  const noticeJob = workflow.split("\n  failure_notice:\n")[1] ?? "";
  // resolve는 여전히 issues: read이고, 검증 실패 사유의 첫 Error 줄만 output으로 남긴다. 실패 판정은 그대로다.
  assert.doesNotMatch(resolveJob, /issues: write/);
  assert.match(resolveJob, /failure_reason: \$\{\{ steps\.validate\.outputs\.failure_reason \}\}/);
  assert.match(resolveJob, /planner-handler\.ts artifact 2> "\$RUNNER_TEMP\/plan-validate\.err" \|\| status=\$\?/);
  assert.match(resolveJob, /echo "failure_reason=\$reason" >> "\$GITHUB_OUTPUT"\n\s+exit "\$status"/);
  // notice job은 plan이 성공하고 request 또는 resolve가 실패했을 때만, 댓글 쓰기 권한 하나로 실행된다.
  assert.match(noticeJob, /needs: \[plan, request, resolve\]/);
  assert.match(noticeJob, /always\(\) &&\n\s+needs\.plan\.result == 'success' &&\n\s+\(needs\.request\.result == 'failure' \|\| needs\.resolve\.result == 'failure'\)/);
  assert.match(noticeJob, /permissions:\n      issues: write\n    steps:/);
  assert.doesNotMatch(noticeJob, /checkout@|download-artifact|secrets\.|actions: |contents: /);
  assert.match(noticeJob, /### HumanStatus: PLAN_FAILED/);
  assert.match(noticeJob, /replace\(\/\[`\\r\\n\]\/g, ' '\)\.trim\(\)\.slice\(0, 300\)/);
});

test("PLAN_FAILED 안내는 본문을 고친 뒤 Actions에서 다시 실행해야 하고 본문 수정만으로는 시작되지 않음을 알린다", () => {
  const noticeJob = workflow.split("\n  failure_notice:\n")[1] ?? "";
  assert.match(noticeJob, /필요하면 Issue 본문을 보완한 뒤, Actions → Read-only AI PLAN을 이 Issue 번호로 다시 실행하세요/);
  assert.match(noticeJob, /Issue 본문을 고치는 것만으로는 PLAN이 다시 시작되지 않습니다/);
  // "보완하거나 … 다시 실행"은 둘 중 하나만 해도 되는 뜻으로 읽혀 사람이 본문 수정만 하고 기다렸다 (App #19).
  assert.doesNotMatch(noticeJob, /본문을 보완하거나/);
  // 안내가 사실이려면 PLAN 시작 조건에 본문 수정(edited)이 없어야 한다.
  const triggers = workflow.split("\npermissions:", 1)[0] ?? "";
  assert.match(triggers, /issues:\n    types: \[opened, reopened\]/);
  assert.doesNotMatch(triggers, /edited/);
});

test("파일 수 한도 초과로 PLAN이 실패하면 사유 원문은 그대로 두고 쉬운 설명을 덧붙인다", () => {
  const noticeJob = workflow.split("\n  failure_notice:\n")[1] ?? "";
  assert.match(noticeJob, /const scopeTooLarge = \/PLAN scope cannot hold existing tests\/\.test\(reason\);/);
  assert.match(noticeJob, /scopeTooLarge \? \[`\*\*쉬운 설명:\*\* 한 번에 바꾸려는 내용이 많아 PLAN을 만들 수 없습니다\.\$\{sizeDetail\} /);
  // 개수는 오류 사유의 "(changed N + impacted tests M = T)"에서 읽고, 사람 말로 풀어 쓴다. 형식이 다르면 덧붙이지 않는다.
  assert.match(noticeJob, /within \(\\d\+\) bounded paths \\\(changed \(\\d\+\) \\\+ impacted tests \(\\d\+\) = \(\\d\+\)\\\)/);
  assert.match(noticeJob, /sizeMatch \? ` \(PLAN이 고른 변경 파일 \$\{sizeMatch\[2\]\}개 \+ 자동으로 더해지는 기존 테스트 \$\{sizeMatch\[3\]\}개 = \$\{sizeMatch\[4\]\}개, 한도 \$\{sizeMatch\[1\]\}개\)` : ''/);
  // 사유 원문 줄은 그대로다.
  assert.match(noticeJob, /reason \? `사유: \\`\$\{reason\}\\`` : '사유: 위 run 로그를 확인하세요\.'/);
  // 한도 초과 문구가 실제 오류 문구와 같은 곳에서 나온다.
  const source = readFileSync(new URL("../src/self-improvement/plan-business-context.ts", import.meta.url), "utf8");
  assert.match(source, /PLAN scope cannot hold existing tests that import changed sources/);
});
