import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/plan-candidate-bridge.yml", import.meta.url), "utf8");
const bridgeSection = workflow.split("\n  dispatch_trusted_rail:\n")[0] ?? "";
const dispatchSection = workflow.split("\n  dispatch_trusted_rail:\n")[1] ?? "";

test("bridge는 자동 workflow_run과 명시적 bounded recovery만 받는다", () => {
  assert.match(workflow, /workflows: \["PLAN Bounded IMPLEMENT Worker"\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /source_worker_run_id:/);
  assert.match(workflow, /source_worker_run_attempt:/);
  assert.match(workflow, /source_candidate_artifact_name:/);
  assert.match(bridgeSection, /github\.event_name == 'workflow_dispatch'/);
});

test("자동 경로는 기존 성공 bounded Worker workflow_run 계약을 유지한다", () => {
  assert.match(workflow, /run\.path !== '\.github\/workflows\/plan-implement-worker\.yml'/);
  assert.match(workflow, /run\.event !== 'workflow_run'/);
  assert.match(workflow, /run\.conclusion !== 'success'/);
  assert.match(workflow, /bounded-worker-candidate-issue-/);
  assert.match(workflow, /expected exactly one bounded Worker candidate artifact/);
});

test("recovery는 source Worker run과 exact artifact를 fail-closed 재검증한다", () => {
  assert.match(bridgeSection, /context\.eventName === 'workflow_dispatch'/);
  assert.match(bridgeSection, /github\.rest\.actions\.getWorkflowRun/);
  assert.match(bridgeSection, /run\.name !== 'PLAN Bounded IMPLEMENT Worker'/);
  assert.match(bridgeSection, /run\.status !== 'completed'/);
  assert.match(bridgeSection, /run\.run_attempt !== runAttempt/);
  assert.match(bridgeSection, /unexpected recovery candidate artifact/);
  assert.match(bridgeSection, /matches\.length !== 1 \|\| exact\.length !== 1/);
});

test("recovery bridge는 새 trusted SHA를 쓰되 source Worker identity는 artifact와 함께 유지한다", () => {
  assert.match(
    bridgeSection,
    /core\.setOutput\('bridge_control_plane_sha', recovery \? context\.sha : run\.head_sha\)/,
  );
  assert.match(
    bridgeSection,
    /ref: \$\{\{ steps\.candidate_artifact\.outputs\.bridge_control_plane_sha \}\}/,
  );
  assert.match(
    bridgeSection,
    /SOURCE_WORKER_RUN_ID: \$\{\{ steps\.candidate_artifact\.outputs\.run_id \}\}/,
  );
  assert.match(
    bridgeSection,
    /SOURCE_WORKER_RUN_ATTEMPT: \$\{\{ steps\.candidate_artifact\.outputs\.run_attempt \}\}/,
  );
  assert.match(
    bridgeSection,
    /BRIDGE_TRUSTED_CODE_SHA: \$\{\{ steps\.candidate_artifact\.outputs\.bridge_control_plane_sha \}\}/,
  );
});

test("bridge job은 read-only이고 actions:write는 별도 Trusted Rail dispatch job에만 격리한다", () => {
  assert.match(workflow, /permissions: \{\}/);
  assert.match(bridgeSection, /permissions:\n      contents: read\n      actions: read\n      issues: read/);
  assert.doesNotMatch(bridgeSection, /contents: write/);
  assert.doesNotMatch(bridgeSection, /actions: write/);
  assert.doesNotMatch(bridgeSection, /pull-requests: write/);
  assert.doesNotMatch(bridgeSection, /createWorkflowDispatch|pulls\.create|pulls\.merge|git push/);

  assert.match(dispatchSection, /permissions:\n      actions: write/);
  assert.match(dispatchSection, /createWorkflowDispatch/);
  assert.match(dispatchSection, /source_candidate_kind: 'PLAN_BRIDGE'/);
  assert.doesNotMatch(dispatchSection, /contents: write|pull-requests: write|issues: write/);
  assert.doesNotMatch(dispatchSection, /pulls\.create|pulls\.merge|git push/);
});

test("exact base에서 deterministic CI 후 두 파일만 canonical artifact로 저장한다", () => {
  assert.match(workflow, /ref: \$\{\{ steps\.prepare\.outputs\.base_sha \}\}/);
  assert.match(workflow, /npm ci --ignore-scripts/);
  assert.match(workflow, /plan-candidate-bridge-handler\.ts validate/);
  assert.match(workflow, /plan-candidate-bridge-handler\.ts finalize/);
  assert.match(workflow, /plan-bridge-output\/candidate\.patch/);
  assert.match(workflow, /plan-bridge-output\/plan-bridge\.json/);
  assert.doesNotMatch(workflow, /implement\.json|sealed\.patch|seal\.json/);
});

test("validation target에는 GitHub 및 package registry token을 전달하지 않는다", () => {
  assert.match(workflow, /GH_TOKEN: ""\n          GITHUB_TOKEN: ""\n          NODE_AUTH_TOKEN: ""\n          NPM_TOKEN: ""/);
});
