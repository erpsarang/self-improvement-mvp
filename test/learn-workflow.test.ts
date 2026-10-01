import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/learn.yml", "utf8");

test("LEARN workflow는 exact source run/artifact를 prepare와 finalize에서 재검증한다", () => {
  assert.match(workflow, /source_run_id:/);
  assert.match(workflow, /source_run_attempt:/);
  assert.match(workflow, /completed_cycle_artifact_name:/);
  assert.match(workflow, /learn_input_artifact_name:/);
  assert.match(workflow, /getWorkflowRun/);
  assert.match(workflow, /listWorkflowRunArtifacts/);
  assert.match(workflow, /source artifact identity changed between prepare and finalize/);
  assert.match(workflow, /learn-handler\.ts prepare/);
  assert.match(workflow, /learn-handler\.ts finalize/);
});

const prepare = (workflow.split("\n  prepare:\n")[1] ?? "").split("\n  exchange:\n")[0] ?? "";
const exchange = (workflow.split("\n  exchange:\n")[1] ?? "").split("\n  finalize:\n")[0] ?? "";
const finalize = (workflow.split("\n  finalize:\n")[1] ?? "").split("\n  dispatch_candidate:\n")[0] ?? "";

test("AI Learner는 Private subscription executor에 exact Input Pack만 담은 LEARN_REQUEST 1회로 실행된다", () => {
  assert.doesNotMatch(workflow, /openai\/codex-action|CODEX_API_KEY|permission-profile|learn-neutral/);
  assert.match(prepare, /LEARN_SOURCE_RUN_ID: \$\{\{ steps\.source\.outputs\.source_run_id \}\}/);
  assert.match(prepare, /request_artifact_id: \$\{\{ steps\.request_upload\.outputs\.artifact-id \}\}/);
  assert.match(prepare, /request_artifact_digest: \$\{\{ steps\.request_upload\.outputs\.artifact-digest \}\}/);
  assert.doesNotMatch(prepare, /issues: write|actions: write|secrets\./);
  assert.match(exchange, /^    needs: prepare$/m);
  assert.match(exchange, /^    if: needs\.prepare\.result == 'success'$/m);
  assert.match(exchange, /permissions:\n      actions: read\n      issues: write\n    uses: \.\/\.github\/workflows\/subscription-exchange\.yml/);
  assert.match(exchange, /^      kind: LEARN$/m);
  // 결과 artifact 이름과 파일은 기존 Learner output 그대로라 finalize의 evidence grounding 검증은 바뀌지 않는다.
  assert.match(exchange, /result_artifact_name: learner-output-issue-\$\{\{ needs\.prepare\.outputs\.issue_number \}\}-\$\{\{ github\.run_id \}\}-attempt-\$\{\{ github\.run_attempt \}\}/);
  assert.match(exchange, /result_file_name: learner\.json/);
  assert.deepEqual(workflow.match(/secrets\.[A-Za-z0-9_]+/g), ["secrets.EXECUTOR_DISPATCH_TOKEN"]);
  assert.match(finalize, /^    needs: \[prepare, exchange\]$/m);
  assert.match(finalize, /^    if: needs\.prepare\.result == 'success' && needs\.exchange\.result == 'success'$/m);
  assert.match(finalize, /name: learner-output-issue-\$\{\{ needs\.prepare\.outputs\.issue_number \}\}-\$\{\{ github\.run_id \}\}-attempt-\$\{\{ github\.run_attempt \}\}/);
  assert.doesNotMatch(workflow, /permissions:\s*\n\s*(?:pull-requests|workflows|checks|statuses):\s*write/);
});

test("LEARN workflow는 trusted finalize 뒤 Candidate만 dispatch하고 authority를 확장하지 않는다", () => {
  assert.match(workflow, /untrusted Learner output 다운로드/);
  assert.match(workflow, /evidence grounding 검증 및 LEARN report finalize/);
  assert.match(workflow, /validated untrusted LEARN report 저장/);
  assert.match(workflow, /\n  dispatch_candidate:\n/);
  assert.match(workflow, /workflow_id: 'improvement-candidate\.yml'/);
  assert.doesNotMatch(workflow, /workflow_id: 'plan\.yml'|workflow_id: 'implement\.yml'/);
  assert.doesNotMatch(workflow, /issues\.create/);
  assert.doesNotMatch(workflow, /pulls\.create/);
  assert.doesNotMatch(workflow, /mergePullRequest|pulls\.merge|enablePullRequestAutoMerge/);
});
