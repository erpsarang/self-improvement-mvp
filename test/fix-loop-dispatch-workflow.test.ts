import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const requestWorkflow = await readFile(".github/workflows/fix-request.yml", "utf8");
const implementWorkflow = await readFile(".github/workflows/implement.yml", "utf8");
const trustedRail = await readFile(".github/workflows/trusted-rail.yml", "utf8");

const dispatchSection = requestWorkflow.split("\n  dispatch_fix_cycle:\n")[1] ?? "";
const fixPrepareSection =
  (implementWorkflow.split("\n  fix_prepare:\n")[1] ?? "").split("\n  fix_worker:\n")[0] ?? "";
const fixWorkerSection =
  (implementWorkflow.split("\n  fix_worker:\n")[1] ?? "").split("\n  fix_record:\n")[0] ?? "";
const fixRecordSection = implementWorkflow.split("\n  fix_record:\n")[1] ?? "";
const sealSection = trustedRail.split("\n  publish:\n")[0] ?? "";

test("FIX loop edge는 GITHUB_TOKEN workflow_run 연쇄 대신 explicit workflow_dispatch를 사용한다", () => {
  assert.match(requestWorkflow, /\n  dispatch_fix_cycle:\n/);
  assert.match(dispatchSection, /createWorkflowDispatch/);
  assert.match(dispatchSection, /workflow_id: 'implement\.yml'/);
  assert.match(dispatchSection, /workflow_id: 'trusted-rail\.yml'/);
  assert.match(dispatchSection, /event: 'workflow_dispatch'/);
  assert.match(dispatchSection, /Untrusted FIX \$\{dispatchKey\}/);
  assert.match(dispatchSection, /Trusted Rail FIX \$\{workerRunId\}-attempt-\$\{workerRunAttempt\}/);
  assert.match(dispatchSection, /workerRun\.status !== 'completed'/);
  assert.match(dispatchSection, /workerRun\.conclusion !== 'success'/);
});

test("Untrusted IMPLEMENT의 implicit trigger는 AUTHORIZE만 남기고 FIX는 explicit input으로 받는다", () => {
  assert.match(implementWorkflow, /workflows: \["Trusted AUTHORIZE"\]/);
  assert.doesNotMatch(implementWorkflow, /workflows: \["Trusted AUTHORIZE", "Trusted FIX Request"\]/);
  assert.match(implementWorkflow, /workflow_dispatch:/);
  assert.match(implementWorkflow, /fix_request_run_id:/);
  assert.match(implementWorkflow, /fix_request_run_attempt:/);
  assert.match(implementWorkflow, /fix_request_artifact_name:/);
  assert.match(implementWorkflow, /fix_dispatch_key:/);
  assert.match(implementWorkflow, /github\.event_name == 'workflow_run'/);
  assert.match(implementWorkflow, /github\.event\.workflow_run\.event == 'issue_comment'/);
});

test("explicit FIX 입력은 trusted FIX Request run과 exact artifact에 다시 결합한다", () => {
  assert.match(fixPrepareSection, /github\.event_name == 'workflow_dispatch'/);
  assert.match(fixPrepareSection, /getWorkflowRun/);
  assert.match(fixPrepareSection, /run\.path !== '\.github\/workflows\/fix-request\.yml'/);
  assert.match(fixPrepareSection, /run\.event !== 'workflow_dispatch'/);
  assert.match(fixPrepareSection, /run\.run_attempt !== requestedAttempt/);
  assert.match(fixPrepareSection, /fix-request-\(\\\\d\+\)-fix-\(\[12\]\)-/);
  assert.match(fixPrepareSection, /expected exactly one FIX request artifact/);
  assert.match(fixPrepareSection, /FIX base HEAD mismatch/);
});

test("FIX Worker는 read-only/credential-empty이고 trusted record가 candidate provenance를 만든다", () => {
  assert.match(fixWorkerSection, /permissions:\n      contents: read\n      actions: read/);
  assert.match(fixWorkerSection, /GITHUB_TOKEN: ""/);
  assert.match(fixWorkerSection, /GH_TOKEN: ""/);
  assert.match(fixWorkerSection, /persist-credentials: false/);
  assert.doesNotMatch(fixWorkerSection, /contents: write|pull-requests: write|issues: write|git push|gh pr/);

  assert.match(fixRecordSection, /permissions:\n      contents: read\n      actions: read/);
  assert.match(fixRecordSection, /fix-handler\.ts finalize/);
  assert.match(
    fixRecordSection,
    /implement-candidate-\$\{\{ inputs\.fix_request_run_id \}\}-\$\{\{ github\.run_id \}\}-attempt-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.doesNotMatch(fixRecordSection, /contents: write|pull-requests: write|issues: write|git push|gh pr/);
});

test("dispatch 권한은 Trusted FIX Request의 별도 bridge job에만 격리한다", () => {
  assert.match(dispatchSection, /permissions:\n      actions: write/);
  assert.doesNotMatch(dispatchSection, /contents: write|pull-requests: write|issues: write/);
  assert.match(requestWorkflow, /request:[\s\S]*?permissions:\n      contents: read\n      actions: read/);
});

test("Trusted Rail은 explicit FIX source worker의 성공과 exact candidate를 다시 검증한다", () => {
  assert.match(trustedRail, /workflow_dispatch:/);
  assert.match(trustedRail, /source_worker_run_id:/);
  assert.match(trustedRail, /source_worker_run_attempt:/);
  assert.match(trustedRail, /source_candidate_artifact_name:/);
  assert.match(sealSection, /context\.eventName === 'workflow_dispatch'/);
  assert.match(sealSection, /run\.path !== '\.github\/workflows\/implement\.yml'/);
  assert.match(sealSection, /run\.event !== 'workflow_dispatch'/);
  assert.match(sealSection, /run\.status !== 'completed'/);
  assert.match(sealSection, /run\.conclusion !== 'success'/);
  assert.match(sealSection, /run\.run_attempt !== runAttempt/);
  assert.match(sealSection, /expected exactly one explicit FIX candidate artifact/);
  assert.match(sealSection, /SOURCE_RUN_ID: \$\{\{ steps\.candidate_artifact\.outputs\.source_run_id \}\}/);
});

test("source Trusted Rail race는 exact REVIEW가 있으면 in_progress 또는 completed success만 허용한다", () => {
  assert.match(requestWorkflow, /sourceRun\.status === 'in_progress' && sourceRun\.conclusion == null/);
  assert.match(requestWorkflow, /sourceRun\.status === 'completed' && sourceRun\.conclusion === 'success'/);
  assert.match(requestWorkflow, /sourceRun\.event === 'workflow_run' \|\| sourceRun\.event === 'workflow_dispatch'/);
  assert.match(requestWorkflow, /expected exactly one source REVIEW artifact/);
});
