import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/single-pass-smoke.yml", "utf8");

test("single-pass smoke는 수동 실행이며 repository write 권한이 없다", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permissions:\s*\n\s*contents: read/);
  assert.doesNotMatch(workflow, /contents: write|issues: write|pull-requests: write/);
  assert.doesNotMatch(workflow, /push:\s*\n|pull_request:\s*\n|issue_comment:/);
});

test("AI 직전에 checkout을 제거하고 neutral directory에서 한 번만 Codex를 호출한다", () => {
  const cleanup = workflow.indexOf("Remove repository checkouts before AI");
  const worker = workflow.indexOf("Untrusted single-pass Codex");
  const validationCheckout = workflow.indexOf("Framework checkout for trusted validation");
  assert.ok(cleanup >= 0 && worker > cleanup && validationCheckout > worker);
  assert.equal((workflow.match(/openai\/codex-action@v1/g) ?? []).length, 1);
  assert.match(workflow, /rm -rf .*control-prep.*target/);
  assert.match(workflow, /working-directory: \$\{\{ runner\.temp \}\}\/worker-neutral/);
  assert.match(workflow, /permission-profile: ":read-only"/);
  assert.match(workflow, /GH_TOKEN: ""/);
  assert.match(workflow, /GITHUB_TOKEN: ""/);
});

test("AI 실행 시간과 reasoning effort를 작게 고정하고 자동 재시도하지 않는다", () => {
  assert.match(workflow, /smoke:\s*\n\s*runs-on: ubuntu-latest\s*\n\s*timeout-minutes: 5/);
  assert.match(workflow, /Untrusted single-pass Codex\s*\n\s*timeout-minutes: 2/);
  assert.match(workflow, /effort: low/);
  assert.doesNotMatch(workflow, /retry|rerun|re-run/i);
});

test("AI raw output은 trusted validator를 거쳐야 candidate artifact가 된다", () => {
  const worker = workflow.indexOf("Untrusted single-pass Codex");
  const validate = workflow.indexOf("Trusted candidate validation");
  const upload = workflow.indexOf("Store validated smoke candidate");
  assert.ok(worker >= 0 && validate > worker && upload > validate);
  assert.match(workflow, /single-pass-smoke-handler\.ts validate/);
  assert.match(workflow, /candidate\.json/);
});
