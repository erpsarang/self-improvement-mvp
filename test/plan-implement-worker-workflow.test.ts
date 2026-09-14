import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/plan-implement-worker.yml", "utf8");

const KNOWN_GOOD_CODEX_ACTION =
  "openai/codex-action@52fe01ec70a42f454c9d2ebd47598f9fd6893d56";

function jobBlock(name: "attempt0" | "repair1" | "repair2" | "finalize"): string {
  const markers = ["attempt0", "repair1", "repair2", "finalize"] as const;
  const index = markers.indexOf(name);
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `${name} job not found`);
  const next = markers[index + 1];
  const end = next ? workflow.indexOf(`\n  ${next}:\n`, start + 1) : workflow.length;
  assert.ok(end > start, `${name} job boundary not found`);
  return workflow.slice(start, end);
}

test("production Worker는 Trusted PLAN IMPLEMENT Handoff 성공 run만 입력으로 받는다", () => {
  assert.match(workflow, /workflows: \["Trusted PLAN IMPLEMENT Handoff"\]/);
  assert.match(workflow, /types: \[completed\]/);
  assert.match(workflow, /workflow_run\.conclusion == 'success'/);
  assert.match(workflow, /workflow_run\.event == 'workflow_run'/);
  assert.match(workflow, /run\.name !== 'Trusted PLAN IMPLEMENT Handoff'/);
  assert.match(workflow, /run\.path !== '\.github\/workflows\/plan-implement-handoff\.yml'/);
});

test("모든 job 권한은 read-only이고 repository/PR/Issue write 권한을 갖지 않는다", () => {
  assert.match(workflow, /permissions: \{\}/);
  assert.ok((workflow.match(/contents: read/g) ?? []).length >= 3);
  assert.ok((workflow.match(/actions: read/g) ?? []).length >= 4);
  assert.doesNotMatch(workflow, /contents: write|actions: write|issues: write|pull-requests: write/);
  assert.doesNotMatch(workflow, /git push|gh pr|createPullRequest|enable_auto_merge/i);
});

test("initial Worker와 두 repair는 각각 fresh Job에서 Codex를 정확히 한 번만 실행한다", () => {
  const attempt0 = jobBlock("attempt0");
  const repair1 = jobBlock("repair1");
  const repair2 = jobBlock("repair2");
  const finalize = jobBlock("finalize");

  assert.equal(attempt0.split(KNOWN_GOOD_CODEX_ACTION).length - 1, 1);
  assert.equal(repair1.split(KNOWN_GOOD_CODEX_ACTION).length - 1, 1);
  assert.equal(repair2.split(KNOWN_GOOD_CODEX_ACTION).length - 1, 1);
  assert.equal(finalize.split(KNOWN_GOOD_CODEX_ACTION).length - 1, 0);
  assert.equal(workflow.split(KNOWN_GOOD_CODEX_ACTION).length - 1, 3);

  assert.match(workflow, /\n  attempt0:\n/);
  assert.match(workflow, /\n  repair1:\n\s+needs: attempt0/);
  assert.match(workflow, /\n  repair2:\n\s+needs: \[attempt0, repair1\]/);
  assert.match(workflow, /\n  finalize:\n\s+needs: \[attempt0, repair1, repair2\]/);
  assert.match(workflow, /needs\.attempt0\.outputs\.ci_status == 'FAIL'/);
  assert.match(workflow, /needs\.repair1\.outputs\.ci_status == 'FAIL'/);
  assert.doesNotMatch(workflow, /openai\/codex-action@v1(?:\s|$)/);
});

test("각 untrusted Job은 repository 없이 neutral input만 보고 drop-sudo read-only로 실행한다", () => {
  assert.match(workflow, /Worker 실행 전 repository와 trusted source 제거/);
  assert.match(workflow, /repair 1 untrusted input 격리/);
  assert.match(workflow, /repair 2 untrusted input 격리/);
  assert.match(workflow, /worker-neutral-repair-1/);
  assert.match(workflow, /worker-neutral-repair-2/);
  assert.equal((workflow.match(/permission-profile: ":read-only"/g) ?? []).length, 3);
  assert.equal((workflow.match(/safety-strategy: drop-sudo/g) ?? []).length, 3);
  assert.ok((workflow.match(/GH_TOKEN: ""/g) ?? []).length >= 3);
  assert.ok((workflow.match(/GITHUB_TOKEN: ""/g) ?? []).length >= 3);
  assert.ok((workflow.match(/test -z "\$\(find "\$GITHUB_WORKSPACE"/g) ?? []).length >= 3);
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
  assert.doesNotMatch(workflow, /repository_dispatch|workflow_dispatch/);
});

test("candidate는 exact approved base에서 deterministic CI를 통과해야 최종 artifact가 된다", () => {
  assert.match(workflow, /exact approved base SHA 고정/);
  assert.match(workflow, /ref: \$\{\{ steps\.base\.outputs\.sha \}\}/);
  assert.ok((workflow.match(/ref: \$\{\{ needs\.attempt0\.outputs\.base_sha \}\}/g) ?? []).length >= 2);
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
  assert.match(workflow, /worker-ci-evidence\/validation-\$\{attempt\}\.json/);
  assert.match(workflow, /deterministic CI failed after two bounded repairs/);
  assert.match(workflow, /upstream infrastructure failure 시 fail-closed/);
  assert.match(workflow, /final-candidate\/candidate\.json/);
  assert.match(workflow, /final-candidate\/candidate-provenance\.json/);
  assert.doesNotMatch(workflow, /Trusted Rail|trusted-rail\.yml|seal\.yml|publish\.yml/);
});
