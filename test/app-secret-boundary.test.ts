import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const selector = "${{ secrets[github.repository == 'erpsarang/self-improvement-mvp' && 'FRAMEWORK_CODEX_API_KEY' || 'APP_CODEX_API_KEY'] }}";

const directAiWorkflows = [
  ".github/workflows/plan.yml",
  ".github/workflows/plan-implement-worker.yml",
  ".github/workflows/fix-worker.yml",
  ".github/workflows/learn.yml",
  ".github/workflows/semantic-review.yml",
] as const;

test("canonical은 Framework key, 배포 App은 App key를 repo identity로 선택한다", async () => {
  let total = 0;
  for (const path of directAiWorkflows) {
    const workflow = await readFile(path, "utf8");
    const matches = workflow.split(selector).length - 1;
    assert.ok(matches >= 1, `${path}: repository-scoped Codex secret selector missing`);
    total += matches;
    assert.doesNotMatch(workflow, /openai-api-key:\s*\$\{\{\s*secrets\.(?:FRAMEWORK_CODEX_API_KEY|APP_CODEX_API_KEY)\s*\}\}/);
  }
  assert.equal(total, 8);
});

test("Semantic REVIEW reusable workflow는 두 secret을 optional contract로 받는다", async () => {
  const workflow = await readFile(".github/workflows/semantic-review.yml", "utf8");
  assert.match(workflow, /FRAMEWORK_CODEX_API_KEY:\s*\n\s*required: false/);
  assert.match(workflow, /APP_CODEX_API_KEY:\s*\n\s*required: false/);
  assert.doesNotMatch(workflow, /(?:FRAMEWORK|APP)_CODEX_API_KEY:\s*\n\s*required: true/);
});
