import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const selector = "${{ secrets[github.repository == 'erpsarang/self-improvement-mvp' && 'FRAMEWORK_CODEX_API_KEY' || 'APP_CODEX_API_KEY'] }}";

const directCodexWorkflows = [
  ".github/workflows/plan-implement-worker.yml",
  ".github/workflows/fix-worker.yml",
  ".github/workflows/learn.yml",
  ".github/workflows/semantic-review.yml",
] as const;

test("PLAN은 Claude Max OAuth만, 나머지 direct AI workflow는 repository-scoped Codex key를 사용한다", async () => {
  const plan = await readFile(".github/workflows/plan.yml", "utf8");
  assert.match(plan, /claude_code_oauth_token:\s*\$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}/);
  assert.match(plan, /ANTHROPIC_API_KEY:\s*""/);
  assert.doesNotMatch(plan, /openai-api-key|FRAMEWORK_CODEX_API_KEY|APP_CODEX_API_KEY/);

  let total = 0;
  for (const path of directCodexWorkflows) {
    const workflow = await readFile(path, "utf8");
    const matches = workflow.split(selector).length - 1;
    assert.ok(matches >= 1, `${path}: repository-scoped Codex secret selector missing`);
    total += matches;
    assert.doesNotMatch(workflow, /openai-api-key:\s*\$\{\{\s*secrets\.(?:FRAMEWORK_CODEX_API_KEY|APP_CODEX_API_KEY)\s*\}\}/);
  }
  assert.equal(total, 7);
});

test("Semantic REVIEW reusable workflow는 두 secret을 optional contract로 받는다", async () => {
  const workflow = await readFile(".github/workflows/semantic-review.yml", "utf8");
  assert.match(workflow, /FRAMEWORK_CODEX_API_KEY:\s*\n\s*required: false/);
  assert.match(workflow, /APP_CODEX_API_KEY:\s*\n\s*required: false/);
  assert.doesNotMatch(workflow, /(?:FRAMEWORK|APP)_CODEX_API_KEY:\s*\n\s*required: true/);
});
