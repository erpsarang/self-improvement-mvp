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
const workerSteps = workerJob.split("\n      - name: ").slice(1);

function workerStep(name: string): string {
  const matches = workerSteps.filter((step) => step.startsWith(`${name}\n`));
  assert.equal(matches.length, 1, `expected exactly one worker step: ${name}`);
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
  assert.match(workerPrepare, /FIX request\/review 재검증 및 prompt 생성/);
  assert.match(workerPrepare, /FIX base HEAD mismatch/);
  assert.match(workerPrepare, /sourceRun\.head_branch !== context\.payload\.repository\.default_branch/);
  assert.match(workerPrepare, /sourceRun\.head_sha !== context\.sha/);
  assert.match(workerPrepare, /REVIEWED_BRANCH: \$\{\{ steps\.prepare\.outputs\.reviewed_branch \}\}/);
  assert.match(workerPrepare, /REVIEWED_HEAD_SHA: \$\{\{ steps\.prepare\.outputs\.reviewed_head_sha \}\}/);
  assert.match(workerPrepare, /data\.object\.type !== 'commit' \|\| data\.object\.sha !== expected/);
});

test("untrusted FIX Worker에는 write credential과 push/Merge 경로가 없다", () => {
  assert.match(workerJob, /permissions:\n      contents: read\n      actions: read/);
  assert.match(workerJob, /GITHUB_TOKEN: ""/);
  assert.match(workerJob, /GH_TOKEN: ""/);
  assert.match(workerJob, /NODE_AUTH_TOKEN: ""/);
  assert.match(workerJob, /NPM_TOKEN: ""/);
  assert.match(workerJob, /persist-credentials: false/);
  assert.match(workerJob, /^        uses: openai\/codex-action@52fe01ec70a42f454c9d2ebd47598f9fd6893d56 # v1\.11; exact pin$/m);
  assert.match(workerJob, /permission-profile: ":workspace"/);
  assert.doesNotMatch(workerJob, /contents: write|actions: write|pull-requests: write|issues: write|git push|gh pr|mergePullRequest/);
  assert.match(workerJob, /openai-api-key: \$\{\{ secrets\[github\.repository == 'erpsarang\/self-improvement-mvp' && 'FRAMEWORK_CODEX_API_KEY' \|\| 'APP_CODEX_API_KEY'\] \}\}/);
  assert.doesNotMatch(workerJob, /github\.token|secrets\.[A-Za-z0-9_]+|github-token:|\btoken:/);
});

test("untrusted FIX Codex는 exact SHA만 사용하고 해당 단계에 4분 timeout을 둔다", () => {
  const codex = workerStep("Untrusted Codex FIX");
  const codexRefs = [...workerWorkflow.matchAll(/uses:\s*openai\/codex-action@([^\s#]+)/g)]
    .map((match) => match[1]);
  assert.deepEqual(codexRefs, ["52fe01ec70a42f454c9d2ebd47598f9fd6893d56"]);
  assert.doesNotMatch(workerWorkflow, /uses:\s*openai\/codex-action@(?![a-f0-9]{40}(?:\s|$))\S+/m);
  assert.match(codex, /^        id: codex$/m);
  assert.match(codex, /^        uses: openai\/codex-action@52fe01ec70a42f454c9d2ebd47598f9fd6893d56 # v1\.11; exact pin$/m);
  assert.deepEqual(codex.match(/^        timeout-minutes:.*$/gm), ["        timeout-minutes: 4"]);
  assert.match(codex, /^          permission-profile: ":workspace"$/m);
  assert.match(codex, /^          prompt-file: fix-prompt\.txt$/m);
});

test("FIX 실패·timeout·취소는 snapshot과 candidate 및 dispatch로 이어지지 않는다", () => {
  assert.doesNotMatch(workerWorkflow, /\bcontinue-on-error\s*:/);
  assert.doesNotMatch(workerWorkflow, /\b(?:always|failure|cancelled)\s*\(/);
  assert.match(workerJob, /^    needs: prepare$/m);
  assert.match(workerJob, /^    if: needs\.prepare\.result == 'success'$/m);
  assert.match(workerRecord, /^    needs: \[prepare, worker\]$/m);
  assert.match(workerRecord, /^    if: needs\.prepare\.result == 'success' && needs\.worker\.result == 'success'$/m);
  assert.match(railDispatch, /^    needs: record$/m);
  assert.match(railDispatch, /^    if: needs\.record\.result == 'success'$/m);

  // 단계별 if가 없으면 GitHub Actions의 기본 success() 조건이 적용된다.
  for (const job of [workerPrepare, workerJob, workerRecord, railDispatch]) {
    assert.doesNotMatch(job, /^        if:/m);
  }
  const codex = workerStep("Untrusted Codex FIX");
  const cleanup = workerStep("trusted prompt 제거");
  const archive = workerStep("mode 보존 FIX workspace tar 생성");
  const snapshot = workerStep("untrusted FIX workspace snapshot 저장");
  assert.deepEqual(workerSteps.slice(workerSteps.indexOf(codex) + 1), [cleanup, archive, snapshot]);
  assert.match(archive, /set -euo pipefail/);
  assert.match(archive, /-czf "\$\{RUNNER_TEMP\}\/fix-workspace\.tar\.gz" \./);
  assert.match(snapshot, /^        uses: actions\/upload-artifact@v4$/m);
  assert.match(snapshot, /name: fix-workspace-\$\{\{ github\.run_id \}\}-attempt-\$\{\{ github\.run_attempt \}\}/);
  assert.match(snapshot, /path: \$\{\{ runner\.temp \}\}\/fix-workspace\.tar\.gz/);
  assert.match(snapshot, /if-no-files-found: error/);
  assert.doesNotMatch(workerJob, /\|\|\s*true|set \+e|fix-handler\.ts finalize|candidate\.patch|implement\.json|createWorkflowDispatch/);
});

test("FIX Worker는 exact reviewed SHA와 trusted prompt를 유지한다", () => {
  const checkout = workerStep("exact reviewed SHA checkout");
  const baseCheck = workerStep("exact FIX base SHA 확인");
  const prompt = workerStep("trusted FIX prompt 다운로드");
  assert.match(checkout, /ref: \$\{\{ needs\.prepare\.outputs\.reviewed_head_sha \}\}/);
  assert.match(checkout, /persist-credentials: false/);
  assert.match(baseCheck, /EXPECTED_SHA: \$\{\{ needs\.prepare\.outputs\.reviewed_head_sha \}\}/);
  assert.ok(baseCheck.includes('test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"'));
  assert.match(prompt, /uses: actions\/download-artifact@v4/);
  assert.match(prompt, /name: fix-prompt-\$\{\{ github\.run_id \}\}-attempt-\$\{\{ github\.run_attempt \}\}/);
  assert.ok(workerStep("prompt를 worker workspace에 복사").includes('run: cp "${RUNNER_TEMP}/fix-prompt/fix-prompt.txt" fix-prompt.txt'));
  assert.ok(workerSteps.indexOf(checkout) < workerSteps.indexOf(baseCheck));
  assert.ok(workerSteps.indexOf(baseCheck) < workerSteps.indexOf(prompt));
  assert.ok(workerSteps.indexOf(prompt) < workerSteps.indexOf(workerStep("prompt를 worker workspace에 복사")));
  assert.ok(workerSteps.indexOf(workerStep("prompt를 worker workspace에 복사")) < workerSteps.indexOf(workerStep("Untrusted Codex FIX")));
});

test("untrusted FIX Codex는 github-actions[bot]만 exact allowlist하고 전체 bot 허용은 금지한다", () => {
  assert.match(workerJob, /allow-bot-users: "github-actions\[bot\]"/);
  assert.doesNotMatch(workerJob, /allow-bots:\s*true/);
});

test("FIX candidate provenance 기록은 fresh trusted runner의 read-only job에서 수행한다", () => {
  assert.match(workerRecord, /permissions:\n      contents: read\n      actions: read/);
  assert.doesNotMatch(workerRecord, /contents: write|actions: write|pull-requests: write|issues: write/);
  assert.match(workerRecord, /exact reviewed SHA fetch 및 FIX candidate patch 생성/);
  assert.match(workerRecord, /fix-handler\.ts finalize/);
  assert.match(workerRecord, /implement-candidate-/);
  assert.match(workerRecord, /candidate\.patch/);
  assert.match(workerRecord, /implement\.json/);
  assert.match(workerRecord, /^    runs-on: ubuntu-latest$/m);
  assert.match(workerRecord, /name: trusted control-plane exact SHA clean checkout\n        uses: actions\/checkout@v4\n        with:\n          ref: \$\{\{ needs\.prepare\.outputs\.source_control_plane_sha \}\}\n          fetch-depth: 0\n          persist-credentials: false/);
  assert.match(workerRecord, /CANDIDATE_DIR: \$\{\{ runner\.temp \}\}\/candidate-workspace/);
  assert.match(workerRecord, /BASE_SHA: \$\{\{ needs\.prepare\.outputs\.reviewed_head_sha \}\}/);
  assert.match(workerRecord, /^        run: npm exec -- tsx src\/self-improvement\/fix-handler\.ts finalize$/m);
  assert.doesNotMatch(workerRecord, /working-directory:|openai\/codex-action|git push|gh pr|mergePullRequest/);
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
