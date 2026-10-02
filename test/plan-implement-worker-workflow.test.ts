import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workflow = readFileSync(".github/workflows/plan-implement-worker.yml", "utf8");

const exchange = readFileSync(".github/workflows/subscription-exchange.yml", "utf8");

type WorkerJob =
  | "prepare0" | "subscription0" | "attempt0" | "attempt0_result"
  | "subscription1" | "repair1" | "subscription2" | "repair2" | "finalize";

function jobBlock(name: WorkerJob): string {
  const markers = [
    "prepare0", "subscription0", "attempt0", "attempt0_result",
    "subscription1", "repair1", "subscription2", "repair2", "finalize",
  ] as const;
  const index = markers.indexOf(name);
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `${name} job not found`);
  const next = markers[index + 1];
  const end = next ? workflow.indexOf(`\n  ${next}:\n`, start + 1) : workflow.length;
  assert.ok(end > start, `${name} job boundary not found`);
  return workflow.slice(start, end);
}

test("production Worker는 Trusted Handoff 성공 run 또는 Trusted Recovery Preflight 성공 run만 입력으로 받는다", () => {
  assert.match(workflow, /workflows: \["Trusted PLAN IMPLEMENT Handoff", "Trusted Worker Recovery Preflight"\]/);
  assert.match(workflow, /types: \[completed\]/);
  assert.match(workflow, /workflow_run\.conclusion == 'success'/);
  assert.match(workflow, /workflow_run\.head_branch == github\.event\.repository\.default_branch/);
  // source event 검증은 job-level if에서 source별 exact 검증으로 이동했다: Handoff는 workflow_run, Preflight는 workflow_dispatch만.
  assert.match(
    workflow,
    /run\.name !== 'Trusted PLAN IMPLEMENT Handoff' \|\| run\.path !== '\.github\/workflows\/plan-implement-handoff\.yml' \|\| run\.event !== 'workflow_run'/,
  );
  assert.match(
    workflow,
    /run\.name === 'Trusted Worker Recovery Preflight' &&\s+run\.path === '\.github\/workflows\/plan-worker-recovery-preflight\.yml' &&\s+run\.event === 'workflow_dispatch'/,
  );
});

