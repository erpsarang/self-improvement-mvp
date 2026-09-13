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

test("Worker 직전에 checkout/source를 제거하고 neutral directory에서 Codex를 정확히 한 번 호출한다", () => {
  const prepare = workflow.indexOf("Trusted Worker input 검증 및 준비");
  const cleanup = workflow.indexOf("Worker 실행 전 repository와 trusted source 제거");
  const worker = workflow.indexOf("Untrusted bounded IMPLEMENT Worker");
  const validationCheckout = workflow.indexOf("Trusted validation checkout");
  assert.ok(prepare >= 0 && cleanup > prepare && worker > cleanup && validationCheckout > worker);
  assert.equal(workflow.split(KNOWN_GOOD_CODEX_ACTION).length - 1, 1);
  assert.doesNotMatch(workflow, /openai\/codex-action@v1(?:\s|$)/);
  assert.match(workflow, /rm -rf .*control-prep.*plan-worker-source/);
  assert.match(workflow, /working-directory: \$\{\{ runner\.temp \}\}\/worker-neutral/);
  assert.match(workflow, /permission-profile: ":read-only"/);
  assert.match(workflow, /GH_TOKEN: ""/);
  assert.match(workflow, /GITHUB_TOKEN: ""/);
  assert.match(workflow, /timeout-minutes: 4/);
  assert.match(workflow, /effort: low/);
});

test("Worker에는 validated prompt/schema만 주고 source artifact는 AI 이후 다시 다운로드한다", () => {
  const firstDownload = workflow.indexOf("Trusted handoff artifact 다운로드");
  const cleanup = workflow.indexOf("Worker 실행 전 repository와 trusted source 제거");
  const worker = workflow.indexOf("Untrusted bounded IMPLEMENT Worker");
  const secondDownload = workflow.indexOf("Trusted handoff artifact 재다운로드");
  const validate = workflow.indexOf("Trusted candidate 검증");
  assert.ok(firstDownload >= 0 && cleanup > firstDownload && worker > cleanup && secondDownload > worker && validate > secondDownload);
  assert.match(workflow, /prompt-file: \$\{\{ runner\.temp \}\}\/plan-worker-input\/prompt\.md/);
  assert.match(workflow, /output-schema-file: \$\{\{ runner\.temp \}\}\/plan-worker-input\/schema\.json/);
  assert.match(workflow, /output-file: \$\{\{ runner\.temp \}\}\/worker-output\/raw-proposal\.json/);
});

test("raw Worker output은 trusted validator를 통과한 candidate/provenance만 artifact로 저장한다", () => {
  const worker = workflow.indexOf("Untrusted bounded IMPLEMENT Worker");
  const validate = workflow.indexOf("Trusted candidate 검증");
  const upload = workflow.indexOf("Validated candidate artifact 저장");
  assert.ok(worker >= 0 && validate > worker && upload > validate);
  assert.match(workflow, /plan-implement-worker-handler\.ts validate/);
  assert.match(workflow, /candidate\.json/);
  assert.match(workflow, /candidate-provenance\.json/);
  assert.doesNotMatch(workflow, /Trusted Rail|trusted-rail\.yml|seal\.yml|publish\.yml/);
});
