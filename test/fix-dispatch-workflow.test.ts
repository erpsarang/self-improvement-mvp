import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const requestWorkflow = await readFile(".github/workflows/fix-request.yml", "utf8");
const workerWorkflow = await readFile(".github/workflows/fix-worker.yml", "utf8");
const trustedRail = await readFile(".github/workflows/trusted-rail.yml", "utf8");

const requestJob = requestWorkflow.split("\n  dispatch_worker:\n")[0] ?? "";
const requestDispatch = requestWorkflow.split("\n  dispatch_worker:\n")[1] ?? "";
const workerPrepare = (workerWorkflow.split("\n  prepare:\n")[1] ?? "").split("\n  exchange:\n")[0] ?? "";
const workerExchange = (workerWorkflow.split("\n  exchange:\n")[1] ?? "").split("\n  record:\n")[0] ?? "";
const workerRecord = (workerWorkflow.split("\n  record:\n")[1] ?? "").split("\n  dispatch_trusted_rail:\n")[0] ?? "";
const railDispatch = workerWorkflow.split("\n  dispatch_trusted_rail:\n")[1] ?? "";
const railSeal = trustedRail.split("\n  publish:\n")[0] ?? "";

function jobStep(job: string, name: string): string {
  const matches = job.split("\n      - name: ").slice(1).filter((step) => step.startsWith(`${name}\n`));
  assert.equal(matches.length, 1, `expected exactly one step: ${name}`);
  return matches[0] ?? "";
}

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

test("FIX Worker dispatch는 GitHub Actions의 명시적 run id/attempt를 exact identity로 사용한다", () => {
  assert.match(requestDispatch, /CURRENT_RUN_ID: \$\{\{ github\.run_id \}\}/);
  assert.match(requestDispatch, /CURRENT_RUN_ATTEMPT: \$\{\{ github\.run_attempt \}\}/);
  assert.match(requestDispatch, /const currentRunId = Number\(process\.env\.CURRENT_RUN_ID\)/);
  assert.match(requestDispatch, /const currentRunAttempt = Number\(process\.env\.CURRENT_RUN_ATTEMPT\)/);
  assert.match(requestDispatch, /source_fix_request_run_id: String\(currentRunId\)/);
  assert.match(requestDispatch, /source_fix_request_run_attempt: String\(currentRunAttempt\)/);
  assert.doesNotMatch(requestDispatch, /context\.runAttempt/);
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
  assert.match(workerWorkflow, /^permissions: \{\}$/m);
  assert.doesNotMatch(workerWorkflow, /workflow_run:/);
});

test("FIX prepare는 source request가 completed success인지 확인하고 exact artifact만 사용한다", () => {
  assert.match(workerPrepare, /sourceRun\.status === 'completed'/);
  assert.match(workerPrepare, /sourceRun\.conclusion !== 'success'/);
  assert.match(workerPrepare, /sourceRun\.path !== '\.github\/workflows\/fix-request\.yml'/);
  assert.match(workerPrepare, /sourceRun\.event !== 'workflow_dispatch'/);
  assert.match(workerPrepare, /sourceRun\.run_attempt !== runAttempt/);
  assert.match(workerPrepare, /expected exactly one FIX request artifact/);
  assert.match(workerPrepare, /FIX request\/review 재검증/);
  assert.match(workerPrepare, /FIX base HEAD mismatch/);
  assert.match(workerPrepare, /sourceRun\.head_branch !== context\.payload\.repository\.default_branch/);
  assert.match(workerPrepare, /sourceRun\.head_sha !== context\.sha/);
  assert.match(workerPrepare, /REVIEWED_BRANCH: \$\{\{ steps\.prepare\.outputs\.reviewed_branch \}\}/);
  assert.match(workerPrepare, /REVIEWED_HEAD_SHA: \$\{\{ steps\.prepare\.outputs\.reviewed_head_sha \}\}/);
  assert.match(workerPrepare, /data\.object\.type !== 'commit' \|\| data\.object\.sha !== expected/);
});

