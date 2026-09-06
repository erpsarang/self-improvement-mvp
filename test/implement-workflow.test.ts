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
});

test("untrusted job은 Git patch를 만들지 않고 dependency를 제외한 workspace snapshot만 남긴다", () => {
  assert.doesNotMatch(workflow, /git add -N \./);
  const implementSection = workflow.split("\n  record:\n")[0] ?? "";
  assert.doesNotMatch(implementSection, /git diff/);
  assert.match(workflow, /name: untrusted workspace snapshot 저장/);
  assert.match(workflow, /!node_modules\/\*\*/);
  assert.match(workflow, /include-hidden-files: true/);
});

test("candidate patch는 clean worktree의 Git metadata와 외부 helper 비활성화 상태에서 생성한다", () => {
  assert.match(workflow, /git worktree add --detach "\$PATCH_WORKTREE" "\$BASE_SHA"/);
  assert.match(workflow, /rsync -a --delete/);
  assert.match(workflow, /GIT_CONFIG_NOSYSTEM=1/);
  assert.match(workflow, /GIT_CONFIG_GLOBAL=\/dev\/null/);
  assert.match(workflow, /core\.hooksPath=\/dev\/null/);
  assert.match(workflow, /--no-ext-diff --no-textconv/);
  assert.match(workflow, /ls-files --others -z/);
});

test("IMPLEMENT workflow는 GitHub write 권한과 publish 경로를 갖지 않는다", () => {
  assert.match(workflow, /permissions:\n  contents: read\n  actions: read\n  issues: read/);
  assert.doesNotMatch(workflow, /contents: write|pull-requests: write|issues: write|git push|gh pr create|AUTO_MERGE/);
  assert.match(workflow, /persist-credentials: false/);
});
