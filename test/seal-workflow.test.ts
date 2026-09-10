import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/trusted-rail.yml", "utf8");
const semanticReviewWorkflow = readFileSync(".github/workflows/semantic-review.yml", "utf8");
const sealSection = workflow.split("\n  publish:\n")[0] ?? "";

test("Trusted Rail은 초기 IMPLEMENT workflow_run과 explicit FIX workflow_dispatch를 구분해 진입한다", () => {
  assert.match(workflow, /name: Trusted Rail/);
  assert.match(workflow, /workflows:\s*\["Untrusted IMPLEMENT"\]/);
  assert.match(workflow, /types:\s*\[completed\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /source_worker_run_id:/);
  assert.match(workflow, /source_worker_run_attempt:/);
  assert.match(workflow, /source_candidate_artifact_name:/);
  assert.match(sealSection, /context\.eventName === 'workflow_dispatch'/);
  assert.match(sealSection, /run\.path !== '\.github\/workflows\/implement\.yml'/);
  assert.match(sealSection, /run\.event !== 'workflow_dispatch'/);
  assert.match(sealSection, /run\.status !== 'completed'/);
  assert.match(sealSection, /run\.conclusion !== 'success'/);
});

test("Trusted Rail 전체 권한은 비어 있고 SEAL job은 read-only 권한을 가진다", () => {
  assert.match(workflow, /permissions:\s*\{\}/);
  assert.match(
    sealSection,
    /seal:[\s\S]*?permissions:\s*\n\s+contents: read\s*\n\s+actions: read/,
  );
  assert.doesNotMatch(sealSection, /contents: write/);
  assert.doesNotMatch(sealSection, /pull-requests: write/);
  assert.doesNotMatch(sealSection, /issues: write/);
});

test("SEAL은 candidate를 실행하거나 publish하지 않는다", () => {
  assert.doesNotMatch(sealSection, /openai\/codex-action/);
  assert.doesNotMatch(sealSection, /git\s+(apply|commit|push)/);
  assert.doesNotMatch(sealSection, /npm\s+test/);
  assert.doesNotMatch(sealSection, /createPullRequest|pulls\.create/);
  assert.match(sealSection, /seal-handler\.ts/);
});

test("candidate artifact는 정확한 source run에 결합되고 ambiguity를 fail-closed 한다", () => {
  assert.equal(
    sealSection.includes(
      "const pattern = new RegExp(`^implement-candidate-(\\\\d+)-${run.id}-attempt-${run.run_attempt}$`);",
    ),
    true,
  );
  assert.match(sealSection, /explicit candidate artifact does not bind worker run/);
  assert.match(sealSection, /expected exactly one explicit FIX candidate artifact/);
  assert.match(sealSection, /matches\.length === 1/);
  assert.match(sealSection, /valid no-op source run/);
  assert.match(sealSection, /candidate artifact must contain exactly candidate\.patch and implement\.json/);
});

test("candidate base와 source/SEAL control-plane SHA를 서로 다른 값으로 취급한다", () => {
  assert.match(sealSection, /name: trusted control-plane exact SHA checkout/);
  assert.match(sealSection, /ref: \$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(
    sealSection,
    /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/,
  );
  assert.match(sealSection, /persist-credentials: false/);
  assert.match(
    sealSection,
    /SOURCE_CONTROL_PLANE_SHA: \$\{\{ steps\.candidate_artifact\.outputs\.source_head_sha \}\}/,
  );
  assert.match(sealSection, /source_head_sha/);
  assert.doesNotMatch(sealSection, /SOURCE_HEAD_SHA:/);
  assert.match(sealSection, /SEAL_TRUSTED_CODE_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(sealSection, /sealed\.patch/);
  assert.match(sealSection, /seal\.json/);
});

test("후속 단계는 추가 workflow_run 체인 없이 Trusted Rail에서 동기 확장한다", () => {
  assert.match(workflow, /\n  publish:\n/);
  assert.match(workflow, /\n  verify_prepare:\n/);
  assert.match(workflow, /\n  verify_candidate:\n/);
  assert.match(workflow, /\n  verify_finalize:\n/);
  assert.match(workflow, /\n  review:\n/);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/semantic-review\.yml/);
  assert.match(semanticReviewWorkflow, /workflow_call:/);
  assert.doesNotMatch(semanticReviewWorkflow, /workflow_run:/);
});