test("RECOVERY_READY는 exact provenance 검증 후 기존 승인 Handoff source로만 Worker에 재진입한다", () => {
  const attempt0 = jobBlock("prepare0");
  assert.match(attempt0, /name: RECOVERY_READY artifact 다운로드\n\s+if: github\.event\.workflow_run\.name == 'Trusted Worker Recovery Preflight'/);
  assert.match(attempt0, /name: RECOVERY_READY artifact 다운로드[\s\S]*?run-id: \$\{\{ github\.event\.workflow_run\.id \}\}/);
  assert.match(attempt0, /expected exactly one RECOVERY_READY payload/);
  assert.match(attempt0, /recovery\.kind === 'trusted-worker-recovery-ready'/);
  assert.match(attempt0, /recovery\.repository === `\$\{context\.repo\.owner\}\/\$\{context\.repo\.repo\}`/);
  assert.match(attempt0, /recovery\.currentDefaultSha === run\.head_sha/);
  assert.match(attempt0, /branch\.commit\.sha === run\.head_sha/);
  assert.match(attempt0, /recovery\.preflight\?\.workflowPath === '\.github\/workflows\/plan-worker-recovery-preflight\.yml'/);
  assert.match(attempt0, /recovery\.preflight\?\.runId === run\.id/);
  assert.match(attempt0, /recovery\.preflight\?\.runAttempt === run\.run_attempt/);
  assert.match(attempt0, /recovery\.preflight\?\.trustedCodeSha === run\.head_sha/);
  assert.match(attempt0, /\^sha256:\[0-9a-f\]\{64\}\$/);
  assert.match(attempt0, /invalid RECOVERY_READY provenance/);
  assert.match(attempt0, /recovery_kind', 'trusted-recovery-compare-v1'/);

  // 재진입 후에는 모든 validation이 event run이 아니라 원래 Handoff run을 source로 다시 받는다.
  assert.doesNotMatch(workflow, /SOURCE_RUN_ID: \$\{\{ github\.event\.workflow_run\.id \}\}/);
  assert.match(workflow, /run-id: \$\{\{ steps\.source\.outputs\.run_id \}\}/);
  assert.match(workflow, /run-id: \$\{\{ needs\.prepare0\.outputs\.source_run_id \}\}/);
  assert.match(workflow, /run-id: \$\{\{ needs\.attempt0_result\.outputs\.source_run_id \}\}/);
  assert.equal((workflow.match(/RECOVERY_GUARD_KIND: /g) ?? []).length, 5);

  // Worker 자신은 Public workflow를 dispatch하지 않는다. 예외는 Private implement-poller wake-up 1개뿐이다.
  assert.doesNotMatch(workflow, /createWorkflowDispatch|workflow_id: 'plan-implement-worker\.yml'/);
});

test("검증 job 권한은 read-only이고, Issue write는 checkout 없는 subscription 호출과 finalize에만 있다", () => {
  assert.match(workflow, /permissions: \{\}/);
  assert.ok((workflow.match(/contents: read/g) ?? []).length >= 4);
  assert.ok((workflow.match(/actions: read/g) ?? []).length >= 7);
  assert.doesNotMatch(workflow, /contents: write|actions: write|pull-requests: write/);
  assert.doesNotMatch(workflow, /git push|gh pr|createPullRequest|enable_auto_merge/i);

  // issues: write는 IMPLEMENT_REQUEST marker를 남기는 subscription 호출 3개와 STALLED marker를 남기는 finalize뿐이다.
  assert.equal((workflow.match(/issues: write/g) ?? []).length, 4);
  for (const name of ["prepare0", "attempt0", "attempt0_result", "repair1", "repair2"] as const) {
    assert.doesNotMatch(jobBlock(name), /issues: (?:write|read)/, name);
  }
  for (const name of ["subscription0", "subscription1", "subscription2"] as const) {
    const block = jobBlock(name);
    assert.match(block, /permissions:\n\s+actions: read\n\s+issues: write\n\s+uses: \.\/\.github\/workflows\/subscription-exchange\.yml\n/, name);
    assert.doesNotMatch(block, /steps:|runs-on:/, name);
  }
  const finalize = jobBlock("finalize");
  assert.match(finalize, /permissions:\n\s+actions: read\n\s+issues: write\n/);
  assert.doesNotMatch(finalize, /actions\/checkout@|openai\/codex-action@|npm |node --import/);

  // exchange workflow에서 write는 checkout도 대상 코드도 없는 request job 하나뿐이다.
  assert.match(exchange, /permissions: \{\}/);
  assert.equal((exchange.match(/issues: write/g) ?? []).length, 1);
  assert.match(exchange, /\n  request:\n\s+permissions:\n\s+actions: read\n\s+issues: write\n/);
  assert.match(exchange, /\n  wait:\n\s+needs: request\n\s+permissions:\n\s+actions: read\n\s+issues: read\n/);
  assert.doesNotMatch(exchange, /actions\/checkout@|npm |tsx |node -e|contents: /);
});

test("최초 IMPLEMENT와 두 repair 모두 Codex 없이 같은 subscription exchange를 한 번씩 쓴다", () => {
  for (const source of [workflow, exchange]) {
    assert.doesNotMatch(source, /openai\/codex-action|openai-api-key|FRAMEWORK_CODEX_API_KEY|APP_CODEX_API_KEY|model: gpt-/);
  }
  // Codex 4분 경계 전용 timeout retry와 neutral Codex 작업공간은 subscription 경로에서 제거되었다.
  assert.doesNotMatch(workflow, /\n  timeout_retry:\n|retry_required|IMPLEMENT timeout|bounded-worker-timeout-retry-input|worker-neutral|codex-home/);

  assert.equal((workflow.match(/uses: \.\/\.github\/workflows\/subscription-exchange\.yml/g) ?? []).length, 3);
  for (const [job, attempt] of [["subscription0", "0"], ["subscription1", "1"], ["subscription2", "2"]] as const) {
    assert.match(jobBlock(job), /kind: IMPLEMENT\n/, job);
    assert.ok(jobBlock(job).includes(`result_artifact_name: bounded-worker-raw-proposal-${attempt}-\${{ github.run_id }}-attempt-\${{ github.run_attempt }}\n      result_file_name: raw-proposal.json\n`), job);
    assert.match(jobBlock(job), /EXECUTOR_DISPATCH_TOKEN: \$\{\{ secrets\.EXECUTOR_DISPATCH_TOKEN \}\}/, job);
  }
  assert.match(jobBlock("subscription0"), /request_artifact_digest: \$\{\{ needs\.prepare0\.outputs\.request_artifact_digest \}\}/);
  assert.match(jobBlock("subscription1"), /request_artifact_digest: \$\{\{ needs\.attempt0_result\.outputs\.repair_request_artifact_digest \}\}/);
  assert.match(jobBlock("subscription2"), /request_artifact_digest: \$\{\{ needs\.repair1\.outputs\.repair_request_artifact_digest \}\}/);

  assert.match(workflow, /\n  prepare0:\n/);
  assert.match(workflow, /\n  subscription0:\n\s+needs: prepare0\n/);
  assert.match(workflow, /\n  attempt0:\n\s+needs: \[prepare0, subscription0\]\n\s+# [^\n]+\n\s+if: "!cancelled\(\) && needs\.prepare0\.outputs\.should_run == 'true'"\n/);
  assert.match(workflow, /\n  attempt0_result:\n\s+needs: attempt0\n/);
  assert.match(workflow, /\n  subscription1:\n\s+needs: attempt0_result\n/);
  assert.match(workflow, /\n  repair1:\n\s+needs: \[attempt0_result, subscription1\]\n/);
  assert.match(workflow, /\n  subscription2:\n\s+needs: \[attempt0_result, repair1\]\n/);
  assert.match(workflow, /\n  repair2:\n\s+needs: \[attempt0_result, repair1, subscription2\]\n/);
  assert.match(workflow, /\n  finalize:\n\s+needs: \[attempt0_result, repair1, repair2\]/);
});

test("subscription exchange는 Private implement-poller 하나만 exact request_id로 깨우고 dispatch token은 그 step에만 있다", () => {
  // Worker 자신은 어떤 workflow도 직접 dispatch하지 않는다.
  assert.doesNotMatch(workflow, /\/dispatches|createWorkflowDispatch|curl /);
  assert.equal((exchange.match(/\/dispatches/g) ?? []).length, 1);
  // executor는 repository 변수로 정한다. 팀마다 자기 구독 runner로 도는 executor를 쓴다.
  assert.ok(exchange.includes('"https://api.github.com/repos/${AI_EXECUTOR_REPOSITORY}/actions/workflows/${SUBSCRIPTION_POLLER}/dispatches"'));
  assert.match(exchange, /AI_EXECUTOR_REPOSITORY: \$\{\{ vars\.AI_EXECUTOR_REPOSITORY \}\}/);
  assert.match(exchange, /\[\[ ! "\$\{AI_EXECUTOR_REPOSITORY:-\}" =~ \^\[A-Za-z0-9_\.-\]\+\/\[A-Za-z0-9_\.-\]\+\$ \]\]/);
  assert.ok(exchange.indexOf("Missing or invalid AI_EXECUTOR_REPOSITORY") < exchange.indexOf("curl -fsS"));
  assert.doesNotMatch(exchange, /erpsarang\//);
  // dispatch 대상은 kind가 고른 다섯 Private poller로만 제한된다.
  assert.ok(exchange.includes("implement-poller.yml|review-poller.yml|fix-poller.yml|learn-poller.yml|product-evaluation-poller.yml) ;;"));
  assert.ok(exchange.includes("IMPLEMENT: { identityKind: 'trusted-implement-request', model: 'sonnet', run: 'worker', poller: 'implement-poller.yml' },"));
  assert.ok(exchange.includes("REVIEW: { identityKind: 'trusted-review-request', model: 'opus', run: 'rail', poller: 'review-poller.yml' },"));
  assert.ok(exchange.includes("FIX: { identityKind: 'trusted-fix-request', model: 'sonnet', run: 'worker', poller: 'fix-poller.yml' },"));
  assert.ok(exchange.includes("LEARN: { identityKind: 'trusted-learn-request', model: 'sonnet', run: 'worker', poller: 'learn-poller.yml' },"));
  // PRODUCT_EVALUATION은 사람이 실행하는 Product Discovery다 (Private product_evaluation_bridge의 discovery 계약).
  assert.equal(exchange.split("PRODUCT_EVALUATION: { identityKind: 'trusted-product-discovery-request', model: 'opus', run: 'worker', poller: 'product-evaluation-poller.yml' },").length - 1, 2);
  assert.doesNotMatch(exchange, /trusted-product-evaluation-request/);
  // Private poller는 이 repository에서만 request를 찾는다. 값은 Actions가 정한 github.repository다.
  assert.match(exchange, /-d "\{\\"ref\\":\\"main\\",\\"inputs\\":\{\\"request_id\\":\\"\$SUBSCRIPTION_REQUEST_ID\\",\\"repository\\":\\"\$SUBSCRIPTION_REPOSITORY\\"\}\}"/);
  assert.match(exchange, /SUBSCRIPTION_REPOSITORY: \$\{\{ github\.repository \}\}/);
  assert.match(exchange, /\[\[ ! "\$SUBSCRIPTION_REPOSITORY" =~ \^\[A-Za-z0-9_\.-\]\+\/\[A-Za-z0-9_\.-\]\+\$ \]\]/);
  assert.match(exchange, /\[\[ ! "\$SUBSCRIPTION_REQUEST_ID" =~ \^\[0-9a-f\]\{64\}\$ \]\]/);
  assert.deepEqual(exchange.match(/secrets\.[A-Za-z0-9_]+/g), ["secrets.EXECUTOR_DISPATCH_TOKEN"]);
  const dispatchStep = exchange.slice(exchange.indexOf("name: Private subscription executor 깨우기"), exchange.indexOf("\n  wait:\n"));
  assert.match(dispatchStep, /EXECUTOR_DISPATCH_TOKEN: \$\{\{ secrets\.EXECUTOR_DISPATCH_TOKEN \}\}/);
  assert.ok(exchange.indexOf("subscription request 고정 및 marker 기록") < exchange.indexOf("Private subscription executor 깨우기"));
  // Worker의 직접 secret 참조는 subscription 호출에 넘기는 wake-up token 3개뿐이다.
  assert.deepEqual(
    workflow.match(/secrets\.[A-Za-z0-9_]+/g),
    ["secrets.EXECUTOR_DISPATCH_TOKEN", "secrets.EXECUTOR_DISPATCH_TOKEN", "secrets.EXECUTOR_DISPATCH_TOKEN"],
  );
});

test("결과는 같은 run의 wait job이 polling으로 받고 raw-proposal artifact로 기존 trusted 검증에 넘긴다", () => {
  const prepare0 = jobBlock("prepare0");
  assert.match(prepare0, /name: IMPLEMENT_REQUEST artifact 저장\n[\s\S]*?path: \$\{\{ runner\.temp \}\}\/implement-request\n/);
  assert.match(prepare0, /request_artifact_digest: \$\{\{ steps\.request_upload\.outputs\.artifact-digest \}\}/);

  const wait = exchange.slice(exchange.indexOf("\n  wait:\n"));
  assert.match(wait, /for \(let poll = 0; poll < 90; poll \+= 1\)/);
  assert.match(wait, /setTimeout\(resolve, 10_000\)/);
  assert.ok(wait.includes("Timed out waiting for private subscription executor ${kind}_RESULT"));
  assert.match(wait, /subscriptionRequestId\(identity, artifactId, artifactDigest\) !== requestId/);
  assert.ok(wait.includes("name: ${{ inputs.result_artifact_name }}\n          path: ${{ runner.temp }}/subscription-output/${{ inputs.result_file_name }}"));
  assert.ok(wait.includes("if (!/^[a-z][a-z0-9-]*\\.json$/.test(resultFileName))"));

  for (const [job, attempt, directory] of [
    ["attempt0", "0", "worker-output"],
    ["repair1", "1", "worker-output-repair-1"],
    ["repair2", "2", "worker-output-repair-2"],
  ] as const) {
    const block = jobBlock(job);
    assert.ok(block.includes(`name: bounded-worker-raw-proposal-${attempt}-\${{ github.run_id }}-attempt-\${{ github.run_attempt }}\n          path: \${{ runner.temp }}/${directory}\n`), job);
    assert.ok(block.includes(`RAW_PROPOSAL_PATH: \${{ runner.temp }}/${directory}/raw-proposal.json`), job);
    // subscription 실패는 candidate 검증 전에 이 attempt job 실패로 모인다 (finalize의 기존 INFRA 경로).
    assert.ok(block.indexOf("subscription 단계 성공 확인") < block.indexOf("actions/checkout@"), job);
    assert.match(block, /SUBSCRIPTION_RESULT: \$\{\{ needs\.subscription[012]\.result \}\}/, job);
  }
});

test("repair 요청은 같은 Worker identity에 trusted repair prompt/schema만 바꾼 새 request artifact다", () => {
  for (const [job, ci, attempt, base] of [
    ["attempt0", "ci0", "1", "needs.prepare0.outputs.request_artifact_name"],
    ["repair1", "ci1", "2", "needs.attempt0_result.outputs.request_artifact_name"],
  ] as const) {
    const block = jobBlock(job);
    const condition = `if: steps.${ci}.outputs.status == 'FAIL' && steps.${ci}.outputs.repair_ready == 'true'`;
    assert.equal(block.split(condition).length - 1, 3, job);
    assert.ok(block.includes(`name: \${{ ${base} }}\n          path: \${{ runner.temp }}/implement-request-repair-${attempt}`), job);
    assert.ok(block.includes(`cp "$RUNNER_TEMP/repair-input-${attempt}/prompt.md" "$dir/prompt.md"`), job);
    assert.ok(block.includes(`cp "$RUNNER_TEMP/repair-input-${attempt}/schema.json" "$dir/schema.json"`), job);
    assert.ok(block.includes(`test "$(find "$dir" -mindepth 1 -maxdepth 1 -printf '%y:%f\\n' | sort | tr '\\n' ' ')" = "f:identity.json f:prompt.md f:schema.json "`), job);
    assert.ok(block.includes(`-repair-${attempt}" >> "$GITHUB_OUTPUT"`), job);
    assert.match(block, /repair_request_artifact_digest: \$\{\{ steps\.repair_request_upload\.outputs\.artifact-digest \}\}/, job);
  }
  // repair 입력은 state artifact가 아니라 request artifact로만 넘어간다.
  assert.doesNotMatch(workflow, /worker-state-[01]\/repair-input/);
});

test("out-of-scope 경계 실패는 AI repair를 시작하지 않고 fail-closed 한다", () => {
  assert.match(workflow, /repair_ready: \${\{ steps\.ci0\.outputs\.repair_ready \}\}/);
  assert.match(workflow, /repair_ready: \${\{ steps\.ci1\.outputs\.repair_ready \}\}/);
  assert.match(workflow, /needs\.attempt0_result\.outputs\.repair_ready == 'true'/);
  assert.match(workflow, /needs\.repair1\.outputs\.repair_ready == 'true'/);
  assert.match(workflow, /out-of-scope boundary repair 차단 시 fail-closed/);
  assert.match(workflow, /AI repair blocked by deterministic repair policy/);
});

test("repair와 그 subscription은 implicit skip되지 않고 FAIL + repair_ready일 때만 실행한다", () => {
  const repair1 = jobBlock("repair1");
  const repair2 = jobBlock("repair2");
  assert.match(
    repair1,
    /if: >-\n\s+!cancelled\(\) &&\n\s+needs\.attempt0_result\.outputs\.ci_status == 'FAIL' &&\n\s+needs\.attempt0_result\.outputs\.repair_ready == 'true'\n/,
  );
  assert.match(
    repair2,
    /if: >-\n\s+!cancelled\(\) &&\n\s+needs\.repair1\.outputs\.ci_status == 'FAIL' &&\n\s+needs\.repair1\.outputs\.repair_ready == 'true'\n/,
  );
  // subscription 호출도 같은 조건에서만 열리고, repair job은 subscription 실패를 fail-closed로 받기 위해 함께 열린다.
  assert.match(jobBlock("subscription1"), /if: "!cancelled\(\) && needs\.attempt0_result\.outputs\.ci_status == 'FAIL' && needs\.attempt0_result\.outputs\.repair_ready == 'true'"/);
  assert.match(jobBlock("subscription2"), /if: "!cancelled\(\) && needs\.repair1\.outputs\.ci_status == 'FAIL' && needs\.repair1\.outputs\.repair_ready == 'true'"/);
});

test("attempt 간 상태는 GitHub artifact로만 전달한다", () => {
  assert.match(workflow, /bounded-worker-state-0-\$\{\{ github\.run_id \}\}-attempt-\$\{\{ github\.run_attempt \}\}/);
  assert.match(workflow, /bounded-worker-state-1-\$\{\{ github\.run_id \}\}-attempt-\$\{\{ github\.run_attempt \}\}/);
  assert.match(workflow, /bounded-worker-state-2-\$\{\{ github\.run_id \}\}-attempt-\$\{\{ github\.run_attempt \}\}/);
  assert.match(workflow, /attempt 0 state artifact 저장/);
  assert.match(workflow, /attempt 0 state 다운로드/);
  assert.match(workflow, /attempt 1 state artifact 저장/);
  assert.match(workflow, /attempt 1 state 다운로드/);
  assert.match(workflow, /attempt 2 state artifact 저장/);
  // Worker 자신은 dispatch trigger를 갖지 않는다. 'workflow_dispatch'는 Preflight source event exact 검증에만 등장한다.
  const triggers = workflow.slice(0, workflow.indexOf("\npermissions: {}"));
  assert.doesNotMatch(triggers, /repository_dispatch|workflow_dispatch/);
  assert.equal((workflow.match(/repository_dispatch|workflow_dispatch/g) ?? []).length, 1);
  assert.match(workflow, /run\.event === 'workflow_dispatch'/);
});

test("candidate는 exact approved base에서 deterministic CI를 통과해야 최종 artifact가 된다", () => {
  assert.match(workflow, /exact approved base SHA 고정/);
  assert.equal((workflow.match(/ref: \$\{\{ needs\.prepare0\.outputs\.base_sha \}\}/g) ?? []).length, 1);
  assert.match(workflow, /base_sha: \$\{\{ steps\.base\.outputs\.sha \}\}/);
  assert.equal((workflow.match(/ref: \$\{\{ needs\.attempt0_result\.outputs\.base_sha \}\}/g) ?? []).length, 2);
  assert.match(workflow, /BASE_SHA: \$\{\{ needs\.attempt0\.outputs\.base_sha \}\}/);
  assert.equal((workflow.match(/plan-worker-ci-repair-handler\.ts check/g) ?? []).length, 3);
  assert.match(workflow, /candidate CI dependencies 설치 0/);
  assert.match(workflow, /candidate CI dependencies 설치 1/);
  assert.match(workflow, /candidate CI dependencies 설치 2/);
  assert.match(workflow, /PASS candidate 선택/);
  assert.match(workflow, /Validated candidate artifact 저장/);
});

test("repair candidate는 매번 fresh trusted validation과 exact-base CI를 다시 거친다", () => {
  assert.match(workflow, /Trusted validation checkout 1/);
  assert.match(workflow, /Trusted handoff artifact 재다운로드 1/);
  assert.match(workflow, /Trusted candidate 검증 1/);
  assert.match(workflow, /exact base candidate CI checkout 1/);
  assert.match(workflow, /Trusted validation checkout 2/);
  assert.match(workflow, /Trusted handoff artifact 재다운로드 2/);
  assert.match(workflow, /Trusted candidate 검증 2/);
  assert.match(workflow, /exact base candidate CI checkout 2/);
  assert.match(workflow, /NEXT_REPAIR_ATTEMPT: "1"/);
  assert.match(workflow, /NEXT_REPAIR_ATTEMPT: "2"/);
});

test("CI evidence는 최종 finalize Job에서 합치고 최대 두 repair 실패 시 fail-closed 한다", () => {
  assert.match(workflow, /bounded-worker-ci-evidence-\$\{\{ github\.run_id \}\}-attempt-\$\{\{ github\.run_attempt \}\}/);
  assert.match(workflow, /worker-ci-evidence\/\$\{name\}-\$\{attempt\}\.json/);
  assert.match(workflow, /deterministic CI or exact-base edit application failed after two bounded repairs/);
  assert.match(workflow, /upstream infrastructure failure 시 fail-closed/);
  assert.match(workflow, /final-candidate\/candidate\.json/);
  assert.match(workflow, /final-candidate\/candidate-provenance\.json/);
  assert.doesNotMatch(workflow, /Trusted Rail|trusted-rail\.yml|seal\.yml|publish\.yml/);
});

test("complete=false는 INFRA_FAILURE가 아니라 WORKER_INCOMPLETE로 fail-closed 한다", () => {
  const attempt0 = jobBlock("attempt0");
  const attempt0Result = jobBlock("attempt0_result");
  const finalize = jobBlock("finalize");

  assert.match(attempt0, /name: PLAN Worker complete 상태 분류 0/);
  assert.match(attempt0, /worker_incomplete: \$\{\{ steps\.completion0\.outputs\.incomplete \}\}/);
  assert.match(attempt0Result, /DIRECT_INCOMPLETE: \$\{\{ needs\.attempt0\.outputs\.worker_incomplete \}\}/);
  assert.match(attempt0Result, /worker_incomplete=true/);

  assert.match(finalize, /name: WORKER_INCOMPLETE stalled cycle 기록\n\s+if: needs\.attempt0_result\.outputs\.worker_incomplete == 'true'/);
  assert.match(finalize, /reason=WORKER_INCOMPLETE/);
  assert.match(finalize, /인프라 장애가 아니므로 자동 Recovery 대상으로 분류하지 않습니다/);
  assert.match(finalize, /name: WORKER_INCOMPLETE 시 fail-closed/);
  assert.ok(finalize.indexOf("WORKER_INCOMPLETE stalled cycle 기록") < finalize.indexOf("INFRA_FAILURE stalled cycle 기록"));
});

test("INFRA_FAILURE는 exact stalled marker로만 기록하고 Worker 스스로 Resume하지 않는다", () => {
  const finalize = jobBlock("finalize");
  assert.match(workflow, /source_run_id: \$\{\{ steps\.source\.outputs\.run_id \}\}/);
  assert.match(workflow, /source_run_attempt: \$\{\{ steps\.source\.outputs\.run_attempt \}\}/);
  assert.match(workflow, /source_run_id: \$\{\{ steps\.effective\.outputs\.source_run_id \}\}/);

  assert.match(finalize, /name: INFRA_FAILURE stalled cycle 기록\n\s+if: needs\.attempt0_result\.outputs\.infrastructure_failed == 'true'/);
  assert.match(finalize, /ai-dev-framework:STALLED_WORKER issue=\$\{issueNumber\} handoff-run=\$\{handoffRunId\} handoff-attempt=\$\{handoffRunAttempt\} artifact=\$\{artifact\} base-sha=\$\{baseSha\} worker-run=\$\{workerRunId\} worker-attempt=\$\{workerRunAttempt\} reason=INFRA_FAILURE/);
  // marker identity는 trusted job output에서만 오고 형식 검증 후에만 기록한다.
  assert.match(finalize, /\^plan-implement-handoff-issue-\(\\d\+\)-plan-\\d\+-attempt-\\d\+-approval-\\d\+\$/);
  assert.match(finalize, /invalid stalled cycle identity/);
  assert.match(finalize, /exact STALLED_WORKER marker already exists/);
  assert.match(finalize, /Trusted Recovery Preflight가 PASS하면 Worker가 자동 재진입합니다/);

  // marker 뒤에도 infrastructure failure는 fail-closed 한다.
  assert.ok(finalize.indexOf("INFRA_FAILURE stalled cycle 기록") < finalize.indexOf("upstream infrastructure failure 시 fail-closed"));
  assert.doesNotMatch(workflow, /createWorkflowDispatch|workflow_id: 'plan-implement-worker\.yml'/);
});

/** workflow의 bash step 본문을 그대로 꺼내 실행한다. 문자열 검사만으로 분기 동작을 확신하지 않는다. */
function runStep(block: string, stepName: string, env: Record<string, string>): { status: number | null; outputs: Record<string, string>; stdout: string } {
  const start = block.indexOf(`name: ${stepName}`);
  assert.ok(start >= 0, `missing step ${stepName}`);
  const runIndex = block.indexOf("run: |\n", start);
  const lines = block.slice(runIndex + "run: |\n".length).split("\n");
  const body: string[] = [];
  for (const line of lines) {
    if (line.trim() !== "" && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  const dir = mkdtempSync(join(tmpdir(), "worker-step-"));
  const outputFile = join(dir, "github-output");
  writeFileSync(outputFile, "");
  const result = spawnSync("bash", ["-c", body.join("\n")], {
    env: { ...process.env, ...env, GITHUB_OUTPUT: outputFile },
    encoding: "utf8",
  });
  const outputs = Object.fromEntries(
    readFileSync(outputFile, "utf8").split("\n").filter(Boolean).map((line) => line.split("=", 2) as [string, string]),
  );
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status, outputs, stdout: result.stdout };
}

test("subscription 결과를 받지 못한 attempt0 실패는 INFRA_FAILURE로, complete=false는 WORKER_INCOMPLETE로 분류한다", () => {
  const attempt0Result = jobBlock("attempt0_result");
  const classify = (attempt0: string, incomplete: string, status: string) =>
    runStep(attempt0Result, "attempt 0 effective 결과 고정", {
      SHOULD_RUN: "true",
      ATTEMPT0_RESULT: attempt0,
      DIRECT_STATUS: status,
      DIRECT_REPAIR_READY: status === "FAIL" ? "true" : "",
      DIRECT_BLOCKED_REASON: "",
      DIRECT_INCOMPLETE: incomplete,
      ...Object.fromEntries(
        ["SOURCE_NAME", "SOURCE_ID", "SOURCE_DIGEST", "SOURCE_RUN_ID", "SOURCE_RUN_ATTEMPT", "RECOVERY_GUARD_KIND", "RECOVERY_BASE_SHA", "RECOVERY_CURRENT_SHA", "BASE_SHA", "CANDIDATE_ARTIFACT_NAME"]
          .map((name) => [name, ""]),
      ),
    });

  // request/dispatch/timeout/identity mismatch는 모두 attempt0 job 실패로 모인다.
  const infra = classify("failure", "", "");
  assert.equal(infra.status, 0);
  assert.deepEqual([infra.outputs.infrastructure_failed, infra.outputs.worker_incomplete, infra.outputs.ci_status], ["true", "false", ""]);

  const incomplete = classify("failure", "true", "");
  assert.deepEqual([incomplete.outputs.infrastructure_failed, incomplete.outputs.worker_incomplete], ["false", "true"]);

  const passed = classify("success", "false", "PASS");
  assert.deepEqual([passed.outputs.infrastructure_failed, passed.outputs.worker_incomplete, passed.outputs.ci_status], ["false", "false", "PASS"]);

  const failed = classify("success", "false", "FAIL");
  assert.deepEqual([failed.outputs.ci_status, failed.outputs.repair_ready], ["FAIL", "true"]);
});

test("edit 적용 실패는 candidate 없이도 attempt state에 evidence로 남고 기존 repair 한도로 흐른다 (#332)", () => {
  // attempt0 / repair1 / repair2 모두 candidate가 없으면 edit-failure 기록만 evidence로 옮긴다.
  for (const [attempt, candidateDir, job] of [
    ["0", "validated-candidate-0", "attempt0"],
    ["1", "validated-candidate-1", "repair1"],
    ["2", "validated-candidate-2", "repair2"],
  ] as const) {
    const block = jobBlock(job);
    assert.ok(
      block.includes(`if [ -f "$RUNNER_TEMP/${candidateDir}/candidate.json" ]; then`),
      `${job} must guard candidate copy`,
    );
    assert.ok(
      block.includes(`cp "$RUNNER_TEMP/worker-ci-${attempt}/edit-failure.json" "$RUNNER_TEMP/worker-state-${attempt}/evidence/edit-failure-${attempt}.json"`),
      `${job} must keep the edit failure evidence`,
    );
  }
  // 새 실패 분류가 INFRA_FAILURE 판정 로직을 넓히지 않는다: infrastructure_failed는 attempt job 자체 실패에서만 켠다.
  const attempt0Result = jobBlock("attempt0_result");
  assert.match(attempt0Result, /elif \[ "\$ATTEMPT0_RESULT" != "success" \]; then\n\s+infrastructure_failed=true/);
  assert.doesNotMatch(attempt0Result, /edit-failure|EDIT_APPLICATION/);
});
