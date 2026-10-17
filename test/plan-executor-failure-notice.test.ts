import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as nodeFs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { join } from "node:path";
import test from "node:test";
import * as nodeZlib from "node:zlib";
import { gzipSync } from "node:zlib";

const workflow = await readFile(".github/workflows/plan.yml", "utf8");

// plan.yml의 "Wait for subscription PLAN result" github-script 본문을 꺼내 mock github/context로 실행한다.
function waitScript(): string {
  const step = workflow.split("      - name: Wait for subscription PLAN result\n")[1]?.split("\n      - name: ", 1)[0] ?? "";
  const body = step.split("          script: |\n")[1] ?? "";
  assert.ok(body.length > 0, "wait script exists");
  return body.split("\n").map((line) => line.slice(12)).join("\n");
}

const REQUEST_ID = "a".repeat(64);
const DIGEST = "b".repeat(64);
const REQUIREMENT = "c".repeat(64);
const TARGET = "d".repeat(40);
const ARTIFACT_ID = "77";
const REQUEST_COMMENT_ID = 100;
const OWNER = "erpsarang";

const identity = {
  repository: `${OWNER}/purchase-request-app`,
  targetSha: TARGET,
  requirement: { issueNumber: 14, digest: REQUIREMENT },
  workflow: { runId: 555, runAttempt: 1 },
};

const fields = `request=${REQUEST_ID} issue=14 repository=${identity.repository} target=${TARGET} requirement=${REQUIREMENT} run=555 attempt=1 artifact=${ARTIFACT_ID} digest=${DIGEST} model=opus`;
const failedMarker = (reason: string, f = fields) => `<!-- ai-dev-framework:PLAN_FAILED v=1 ${f} reason=${reason} -->`;
const resultMarker = `<!-- ai-dev-framework:PLAN_RESULT v=1 ${fields} tools=read encoding=gzip-base64 -->`;
const payload = gzipSync(Buffer.from(JSON.stringify({ ok: true }))).toString("base64");

type Comment = Record<string, unknown>;
const comment = (body: string, overrides: Comment = {}): Comment => ({
  id: 200,
  body,
  author_association: "OWNER",
  user: { type: "User", login: OWNER },
  ...overrides,
});

// github-script의 require와 같은 내장 모듈만 쓴다.
const requireBuiltin = (name: string) => (name === "node:fs" ? nodeFs : name === "node:path" ? nodePath : nodeZlib);

// poll마다 돌려줄 댓글 목록을 받아 wait script를 실행한다. sleep은 즉시 끝나게 바꾼다.
async function execute(polls: Comment[][]) {
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<void>;
  const fn = new AsyncFunction("github", "context", "core", "require", "process", "setTimeout", waitScript());
  const outputs: Record<string, string> = {};
  let call = 0;
  const runnerTemp = mkdtempSync(join(tmpdir(), "plan-wait-"));
  const env = {
    PLAN_IDENTITY: JSON.stringify(identity),
    PLAN_MODEL: "opus",
    REQUEST_ID,
    REQUEST_COMMENT_ID: String(REQUEST_COMMENT_ID),
    REQUEST_ARTIFACT_ID: ARTIFACT_ID,
    REQUEST_ARTIFACT_DIGEST: DIGEST,
    RUNNER_TEMP: runnerTemp,
  };
  const github = { paginate: async () => polls[Math.min(call++, polls.length - 1)], rest: { issues: { listComments: () => undefined } } };
  const core = { setOutput: (key: string, value: string) => { outputs[key] = value; }, info: () => undefined };
  const context = { repo: { owner: OWNER, repo: "purchase-request-app" } };
  let error: Error | undefined;
  let resultFile: string | undefined;
  try {
    await fn(github, context, core, requireBuiltin, { env }, (callback: () => void) => { callback(); return 0; });
    resultFile = nodeFs.readFileSync(join(runnerTemp, "plan-result", "raw-plan.json"), "utf8");
  } catch (caught) {
    error = caught as Error;
  } finally {
    rmSync(runnerTemp, { recursive: true, force: true });
  }
  return { outputs, error, resultFile };
}

test("owner의 exact PLAN_FAILED를 보면 15분을 기다리지 않고 사유와 함께 멈춘다", async () => {
  for (const reason of ["REQUEST_REJECTED", "EXECUTION_FAILED", "RESULT_POST_FAILED"]) {
    const { outputs, error } = await execute([[comment(`${failedMarker(reason)}\n## PLAN: executor가 요청을 처리하지 못함`)]]);
    assert.match(error?.message ?? "", new RegExp(`reported PLAN_FAILED reason=${reason} \\(comment 200\\)`));
    assert.equal(outputs.executor_failure_reason, reason);
  }
});

