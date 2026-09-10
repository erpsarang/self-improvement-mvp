import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const requestWorkflow = await readFile(".github/workflows/fix-request.yml", "utf8");
const workerWorkflow = await readFile(".github/workflows/fix-worker.yml", "utf8");
const trustedRail = await readFile(".github/workflows/trusted-rail.yml", "utf8");

const requestJob = requestWorkflow.split("\n  dispatch_worker:\n")[0] ?? "";
const requestDispatch = requestWorkflow.split("\n  dispatch_worker:\n")[1] ?? "";
const workerPrepare = (workerWorkflow.split("\n  prepare:\n")[1] ?? "").split("\n  worker:\n")[0] ?? "";
const workerJob = (workerWorkflow.split("\n  worker:\n")[1] ?? "").split("\n  record:\n")[0] ?? "";
const workerRecord = (workerWorkflow.split("\n  record:\n")[1] ?? "").split("\n  dispatch_trusted_rail:\n")[0] ?? "";
const railDispatch = workerWorkflow.split("\n  dispatch_trusted_rail:\n")[1] ?? "";
const railSeal = trustedRail.split("\n  publish:\n")[0] ?? "";

test("Trusted FIX Request는 workflow_run 연쇄 대신 FIX Worker를 explicit workflow_dispatch 한다", () => {
  assert.match(requestWorkflow, /workflow_dispatch:/);
  assert.match(requestDispatch, /permissions:\n      actions: write/);
  assert.doesNotMatch(requestDispatch, /contents: write|pull-requests: write|issues: write/);
  assert.match(requestDispatch, /createWorkflowDispatch/);
  assert.match(requestDispatch, /workflow_id: 'fix-worker\.yml'/);
  assert.match(requestDispatch, /source_fix_request_run_id/);
  assert.match(requestDispatch, /source_fix_request_run_attempt/);
  assert.match(requestDispatch, /source_fix_request_artifact_name/);
});

test("FIX Request trusted job은 source Trusted Rail completion과 exact REVIEW artifact를 기다려 검증한다", () => {
  assert.match(requestJob, /permissions:\n      contents: read\n      actions: read/);
  assert.doesNotMatch(requestJob, /contents: write|pull-requests: write|issues: write/);
  assert.match(requestJob, /sourceRun\.status === 'completed'/);
  assert.match(requestJob, /sourceRun\.conclusion !== 'success'/);
  assert.match(requestJob, /sourceRun\.path !== '\.github\/workflows\/trusted-rail\.yml'/);
  assert.match(requestJob, /sourceRun\?\.event === 'workflow_run' \|\| sourceRun\?\.event === 'workflow_dispatch'/);
  assert.match(requestJob, /expected exactly one source REVIEW artifact/);
});

test("전용 FIX Worker는 explicit dispatch 입력만 받고 global 권한은 비어 있다", () => {
  assert.match(workerWorkflow, /name: Untrusted FIX Worker/);
  assert.match(workerWorkflow, /workflow_dispatch:/);
  assert.match(workerWorkflow, /source_fix_request_run_id:/);
  assert.match(workerWorkflow, /source_fix_request_run_attempt:/);
  assert.match(workerWorkflow, /source_fix_request_artifact_name:/);
  assert.match(workerWorkflow, /permissions: \{\}/);
  assert.doesNotMatch(workerWorkflow, /workflow_run:/);
});

test("FIX prepare는 source request가 completed success인지 확인하고 exact artifact만 사용한다", () => {
  assert.match(workerPrepare, /sourceRun\.status === 'completed'/);
  assert.match(workerPrepare, /sourceRun\.conclusion !== 'success'/);
  assert.match(workerPrepare, /sourceRun\.path !== '\.github\/workflows\/fix-request\.yml'/);
  assert.match(workerPrepare, /sourceRun\.event !== 'workflow_dispatch'/);
  assert.match(workerPrepare, /sourceRun\.run_attempt !== runAttempt/);
  assert.match(workerPrepare, /expected exactly one FIX request artifact/);
  assert.match(workerPrepare, /FIX request\/review 재검증 및 prompt 생성/);
  assert.match(workerPrepare, /FIX base HEAD mismatch/);
});

test("untrusted FIX Worker에는 write credential과 push/Merge 경로가 없다", () => {
  assert.match(workerJob, /permissions:\n      contents: read\n      actions: read/);
  assert.match(workerJob, /GITHUB_TOKEN: ""/);
  assert.match(workerJob, /GH_TOKEN: ""/);
  assert.match(workerJob, /persist-credentials: false/);
  assert.match(workerJob, /uses: openai\/codex-action@v1/);
  assert.match(workerJob, /permission-profile: ":workspace"/);
  assert.doesNotMatch(workerJob, /contents: write|pull-requests: write|issues: write|git push|gh pr|mergePullRequest/);
});

test("FIX candidate provenance 기록은 fresh trusted runner의 read-only job에서 수행한다", () => {
  assert.match(workerRecord, /permissions:\n      contents: read\n      actions: read/);
  assert.doesNotMatch(workerRecord, /contents: write|pull-requests: write|issues: write/);
  assert.match(workerRecord, /exact reviewed SHA fetch 및 FIX candidate patch 생성/);
  assert.match(workerRecord, /fix-handler\.ts finalize/);
  assert.match(workerRecord, /implement-candidate-/);
  assert.match(workerRecord, /candidate\.patch/);
  assert.match(workerRecord, /implement\.json/);
});

test("candidate 기록 성공 뒤 actions:write 전용 job만 Trusted Rail을 explicit dispatch 한다", () => {
  assert.match(railDispatch, /needs: record/);
  assert.match(railDispatch, /permissions:\n      actions: write/);
  assert.doesNotMatch(railDispatch, /contents: write|pull-requests: write|issues: write/);
  assert.match(railDispatch, /createWorkflowDispatch/);
  assert.match(railDispatch, /workflow_id: 'trusted-rail\.yml'/);
  assert.match(railDispatch, /source_candidate_run_id/);
  assert.match(railDispatch, /source_candidate_run_attempt/);
  assert.match(railDispatch, /source_candidate_artifact_name/);
});

test("Trusted Rail explicit entry는 FIX Worker completion과 exact candidate identity를 fail-closed 검증한다", () => {
  assert.match(trustedRail, /workflow_dispatch:/);
  assert.match(railSeal, /context\.eventName === 'workflow_dispatch'/);
  assert.match(railSeal, /run\.status !== 'completed'/);
  assert.match(railSeal, /run\.conclusion !== 'success'/);
  assert.match(railSeal, /run\.path !== '\.github\/workflows\/fix-worker\.yml'/);
  assert.match(railSeal, /run\.event !== 'workflow_dispatch'/);
  assert.match(railSeal, /expected exactly one explicit FIX candidate artifact/);
  assert.match(railSeal, /SOURCE_RUN_ID: \$\{\{ steps\.candidate_artifact\.outputs\.source_run_id \}\}/);
});