test("bounded FIX_REQUEST는 HEAD 확인 뒤 exact reviewed SHA를 읽기만 해서 trusted job에서 만든다", () => {
  assert.match(workerPrepare, /permissions:\n      contents: read\n      actions: read/);
  assert.doesNotMatch(workerPrepare, /contents: write|actions: write|pull-requests: write|issues: write/);
  const head = jobStep(workerPrepare, "FIX 시작 직전 remote publish HEAD exact match 확인");
  const checkout = jobStep(workerPrepare, "exact reviewed SHA 읽기 전용 checkout");
  const baseCheck = jobStep(workerPrepare, "exact FIX base SHA 확인");
  const request = jobStep(workerPrepare, "bounded FIX_REQUEST 입력 생성");
  const upload = jobStep(workerPrepare, "FIX_REQUEST artifact 저장");
  assert.match(checkout, /ref: \$\{\{ steps\.prepare\.outputs\.reviewed_head_sha \}\}/);
  assert.match(checkout, /path: fix-target/);
  assert.match(checkout, /persist-credentials: false/);
  assert.ok(baseCheck.includes('test "$(git -C fix-target rev-parse HEAD)" = "$EXPECTED_SHA"'));
  assert.match(request, /fix-handler\.ts subscription-request/);
  assert.match(request, /FIX_TARGET_DIRECTORY: \$\{\{ github\.workspace \}\}\/fix-target/);
  assert.match(upload, /uses: actions\/upload-artifact@v4/);
  assert.match(upload, /if-no-files-found: error/);
  // reviewed 코드는 설치·실행하지 않는다. npm ci는 trusted control plane checkout에서만 돈다.
  assert.doesNotMatch(workerPrepare, /working-directory:/);
  const order = [head, checkout, baseCheck, request, upload].map((step) => workerPrepare.indexOf(step));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(workerPrepare, /subscription_request_artifact_id: \$\{\{ steps\.subscription_request_upload\.outputs\.artifact-id \}\}/);
  assert.match(workerPrepare, /subscription_request_artifact_digest: \$\{\{ steps\.subscription_request_upload\.outputs\.artifact-digest \}\}/);
});

test("FIX Worker는 Codex 대신 subscription exchange로 FIX_REQUEST 1회만 보낸다", () => {
  assert.doesNotMatch(workerWorkflow, /openai\/codex-action|CODEX_API_KEY|permission-profile|fix-prompt|fix-workspace/);
  assert.match(workerExchange, /^    needs: prepare$/m);
  assert.match(workerExchange, /^    if: needs\.prepare\.result == 'success'$/m);
  assert.match(workerExchange, /permissions:\n      actions: read\n      issues: write\n    uses: \.\/\.github\/workflows\/subscription-exchange\.yml/);
  assert.match(workerExchange, /^      kind: FIX$/m);
  assert.match(workerExchange, /request_artifact_id: \$\{\{ needs\.prepare\.outputs\.subscription_request_artifact_id \}\}/);
  assert.match(workerExchange, /request_artifact_digest: \$\{\{ needs\.prepare\.outputs\.subscription_request_artifact_digest \}\}/);
  assert.match(workerExchange, /result_artifact_name: fix-raw-proposal-\$\{\{ github\.run_id \}\}-attempt-\$\{\{ github\.run_attempt \}\}/);
  assert.match(workerExchange, /EXECUTOR_DISPATCH_TOKEN: \$\{\{ secrets\.EXECUTOR_DISPATCH_TOKEN \}\}/);
  assert.equal((workerWorkflow.match(/secrets\./g) ?? []).length, 1);
  assert.equal((workerWorkflow.match(/uses: \.\/\.github\/workflows\/subscription-exchange\.yml/g) ?? []).length, 1);
});

