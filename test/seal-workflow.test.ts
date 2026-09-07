import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/trusted-rail.yml", "utf8");

test("Trusted Rail은 Untrusted IMPLEMENT 완료 후 한 번만 진입한다", () => {
  assert.match(workflow, /name: Trusted Rail/);
  assert.match(workflow, /workflows:\s*\["Untrusted IMPLEMENT"\]/);
  assert.match(workflow, /types:\s*\[completed\]/);
  assert.match(workflow, /run\.path !== '\.github\/workflows\/implement\.yml'/);
});

test("Trusted Rail 전체 권한은 비어 있고 현재 SEAL job만 read-only 권한을 가진다", () => {
  assert.match(workflow, /permissions:\s*\{\}/);
  assert.match(
    workflow,
    /seal:[\s\S]*?permissions:\s*\n\s+contents: read\s*\n\s+actions: read/,
  );
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
  assert.equal(
    workflow.includes(
      "const pattern = new RegExp(`^implement-candidate-(\\\\d+)-${run.id}-attempt-${run.run_attempt}$`);",
    ),
    true,
  );
  assert.match(workflow, /matches\.length === 1/);
  assert.match(workflow, /valid no-op source run/);
  assert.match(workflow, /candidate artifact must contain exactly candidate\.patch and implement\.json/);
});

test("candidate base와 IMPLEMENT/SEAL control-plane SHA를 서로 다른 값으로 취급한다", () => {
  assert.match(workflow, /name: trusted control-plane exact SHA checkout/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(
    workflow,
    /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/,
  );
  assert.match(workflow, /persist-credentials: false/);
  assert.match(
    workflow,
    /SOURCE_CONTROL_PLANE_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/,
  );
  assert.doesNotMatch(workflow, /SOURCE_HEAD_SHA:/);
  assert.match(workflow, /SEAL_TRUSTED_CODE_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /sealed\.patch/);
  assert.match(workflow, /seal\.json/);
});

test("후속 단계는 별도 workflow_run 체인이 아니라 Trusted Rail 내부 job으로 확장한다", () => {
  assert.match(workflow, /후속 PUBLISH \/ VERIFY \/ REVIEW/);
  assert.match(workflow, /Trusted Rail 내부의 독립 job/);
});
