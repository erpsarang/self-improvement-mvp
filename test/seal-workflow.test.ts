import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/seal.yml", "utf8");

test("Trusted SEAL은 Untrusted IMPLEMENT 완료 후에만 시작한다", () => {
  assert.match(workflow, /workflows:\s*\["Untrusted IMPLEMENT"\]/);
  assert.match(workflow, /types:\s*\[completed\]/);
  assert.match(workflow, /run\.path !== '\.github\/workflows\/implement\.yml'/);
});

test("Trusted SEAL workflow는 read-only GitHub 권한만 가진다", () => {
  assert.match(workflow, /permissions:\s*\n\s+contents: read\s*\n\s+actions: read/);
  assert.doesNotMatch(workflow, /contents: write/);
  assert.doesNotMatch(workflow, /pull-requests: write/);
  assert.doesNotMatch(workflow, /issues: write/);
});

test("SEAL은 candidate를 실행하거나 publish하지 않는다", () => {
  assert.doesNotMatch(workflow, /openai\/codex-action/);
  assert.doesNotMatch(workflow, /git\s+(apply|commit|push)/);
  assert.doesNotMatch(workflow, /npm\s+test/);
  assert.doesNotMatch(workflow, /createPullRequest|pulls\.create/);
  assert.match(workflow, /seal-handler\.ts/);
});

test("candidate artifact는 정확한 source run에 결합되고 ambiguity를 fail-closed 한다", () => {
  assert.match(workflow, /implement-candidate-\(\\d\+\)-\$\{run\.id\}-attempt-\$\{run\.run_attempt\}/);
  assert.match(workflow, /matches\.length === 1/);
  assert.match(workflow, /valid no-op source run/);
  assert.match(workflow, /candidate artifact must contain exactly candidate\.patch and implement\.json/);
});

test("source exact SHA를 credential 없이 checkout하고 sealed artifact만 저장한다", () => {
  assert.match(workflow, /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /sealed\.patch/);
  assert.match(workflow, /seal\.json/);
});
