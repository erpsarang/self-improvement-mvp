import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(".github/workflows/orchestrator.yml", "utf8");
const trustedRail = await readFile(".github/workflows/trusted-rail.yml", "utf8");
const routeSection = workflow.split("\n  route:\n")[1]?.split("\n  merge_boundary:\n")[0] ?? "";
const mergeSection = workflow.split("\n  merge_boundary:\n")[1]?.split("\n  record:\n")[0] ?? "";
const recordSection = workflow.split("\n  record:\n")[1] ?? "";
const orchestrateSection = trustedRail.split("\n  orchestrate:\n")[1] ?? "";

test("Orchestrator는 workflow_run chain이 아니라 same-run reusable workflow다", () => {
  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /permissions: \{\}/);
  assert.doesNotMatch(workflow, /workflows: \["Trusted Rail"\]|types: \[completed\]/);
  assert.doesNotMatch(workflow, /github\.event\.workflow_run|context\.payload\.workflow_run/);
});

test("Trusted Rail은 Semantic REVIEW 성공 뒤 Orchestrator를 명시적으로 호출한다", () => {
  assert.match(trustedRail, /\n  orchestrate:\n/);
  assert.match(orchestrateSection, /needs: review/);
  assert.match(orchestrateSection, /needs\.review\.result == 'success'/);
  assert.match(orchestrateSection, /uses: \.\/\.github\/workflows\/orchestrator\.yml/);
  assert.match(
    orchestrateSection,
    /permissions:\n      contents: read\n      actions: write\n      pull-requests: write/,
  );
});

test("route와 record는 read-only이고 같은 Trusted Rail run의 최신 non-future REVIEW artifact를 사용한다", () => {
  for (const section of [routeSection, recordSection]) {
    assert.match(section, /permissions:\n      contents: read\n      actions: read/);
    assert.doesNotMatch(section, /contents: write|pull-requests: write|issues: write/);
    assert.match(section, /GITHUB_RUN_ID/);
    assert.match(section, /GITHUB_RUN_ATTEMPT/);
    assert.match(section, /review-provenance-issue-/);
    assert.match(section, /attempt-\(\[1-9\]\\\\d\*\)/);
    assert.match(section, /attempt <= runAttempt/);
    assert.match(section, /Math\.max\(\.\.\.matches\.map/);
    assert.match(section, /run-id: \$\{\{ github\.run_id \}\}/);
    assert.match(section, /SOURCE_REVIEW_RUN_ID: \$\{\{ github\.run_id \}\}/);
    assert.match(section, /SOURCE_REVIEW_WORKFLOW_PATH: \.github\/workflows\/trusted-rail\.yml/);
  }
  assert.match(routeSection, /review_artifact_attempt: \$\{\{ steps\.review_artifact\.outputs\.attempt \}\}/);
  assert.match(routeSection, /SOURCE_REVIEW_RUN_ATTEMPT: \$\{\{ steps\.review_artifact\.outputs\.attempt \}\}/);
  assert.match(recordSection, /PREPARED_REVIEW_ATTEMPT: \$\{\{ needs\.route\.outputs\.review_artifact_attempt \}\}/);
  assert.match(recordSection, /SOURCE_REVIEW_RUN_ATTEMPT: \$\{\{ steps\.review_artifact\.outputs\.attempt \}\}/);
  assert.match(routeSection, /orchestrator-handler\.ts prepare/);
  assert.match(recordSection, /REVIEW artifact changed between route and record/);
  assert.match(recordSection, /orchestrator-handler\.ts prepare/);
  assert.match(recordSection, /orchestrator-handler\.ts finalize/);
});

test("failed-job rerun은 이전 REVIEW attempt를 재사용하되 artifact actual attempt를 provenance 검증에 전달한다", () => {
  assert.match(routeSection, /latestAttempt < runAttempt/);
  assert.match(routeSection, /reuses REVIEW artifact from attempt/);
  assert.match(routeSection, /core\.setOutput\('attempt', String\(latestAttempt\)\)/);
  assert.doesNotMatch(routeSection, /SOURCE_REVIEW_RUN_ATTEMPT: \$\{\{ github\.run_attempt \}\}/);
  assert.doesNotMatch(recordSection, /SOURCE_REVIEW_RUN_ATTEMPT: \$\{\{ github\.run_attempt \}\}/);
});

test("REVIEW artifact가 없거나 동일 latest attempt에 중복되면 fail-closed 한다", () => {
  assert.match(routeSection, /if \(matches\.length === 0\)/);
  assert.match(routeSection, /no current or prior REVIEW provenance artifact found/);
  assert.match(routeSection, /if \(latest\.length !== 1\)/);
  assert.match(routeSection, /ambiguous REVIEW provenance artifacts/);
  assert.doesNotMatch(routeSection, /should_run', 'false'/);
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

test("PR은 Human-only Merge 경계이며 Orchestrator에는 merge/auto-merge/push가 없다", () => {
  assert.match(mergeSection, /최종 Merge는 \*\*Human-only\*\*/);
  assert.match(mergeSection, /Auto Merge는 사용하지 않습니다/);
  assert.doesNotMatch(workflow, /gh\s+pr\s+merge|enablePullRequestAutoMerge|auto-merge|AUTO_MERGE|git\s+push/);
});

test("Orchestration provenance는 same-run source REVIEW와 exact PR identity를 fresh trusted runner에서 기록한다", () => {
  assert.match(recordSection, /route와 record exact identity 비교/);
  assert.match(recordSection, /ORCHESTRATOR_RUN_ID: \$\{\{ github\.run_id \}\}/);
  assert.match(recordSection, /ORCHESTRATOR_RUN_ATTEMPT: \$\{\{ github\.run_attempt \}\}/);
  assert.match(recordSection, /MERGE_PR_HEAD_SHA: \$\{\{ needs\.merge_boundary\.outputs\.pr_head_sha \}\}/);
  assert.match(recordSection, /orchestration-provenance-issue-/);
});