test("FIX 실패·timeout·취소는 candidate 및 dispatch로 이어지지 않는다", () => {
  assert.doesNotMatch(workerWorkflow, /\bcontinue-on-error\s*:/);
  assert.doesNotMatch(workerWorkflow, /\b(?:always|failure|cancelled)\s*\(/);
  assert.match(workerRecord, /^    needs: \[prepare, exchange\]$/m);
  assert.match(workerRecord, /^    if: needs\.prepare\.result == 'success' && needs\.exchange\.result == 'success'$/m);
  assert.match(railDispatch, /^    needs: record$/m);
  assert.match(railDispatch, /^    if: needs\.record\.result == 'success'$/m);

  // 단계별 if가 없으면 GitHub Actions의 기본 success() 조건이 적용된다.
  for (const job of [workerPrepare, workerRecord, railDispatch]) {
    assert.doesNotMatch(job, /^        if:/m);
  }
});

test("FIX candidate provenance 기록은 fresh trusted runner의 read-only job에서 수행한다", () => {
  assert.match(workerRecord, /permissions:\n      contents: read\n      actions: read/);
  assert.doesNotMatch(workerRecord, /contents: write|actions: write|pull-requests: write|issues: write/);
  assert.match(workerRecord, /fix-handler\.ts finalize/);
  assert.match(workerRecord, /implement-candidate-/);
  assert.match(workerRecord, /candidate\.patch/);
  assert.match(workerRecord, /implement\.json/);
  assert.match(workerRecord, /^    runs-on: ubuntu-latest$/m);
  assert.match(workerRecord, /name: trusted control-plane exact SHA clean checkout\n        uses: actions\/checkout@v4\n        with:\n          ref: \$\{\{ needs\.prepare\.outputs\.source_control_plane_sha \}\}\n          fetch-depth: 0\n          persist-credentials: false/);
  assert.match(workerRecord, /BASE_SHA: \$\{\{ needs\.prepare\.outputs\.reviewed_head_sha \}\}/);
  assert.match(workerRecord, /^        run: npm exec -- tsx src\/self-improvement\/fix-handler\.ts finalize$/m);
  assert.match(workerRecord, /AI_RESULT_ID: claude-max-subscription-fix:\$\{\{ github\.run_id \}\}:\$\{\{ github\.run_attempt \}\}/);
  assert.doesNotMatch(workerRecord, /working-directory:|openai\/codex-action|rsync|git push|gh pr|mergePullRequest/);
});

test("FIX Worker edit은 clean trusted code가 exact reviewed SHA worktree에 적용한 뒤에만 patch가 된다", () => {
  const raw = jobStep(workerRecord, "subscription FIX raw proposal 다운로드");
  const worktree = jobStep(workerRecord, "exact reviewed SHA worktree 생성");
  const apply = jobStep(workerRecord, "clean trusted code로 Worker edit 검증 및 적용");
  const patch = jobStep(workerRecord, "FIX candidate patch 생성");
  assert.match(raw, /name: fix-raw-proposal-\$\{\{ github\.run_id \}\}-attempt-\$\{\{ github\.run_attempt \}\}/);
  assert.ok(worktree.includes('git worktree add --detach "${RUNNER_TEMP}/fix-patch-worktree" "$BASE_SHA"'));
  assert.ok(worktree.includes('test "$(git -C "${RUNNER_TEMP}/fix-patch-worktree" rev-parse HEAD)" = "$BASE_SHA"'));
  assert.match(apply, /^        run: npm exec -- tsx src\/self-improvement\/fix-handler\.ts apply$/m);
  assert.match(apply, /FIX_RAW_PROPOSAL_JSON: \$\{\{ runner\.temp \}\}\/fix-raw-proposal\/raw-proposal\.json/);
  assert.match(apply, /FIX_WORKTREE_DIRECTORY: \$\{\{ runner\.temp \}\}\/fix-patch-worktree/);
  assert.match(patch, /FIX candidate\.patch is empty/);
  const order = [raw, worktree, apply, patch].map((step) => workerRecord.indexOf(step));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test("FIX candidate는 artifact 저장과 Rail dispatch 전에 exact worktree에서 전체 npm test를 통과해야 한다", () => {
  const patchStep = "FIX candidate patch 생성";
  const validationStep = "trusted FIX candidate deterministic validation";
  const finalizeStep = "clean trusted code로 FIX provenance 생성";
  assert.match(workerRecord, new RegExp(`- name: ${validationStep}\\n        shell: bash`));
  assert.ok(workerRecord.includes('cd "${RUNNER_TEMP}/fix-patch-worktree"'));
  assert.match(workerRecord, /npm ci\n          npm test/);
  assert.match(workerRecord, /GITHUB_TOKEN: ""/);
  assert.match(workerRecord, /GH_TOKEN: ""/);
  assert.match(workerRecord, /NODE_AUTH_TOKEN: ""/);
  assert.match(workerRecord, /NPM_TOKEN: ""/);
  assert.doesNotMatch(workerRecord, /continue-on-error:/);
  const patchIndex = workerRecord.indexOf(`- name: ${patchStep}`);
  const validationIndex = workerRecord.indexOf(`- name: ${validationStep}`);
  const finalizeIndex = workerRecord.indexOf(`- name: ${finalizeStep}`);
  const artifactIndex = workerRecord.indexOf("- name: generic candidate artifact 저장");
  assert.ok(patchIndex >= 0 && patchIndex < validationIndex);
  assert.ok(validationIndex < finalizeIndex);
  assert.ok(finalizeIndex < artifactIndex);
});

test("candidate 기록 성공 뒤 actions:write 전용 job만 Trusted Rail을 explicit dispatch 한다", () => {
  assert.match(railDispatch, /needs: record/);
  assert.match(railDispatch, /^    if: needs\.record\.result == 'success'$/m);
  assert.match(railDispatch, /permissions:\n      actions: write/);
  assert.doesNotMatch(railDispatch, /contents: write|pull-requests: write|issues: write/);
  assert.match(railDispatch, /createWorkflowDispatch/);
  assert.match(railDispatch, /workflow_id: 'trusted-rail\.yml'/);
  assert.match(railDispatch, /source_candidate_run_id/);
  assert.match(railDispatch, /source_candidate_run_attempt/);
  assert.match(railDispatch, /source_candidate_artifact_name/);
  assert.match(railDispatch, /CANDIDATE_ARTIFACT: \$\{\{ needs\.record\.outputs\.candidate_artifact_name \}\}/);
  assert.match(railDispatch, /ref: context\.payload\.repository\.default_branch/);
  assert.doesNotMatch(workerWorkflow, /git push|gh pr merge|mergePullRequest|enablePullRequestAutoMerge/);
});

test("Trusted Rail dispatch도 명시적 FIX Worker run id/attempt를 exact identity로 사용한다", () => {
  assert.match(railDispatch, /CURRENT_RUN_ID: \$\{\{ github\.run_id \}\}/);
  assert.match(railDispatch, /CURRENT_RUN_ATTEMPT: \$\{\{ github\.run_attempt \}\}/);
  assert.match(railDispatch, /const currentRunId = Number\(process\.env\.CURRENT_RUN_ID\)/);
  assert.match(railDispatch, /const currentRunAttempt = Number\(process\.env\.CURRENT_RUN_ATTEMPT\)/);
  assert.match(railDispatch, /source_candidate_run_id: String\(currentRunId\)/);
  assert.match(railDispatch, /source_candidate_run_attempt: String\(currentRunAttempt\)/);
  assert.doesNotMatch(railDispatch, /context\.runAttempt/);
});

test("Trusted Rail explicit entry는 FIX Worker completion과 exact candidate identity를 fail-closed 검증한다", () => {
  assert.match(trustedRail, /workflow_dispatch:/);
  assert.match(railSeal, /context\.eventName === 'workflow_dispatch'/);
  assert.match(railSeal, /run\.status !== 'completed'/);
  assert.match(railSeal, /run\.conclusion !== 'success'/);
  assert.match(railSeal, /const expectedPath = sourceKind === 'PLAN_BRIDGE'/);
  assert.match(railSeal, /: '\.github\/workflows\/fix-worker\.yml';/);
  assert.match(railSeal, /run\.path !== expectedPath/);
  assert.match(railSeal, /const expectedEvents = sourceKind === 'PLAN_BRIDGE'/);
  assert.match(railSeal, /: new Set\(\['workflow_dispatch'\]\);/);
  assert.match(railSeal, /!expectedEvents\.has\(run\.event\)/);
  assert.match(railSeal, /expected exactly one explicit \$\{sourceKind\} candidate artifact/);
  assert.match(railSeal, /SOURCE_RUN_ID: \$\{\{ steps\.candidate_artifact\.outputs\.source_run_id \}\}/);
});
