import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/plan-implement-worker.yml", "utf8");

const KNOWN_GOOD_CODEX_ACTION =
  "openai/codex-action@52fe01ec70a42f454c9d2ebd47598f9fd6893d56";

test("production Worker는 Trusted PLAN IMPLEMENT Handoff 성공 run만 입력으로 받는다", () => {
  assert.match(workflow, /workflows: \["Trusted PLAN IMPLEMENT Handoff"\]/);
  assert.match(workflow, /types: \[completed\]/);
  assert.match(workflow, /workflow_run\.conclusion == 'success'/);
  assert.match(workflow, /workflow_run\.event == 'workflow_run'/);
  assert.match(workflow, /run\.name !== 'Trusted PLAN IMPLEMENT Handoff'/);
  assert.match(workflow, /run\.path !== '\.github\/workflows\/plan-implement-handoff\.yml'/);
});

test("job 권한은 read-only이고 repository/PR/Issue write 권한을 갖지 않는다", () => {
  assert.match(workflow, /permissions: \{\}/);
  assert.match(workflow, /permissions:\s*\n\s*contents: read\s*\n\s*actions: read/);
  assert.doesNotMatch(workflow, /contents: write|actions: write|issues: write|pull-requests: write/);
  assert.doesNotMatch(workflow, /git push|gh pr|createPullRequest|enable_auto_merge/i);
});

test("initial Worker와 최대 두 번의 repair는 known-good Codex exact pin만 사용한다", () => {
  assert.equal(workflow.split(KNOWN_GOOD_CODEX_ACTION).length - 1, 3);
  assert.doesNotMatch(workflow, /openai\/codex-action@v1(?:\s|$)/);
  assert.match(workflow, /Untrusted bounded IMPLEMENT Worker/);
  assert.match(workflow, /Untrusted bounded IMPLEMENT repair 1/);
  assert.match(workflow, /Untrusted bounded IMPLEMENT repair 2/);
  assert.match(workflow, /NEXT_REPAIR_ATTEMPT: "1"/);
  assert.match(workflow, /NEXT_REPAIR_ATTEMPT: "2"/);
  assert.match(workflow, /deterministic CI failed after two bounded repairs/);
});

test("각 untrusted Worker 실행 전 repository와 trusted source를 제거하고 read-only neutral directory를 사용한다", () => {
  assert.match(workflow, /Worker 실행 전 repository와 trusted source 제거/);
  assert.match(workflow, /repair 1 전 repository와 trusted source 제거/);
  assert.match(workflow, /repair 2 전 repository와 trusted source 제거/);
  assert.match(workflow, /worker-neutral-repair-1/);
  assert.match(workflow, /worker-neutral-repair-2/);
  assert.match(workflow, /permission-profile: ":read-only"/);
  assert.match(workflow, /GH_TOKEN: ""/);
  assert.match(workflow, /GITHUB_TOKEN: ""/);
  assert.match(workflow, /safety-strategy: drop-sudo/);
});

test("candidate는 exact approved base에서 deterministic CI를 통과해야 artifact가 된다", () => {
  const firstValidate = workflow.indexOf("Trusted candidate 검증 0");
  const firstCi = workflow.indexOf("deterministic CI 및 repair 입력 준비 0");
  const upload = workflow.indexOf("Validated candidate artifact 저장");
  assert.ok(firstValidate >= 0 && firstCi > firstValidate && upload > firstCi);
  assert.match(workflow, /exact approved base SHA 고정/);
  assert.match(workflow, /ref: \$\{\{ steps\.base\.outputs\.sha \}\}/);
  assert.match(workflow, /plan-worker-ci-repair-handler\.ts check/);
  assert.match(workflow, /candidate CI dependencies 설치 0/);
  assert.match(workflow, /candidate CI dependencies 설치 1/);
  assert.match(workflow, /candidate CI dependencies 설치 2/);
});

test("repair candidate도 매번 fresh trusted validation과 exact-base CI를 다시 거친다", () => {
  assert.match(workflow, /Trusted validation checkout 1/);
  assert.match(workflow, /Trusted handoff artifact 재다운로드 1/);
  assert.match(workflow, /Trusted candidate 검증 1/);
  assert.match(workflow, /exact base candidate CI checkout 1/);
  assert.match(workflow, /Trusted validation checkout 2/);
  assert.match(workflow, /Trusted handoff artifact 재다운로드 2/);
  assert.match(workflow, /Trusted candidate 검증 2/);
  assert.match(workflow, /exact base candidate CI checkout 2/);
});

test("CI evidence는 candidate와 별도 artifact로 남고 PASS candidate만 기존 두 파일 artifact로 저장한다", () => {
  assert.match(workflow, /bounded-worker-ci-evidence-\$\{\{ github\.run_id \}\}-attempt-\$\{\{ github\.run_attempt \}\}/);
  assert.match(workflow, /worker-ci-evidence\/\*\.json/);
  assert.match(workflow, /final-candidate\/candidate\.json/);
  assert.match(workflow, /final-candidate\/candidate-provenance\.json/);
  assert.doesNotMatch(workflow, /Trusted Rail|trusted-rail\.yml|seal\.yml|publish\.yml/);
});