test("owner가 아니거나 요청 댓글보다 먼저 쓴 PLAN_FAILED는 무시하고 기다린다", async () => {
  const otherRequest = failedMarker("EXECUTION_FAILED", fields.replace(`request=${REQUEST_ID}`, `request=${"9".repeat(64)}`));
  const ignored = [
    comment(otherRequest),
    comment(failedMarker("EXECUTION_FAILED"), { author_association: "CONTRIBUTOR", user: { type: "User", login: "someone" } }),
    comment(failedMarker("EXECUTION_FAILED"), { user: { type: "Bot", login: OWNER } }),
    comment(failedMarker("EXECUTION_FAILED"), { id: REQUEST_COMMENT_ID - 1 }),
  ];
  // 두 번째 poll에 정상 PLAN_RESULT가 오면 그 결과를 받는다. 무시된 FAILED가 있어도 결과 경로는 그대로다.
  const { outputs, error, resultFile } = await execute([ignored, [...ignored, comment(`${resultMarker}\nPLAN_RESULT_GZIP_BASE64:\n${payload}`, { id: 300 })]]);
  assert.equal(error, undefined);
  assert.equal(outputs.executor_failure_reason, undefined);
  assert.equal(outputs.read_tools, "true");
  assert.equal(resultFile, '{"ok":true}');
});

test("identity나 사유가 어긋나거나 tools=read가 붙은 PLAN_FAILED는 받아들이지 않고 실패한다 (fail-closed)", async () => {
  const bad = [
    failedMarker("EXECUTION_FAILED", fields.replace(`target=${TARGET}`, `target=${"e".repeat(40)}`)),
    failedMarker("EXECUTION_FAILED", fields.replace("model=opus", "model=sonnet")),
    failedMarker("EXECUTION_FAILED", `${fields} tools=read`),
    failedMarker("OTHER"),
  ];
  for (const marker of bad) {
    const { outputs, error } = await execute([[comment(marker)]]);
    assert.match(error?.message ?? "", /PLAN_FAILED identity mismatch/);
    assert.equal(outputs.executor_failure_reason, undefined);
  }
});

test("본문 줄바꿈이 CRLF여도 첫 줄 marker를 exact로 읽는다", async () => {
  const { outputs, error } = await execute([[comment(`${failedMarker("EXECUTION_FAILED")}\r\n## PLAN: executor가 요청을 처리하지 못함`)]]);
  assert.match(error?.message ?? "", /reason=EXECUTION_FAILED/);
  assert.equal(outputs.executor_failure_reason, "EXECUTION_FAILED");
});

test("PLAN_FAILED와 PLAN_RESULT가 함께 있으면 결과보다 실패 신호를 먼저 본다", async () => {
  const { error } = await execute([[comment(`${resultMarker}\nPLAN_RESULT_GZIP_BASE64:\n${payload}`, { id: 150 }), comment(failedMarker("RESULT_POST_FAILED"), { id: 151 })]]);
  assert.match(error?.message ?? "", /reason=RESULT_POST_FAILED/);
});

test("resolve는 사유를 output으로 넘기고 failure_notice만 쉬운 말로 알린다 (권한 확대 없음)", () => {
  const resolveJob = workflow.split("\n  resolve:\n")[1]?.split("\n  provenance:\n", 1)[0] ?? "";
  const noticeJob = workflow.split("\n  failure_notice:\n")[1]?.split("\n  auto_retry:\n", 1)[0] ?? "";
  assert.match(resolveJob, /executor_failure_reason: \$\{\{ steps\.wait\.outputs\.executor_failure_reason \}\}/);
  assert.doesNotMatch(resolveJob, /issues: write/);
  assert.match(noticeJob, /PLAN_EXECUTOR_FAILURE_REASON: \$\{\{ needs\.resolve\.outputs\.executor_failure_reason \}\}/);
  assert.match(noticeJob, /permissions:\n      issues: write\n    steps:/);
  assert.match(noticeJob, /if \(executorReason && !Object\.hasOwn\(EXECUTOR_FAILURE_EXPLANATIONS, executorReason\)\)/);
  for (const reason of ["REQUEST_REJECTED", "EXECUTION_FAILED", "RESULT_POST_FAILED"]) {
    assert.match(noticeJob, new RegExp(`${reason}: '`));
  }
  assert.match(noticeJob, /이 run은 결과를 15분 기다리지 않고 바로 멈췄습니다/);
  // marker가 없으면 기존 15분 timeout이 안전망이다.
  assert.match(workflow, /for \(let poll = 0; poll < 90; poll \+= 1\)/);
  assert.match(workflow, /throw new Error\('Timed out waiting for private subscription executor PLAN_RESULT'\)/);
});
