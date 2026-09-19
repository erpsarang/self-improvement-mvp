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
