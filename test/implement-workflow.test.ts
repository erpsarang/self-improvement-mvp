import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(".github/workflows/implement.yml", "utf8");

test("AUTHORIZE rerun이 이전 artifact를 재사용하면 IMPLEMENT를 no-op 처리한다", () => {
  assert.match(workflow, /const prior = matches\.filter\(\(\{ attempt \}\) => attempt < run\.run_attempt\);/);
  assert.match(workflow, /current\.length === 0 && prior\.length === 1 && matches\.length === 1/);
  assert.match(workflow, /core\.setOutput\('should_run', 'false'\)/);
  assert.match(workflow, /if: needs\.implement\.outputs\.should_run == 'true'/);
});

test("새 AUTHORIZE artifact가 있는 경우에만 Codex와 candidate 생성 단계가 실행된다", () => {
  assert.match(workflow, /core\.setOutput\('should_run', 'true'\)/);
  const guardedSteps = workflow.match(/if: steps\.authorization_artifact\.outputs\.should_run == 'true'/g) ?? [];
  assert.ok(guardedSteps.length >= 8);
  assert.match(workflow, /uses: openai\/codex-action@v1/);
  assert.match(workflow, /git diff --binary --full-index "\$BASE_SHA" -- \./);
});

test("IMPLEMENT workflow는 GitHub write 권한과 publish 경로를 갖지 않는다", () => {
  assert.match(workflow, /permissions:\n  contents: read\n  actions: read\n  issues: read/);
  assert.doesNotMatch(workflow, /contents: write|pull-requests: write|issues: write|git push|gh pr create|AUTO_MERGE/);
  assert.match(workflow, /persist-credentials: false/);
});
