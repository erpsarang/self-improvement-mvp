import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/plan-candidate-bridge.yml", import.meta.url), "utf8");

test("bridge는 성공한 bounded Worker workflow_run만 받는다", () => {
  assert.match(workflow, /workflows: \["PLAN Bounded IMPLEMENT Worker"\]/);
  assert.match(workflow, /run\.path !== '\.github\/workflows\/plan-implement-worker\.yml'/);
  assert.match(workflow, /run\.event !== 'workflow_run'/);
  assert.match(workflow, /run\.conclusion !== 'success'/);
  assert.match(workflow, /bounded-worker-candidate-issue-/);
  assert.match(workflow, /expected exactly one bounded Worker candidate artifact/);
});

test("bridge job 권한은 read-only이고 publish\/dispatch\/merge 권한을 갖지 않는다", () => {
  assert.match(workflow, /permissions: \{\}/);
  assert.match(workflow, /permissions:\n      contents: read\n      actions: read\n      issues: read/);
  assert.doesNotMatch(workflow, /contents: write/);
  assert.doesNotMatch(workflow, /actions: write/);
  assert.doesNotMatch(workflow, /pull-requests: write/);
  assert.doesNotMatch(workflow, /createWorkflowDispatch|pulls\.create|pulls\.merge|git push/);
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
