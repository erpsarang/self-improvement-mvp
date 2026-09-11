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

test("일반 댓글로 AUTHORIZE job이 skipped되면 IMPLEMENT를 정상 no-op 처리한다", () => {
  assert.match(workflow, /listJobsForWorkflowRun/);
  assert.match(workflow, /job\.name === 'authorize'/);
  assert.match(workflow, /authorizeJobs\.length === 1 && authorizeJobs\[0\]\.conclusion === 'skipped'/);
  assert.match(workflow, /AUTHORIZE job was skipped; IMPLEMENT is a no-op/);
});

test("artifact가 없지만 AUTHORIZE job이 skipped가 아니면 fail-closed 한다", () => {
  assert.match(workflow, /if \(matches\.length === 0\)/);
  assert.match(workflow, /core\.setFailed\(/);
  assert.match(workflow, /expected one current AUTHORIZE artifact, one earlier replay artifact, or a skipped AUTHORIZE job/);
});

test("새 AUTHORIZE artifact가 있는 경우에만 Codex와 candidate 생성 단계가 실행된다", () => {
  assert.match(workflow, /core\.setOutput\('should_run', 'true'\)/);
  const guardedSteps = workflow.match(/if: steps\.authorization_artifact\.outputs\.should_run == 'true'/g) ?? [];
  assert.ok(guardedSteps.length >= 8);
  assert.match(workflow, /uses: openai\/codex-action@v1/);
});

test("Untrusted IMPLEMENT job은 silent stall을 10분 hard timeout으로 제한한다", () => {
  const implementSection = workflow.split("\n  record:\n")[0] ?? "";
  assert.match(implementSection, /\n    timeout-minutes: 10\n/);
});

test("untrusted job은 Git patch를 만들지 않고 mode 보존 tar snapshot만 남긴다", () => {
  assert.doesNotMatch(workflow, /git add -N \./);
  const implementSection = workflow.split("\n  record:\n")[0] ?? "";
  assert.doesNotMatch(implementSection, /git diff/);
  assert.match(workflow, /name: mode 보존 workspace tar 생성/);
  assert.match(workflow, /--exclude='\.\/node_modules'/);
  assert.match(workflow, /candidate-workspace\.tar\.gz/);
  assert.match(workflow, /tar -xzf/);
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

test("untracked 파일명은 -- 뒤에 전달해 Git option으로 해석되지 않게 한다", () => {
  assert.match(workflow, /-- \/dev\/null "\$file" >> "\$PATCH_FILE"/);
});

test("IMPLEMENT workflow는 GitHub write 권한과 publish 경로를 갖지 않는다", () => {
  assert.match(workflow, /permissions:\n  contents: read\n  actions: read\n  issues: read/);
  assert.doesNotMatch(workflow, /contents: write|pull-requests: write|issues: write|git push|gh pr create|AUTO_MERGE/);
  assert.match(workflow, /persist-credentials: false/);
});

test("initial IMPLEMENT는 Trusted AUTHORIZE만 구독하고 legacy FIX workflow_run 경로를 갖지 않는다", () => {
  assert.match(workflow, /workflows: \["Trusted AUTHORIZE"\]/);
  assert.doesNotMatch(workflow, /Trusted FIX Request/);
  assert.doesNotMatch(workflow, /\n  fix_prepare:\n|\n  fix_worker:\n|\n  fix_record:\n/);
  assert.doesNotMatch(workflow, /fix-handler\.ts|fix-request\.json|fix-prompt\.txt/);
});
