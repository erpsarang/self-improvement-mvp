import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/plan.yml", "utf8");
const handler = readFileSync("src/self-improvement/plan-retry-handler.ts", "utf8");
const retryJob = workflow.split("\n  auto_retry:\n")[1] ?? "";

test("PLAN 자동 재시도 job은 failure notice 뒤에 같은 workflow 안에서만 돌고 AUTO_REPLAN=off면 돌지 않는다", () => {
  assert.ok(retryJob.length > 0, "auto_retry job이 plan.yml 안에 있어야 한다(새 workflow 파일이 아니다)");
  assert.match(retryJob, /needs: \[plan, request, resolve, failure_notice\]/);
  assert.match(retryJob, /always\(\) &&\s+needs\.plan\.result == 'success' &&\s+needs\.failure_notice\.result == 'success' &&\s+vars\.AUTO_REPLAN != 'off'/);
  assert.match(retryJob, /plan-retry-handler\.ts/);
  assert.match(retryJob, /AUTO_REPLAN: \$\{\{ vars\.AUTO_REPLAN \}\}/);
});

test("PLAN 자동 재시도 job은 AI를 직접 호출하지 않고 Issue 댓글과 plan.yml dispatch 권한만 가진다", () => {
  const permissions = retryJob.split("\n    steps:\n", 1)[0] ?? "";
  assert.match(permissions, /permissions:\s+actions: write\s+contents: read\s+issues: write/);
  assert.doesNotMatch(permissions, /contents: write|pull-requests: write/);
  assert.doesNotMatch(retryJob, /secrets\.|AI_EXECUTOR_REPOSITORY|codex-action|claude-code-action/);
});

test("재시도 입력은 resolve job의 exact 사유 출력과 run identity뿐이고 Issue 본문·사유 텍스트는 dispatch에 넘기지 않는다", () => {
  assert.match(retryJob, /PLAN_IDENTITY: \$\{\{ needs\.plan\.outputs\.identity \}\}/);
  assert.match(retryJob, /PLAN_FAILURE_REASON: \$\{\{ needs\.resolve\.outputs\.failure_reason \}\}/);
  assert.match(retryJob, /PLAN_EXECUTOR_FAILURE_REASON: \$\{\{ needs\.resolve\.outputs\.executor_failure_reason \}\}/);
  assert.match(retryJob, /PLAN_RESULT_TIMEOUT: \$\{\{ needs\.resolve\.outputs\.result_timeout \}\}/);
  assert.match(retryJob, /REQUEST_RESULT: \$\{\{ needs\.request\.result \}\}/);
  assert.match(retryJob, /RESOLVE_RESULT: \$\{\{ needs\.resolve\.result \}\}/);
  assert.match(retryJob, /SOURCE_RUN_ID: \$\{\{ github\.run_id \}\}/);
  assert.match(handler, /actions\/workflows\/plan\.yml\/dispatches/);
  assert.equal((handler.match(/\/dispatches/g) ?? []).length, 1);
  assert.match(handler, /inputs: \{ issue_number: String\(key\.issueNumber\) \}/);
  assert.doesNotMatch(handler, /inputs: \{[^}]*(reason|body|digest)/);
});

test("재시도 예산과 중복 판정은 trusted bot 댓글의 marker에서만 읽고 승인을 대신하지 않는다", () => {
  assert.match(handler, /comment\.user\?\.login === TRUSTED_COMMENT_LOGIN/);
  assert.match(handler, /const TRUSTED_COMMENT_LOGIN = "github-actions\[bot\]"/);
  assert.match(handler, /Human `PLAN-승인`이 필요합니다\. 자동 재시도는 승인을 대신하지 않습니다\./);
  assert.match(handler, /HumanStatus: PLAN_FAILED/);
  assert.match(handler, /issue\.state !== "open"/);
});

test("resolve job은 wait timeout을 exact 출력으로 남기고 failure notice는 자동 재시도 가능성을 안내한다", () => {
  assert.match(workflow, /result_timeout: \$\{\{ steps\.wait\.outputs\.result_timeout \}\}/);
  assert.match(workflow, /core\.setOutput\('result_timeout', 'true'\);\s+throw new Error\('Timed out waiting for private subscription executor PLAN_RESULT'\)/);
  // 안내는 재시도 집합(plan-retry.ts의 RETRYABLE_CODES)과 같은 조건을 사람 말로 적는다. 집합이 바뀌면 이 문장도 바꾼다.
  assert.match(workflow, /사유가 `executor가 PLAN_FAILED\(EXECUTION_FAILED\)를 알림`이면 프레임워크가 1~2분 안에 자동으로 한 번 다시 시도하고/);
  assert.match(workflow, /그 밖의 사유는 자동으로 다시 시도하지 않습니다/);
});
