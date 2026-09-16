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

test("AI Learner는 neutral workspace의 exact Input Pack만 보고 read-only로 실행된다", () => {
  assert.match(workflow, /name: isolated read-only AI Learner/);
  assert.match(workflow, /permission-profile: ":read-only"/);
  assert.match(workflow, /safety-strategy: drop-sudo/);
  assert.match(workflow, /working-directory: \$\{\{ runner\.temp \}\}\/learn-neutral/);
  assert.match(workflow, /prompt-file: \$\{\{ runner\.temp \}\}\/learn-request\/learn-prompt\.md/);
  assert.match(workflow, /output-schema-file: \$\{\{ runner\.temp \}\}\/learn-request\/learn-output\.schema\.json/);
  assert.match(workflow, /GITHUB_TOKEN: ""/);
  assert.match(workflow, /GH_TOKEN: ""/);
  assert.doesNotMatch(workflow, /permissions:\s*\n\s*(?:issues|pull-requests|workflows|checks|statuses):\s*write/);
});

test("LEARN workflow는 AI output을 바로 authority로 쓰지 않고 trusted finalize 후 artifact만 저장한다", () => {
  assert.match(workflow, /untrusted Learner output 저장/);
  assert.match(workflow, /evidence grounding 검증 및 LEARN report finalize/);
  assert.match(workflow, /validated untrusted LEARN report 저장/);
  assert.doesNotMatch(workflow, /issues\.create/);
  assert.doesNotMatch(workflow, /pulls\.create/);
  assert.doesNotMatch(workflow, /createWorkflowDispatch/);
  assert.doesNotMatch(workflow, /mergePullRequest/);
});
