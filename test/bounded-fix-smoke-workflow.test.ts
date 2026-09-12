import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/bounded-fix-smoke.yml", "utf8");

test("bounded FIX smoke는 실패 후 AI FIX를 정확히 1회만 호출한다", () => {
  assert.match(workflow, /name: Bounded FIX Smoke/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /timeout-minutes: 7/);

  const codexCalls = workflow.match(/uses: openai\/codex-action@v1/g) ?? [];
  assert.equal(codexCalls.length, 1);
  assert.match(workflow, /name: Untrusted bounded FIX Codex[\s\S]*?timeout-minutes: 2/);
  assert.match(workflow, /permission-profile: ":read-only"/);
  assert.match(workflow, /effort: low/);
  assert.match(workflow, /GH_TOKEN: ""/);
  assert.match(workflow, /GITHUB_TOKEN: ""/);
});

test("AI FIX 전에는 repository checkout을 제거하고 재검증은 fresh exact SHA에서 한다", () => {
  assert.match(workflow, /Remove repository checkouts before AI FIX/);
  assert.match(workflow, /rm -rf "\$GITHUB_WORKSPACE\/control-prep" "\$GITHUB_WORKSPACE\/target-fail"/);
  assert.match(workflow, /working-directory: \$\{\{ runner\.temp \}\}\/fix-worker-neutral/);
  assert.match(workflow, /name: Fresh target checkout at exact SHA[\s\S]*?ref: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /Validate FIX candidate and deterministic CI PASS/);
});

test("smoke evidence만 artifact로 남기고 repository write 권한은 요청하지 않는다", () => {
  assert.doesNotMatch(workflow, /contents: write/);
  assert.doesNotMatch(workflow, /issues: write/);
  assert.doesNotMatch(workflow, /pull-requests: write/);
  assert.match(workflow, /validation-fail\.json/);
  assert.match(workflow, /validation-pass\.json/);
  assert.match(workflow, /fixed-candidate\.json/);
});
