import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(".github/workflows/orchestrator.yml", "utf8");
const routeSection = workflow.split("\n  route:\n")[1]?.split("\n  merge_boundary:\n")[0] ?? "";
const mergeSection = workflow.split("\n  merge_boundary:\n")[1]?.split("\n  record:\n")[0] ?? "";
const recordSection = workflow.split("\n  record:\n")[1] ?? "";

test("Orchestrator v0는 성공한 Trusted Rail 뒤에만 진입하고 workflow-level 권한은 비어 있다", () => {
  assert.match(workflow, /workflows: \["Trusted Rail"\]/);
  assert.match(workflow, /types: \[completed\]/);
  assert.match(workflow, /permissions: \{\}/);
  assert.match(routeSection, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(routeSection, /run\.path !== '\.github\/workflows\/trusted-rail\.yml'/);
});

test("route와 record는 read-only이고 source REVIEW artifact를 exact run/attempt에 결합한다", () => {
  for (const section of [routeSection, recordSection]) {
    assert.match(section, /permissions:\n      contents: read\n      actions: read/);
    assert.doesNotMatch(section, /contents: write|pull-requests: write|issues: write/);
  }
  assert.match(routeSection, /review-provenance-issue-/);
  assert.match(routeSection, /\$\{run\.id\}-attempt-\$\{run\.run_attempt\}/);
  assert.match(routeSection, /orchestrator-handler\.ts prepare/);
  assert.match(recordSection, /REVIEW artifact changed between route and record/);
  assert.match(recordSection, /orchestrator-handler\.ts prepare/);
  assert.match(recordSection, /orchestrator-handler\.ts finalize/);
});

test("PASS → MERGE_READY일 때만 PR boundary job이 실행된다", () => {
  assert.match(mergeSection, /needs\.route\.outputs\.should_create_pr == 'true'/);
  assert.match(mergeSection, /decision !== 'PASS' \|\| nextState !== 'MERGE_READY'/);
  assert.match(mergeSection, /branch !== `ai-publish\/issue-\$\{issueNumber\}`/);
});

test("PR boundary는 contents read + pull-requests write만 사용하고 exact remote SHA를 검증한다", () => {
  assert.match(mergeSection, /permissions:\n      contents: read\n      pull-requests: write/);
  assert.doesNotMatch(mergeSection, /contents: write|actions: write|issues: write/);
  assert.match(mergeSection, /github\.rest\.git\.getRef/);
  assert.match(mergeSection, /ref\.object\.sha !== expectedSha/);
  assert.match(mergeSection, /github\.rest\.pulls\.list/);
  assert.match(mergeSection, /state: 'all'/);
  assert.match(mergeSection, /ambiguous Human Merge PRs/);
  assert.match(mergeSection, /github\.rest\.pulls\.create/);
  assert.match(mergeSection, /exactPr\.head\.sha !== expectedSha/);
});

test("PR은 Human-only Merge 경계이며 workflow 어디에도 merge/auto-merge/push가 없다", () => {
  assert.match(mergeSection, /최종 Merge는 \*\*Human-only\*\*/);
  assert.match(mergeSection, /Auto Merge는 사용하지 않습니다/);
  assert.doesNotMatch(workflow, /gh\s+pr\s+merge|enablePullRequestAutoMerge|auto-merge|AUTO_MERGE|git\s+push/);
});

test("Orchestration provenance는 source REVIEW와 exact PR identity를 fresh trusted runner에서 기록한다", () => {
  assert.match(recordSection, /route와 record exact identity 비교/);
  assert.match(recordSection, /ORCHESTRATOR_RUN_ID: \$\{\{ github\.run_id \}\}/);
  assert.match(recordSection, /MERGE_PR_HEAD_SHA: \$\{\{ needs\.merge_boundary\.outputs\.pr_head_sha \}\}/);
  assert.match(recordSection, /orchestration-provenance-issue-/);
});
