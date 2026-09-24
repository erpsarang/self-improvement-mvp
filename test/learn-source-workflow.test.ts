import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/learn-source.yml", "utf8");

test("Trusted LEARN Source는 manual exact source만 받고 read-only 권한으로 실행한다", () => {
  assert.match(workflow, /name: Trusted LEARN Source/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /requirement_issue_number:/);
  assert.match(workflow, /human_merge_pr_number:/);
  assert.match(workflow, /trusted_rail_run_id:/);
  assert.match(workflow, /trusted_rail_run_attempt:/);
  assert.match(workflow, /orchestration_artifact_name:/);
  assert.match(workflow, /permissions:\n\s+contents: read\n\s+issues: read\n\s+pull-requests: read\n\s+actions: read/);
  assert.doesNotMatch(workflow, /contents:\s*write/);
  assert.doesNotMatch(workflow, /issues:\s*write/);
  assert.doesNotMatch(workflow, /pull-requests:\s*write/);
});

test("source run / default SHA / artifact identity를 exact하게 고정한다", () => {
  assert.match(workflow, /context\.sha !== currentDefault\.commit\.sha/);
  assert.match(workflow, /run\.run_attempt !== runAttempt/);
  assert.match(workflow, /run\.status !== 'completed'/);
  assert.match(workflow, /run\.conclusion !== 'success'/);
  assert.match(workflow, /run\.path !== '\.github\/workflows\/trusted-rail\.yml'/);
  assert.match(workflow, /run\.head_branch !== repo\.default_branch/);
  assert.match(workflow, /artifact\.name === artifactName/);
  assert.match(workflow, /!artifact\.expired/);
  assert.match(workflow, /\^sha256:\[0-9a-f\]\{64\}\$/);
});

test("source producer는 AI/repository write를 하지 않고 별도 job이 LEARN만 dispatch한다", () => {
  assert.doesNotMatch(workflow, /openai\/codex-action/);
  assert.doesNotMatch(workflow, /git push/);
  assert.doesNotMatch(workflow, /pulls\.create|issues\.create|issues\.createComment/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /\n  dispatch_learn:\n/);
  assert.match(workflow, /needs: source/);
  assert.match(workflow, /actions: write/);
  assert.match(workflow, /workflow_id: 'learn\.yml'/);
  assert.doesNotMatch(workflow, /workflow_id: 'plan\.yml'|workflow_id: 'implement\.yml'/);
});

test("Completed Cycle과 LEARN Input Pack을 같은 successful source run artifact로 업로드한다", () => {
  assert.match(workflow, /completed-cycle\.json/);
  assert.match(workflow, /learn-input-pack\.json/);
  assert.match(workflow, /completed_cycle_artifact_name/);
  assert.match(workflow, /learn_input_artifact_name/);
  assert.match(workflow, /steps\.upload_completed\.outputs\.artifact-id/);
  assert.match(workflow, /steps\.upload_input\.outputs\.artifact-id/);
});

test("canonical Framework repo는 실행 중인 exact SHA를 Framework source로 쓰고, App 배포본은 FRAMEWORK.md를 계속 요구한다 (#244 LEARN Source run 36018384350)", () => {
  const freeze = workflow.slice(workflow.indexOf("- name: exact GitHub cycle facts와 source artifact 선택"), workflow.indexOf("- name: exact orchestration provenance 다운로드"));
  assert.ok(freeze.length > 0);

  // 판별은 저장소 identity다. 파일 부재(404)를 canonical로 해석하지 않는다.
  assert.match(freeze, /const CANONICAL_FRAMEWORK_REPOSITORY = 'erpsarang\/self-improvement-mvp';/);
  assert.match(freeze, /if \(`\$\{context\.repo\.owner\}\/\$\{context\.repo\.repo\}` === CANONICAL_FRAMEWORK_REPOSITORY\) \{\n\s+frameworkSourceSha = context\.sha;\n\s+\} else \{/);
  assert.doesNotMatch(freeze, /catch\s*\(/, "a missing FRAMEWORK.md must never be swallowed");
  assert.doesNotMatch(freeze, /status\s*===?\s*404/);

  // App 분기: FRAMEWORK.md를 exact SHA에서 읽고 형식이 틀리면 fail-closed.
  const appBranch = freeze.slice(freeze.indexOf("} else {"));
  assert.match(appBranch, /path: 'FRAMEWORK\.md',\n\s+ref: context\.sha,/);
  assert.match(appBranch, /throw new Error\('FRAMEWORK\.md file is required'\)/);
  assert.match(appBranch, /throw new Error\('FRAMEWORK\.md must contain one canonical Framework source SHA'\)/);

  // 두 분기 모두 같은 SHA 형식 검사를 거쳐 facts에 기록된다.
  assert.match(freeze, /if \(!\/\^\[0-9a-f\]\{40,64\}\$\/\.test\(frameworkSourceSha \|\| ''\)\) throw new Error\('Framework source SHA is invalid'\);/);
  assert.ok(freeze.indexOf("Framework source SHA is invalid") < freeze.indexOf("frameworkSourceSha,\n"));
  // canonical source SHA는 default branch exact SHA 고정 검사 뒤에서만 결정된다.
  assert.ok(freeze.indexOf("context.sha !== currentDefault.commit.sha") < freeze.indexOf("frameworkSourceSha = context.sha"));
});
