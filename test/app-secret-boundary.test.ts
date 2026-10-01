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

test("PLAN public workflow는 subscription/API credential을 보유하지 않고 나머지 direct AI workflow만 repository-scoped Codex key를 사용한다", async () => {
  const plan = await readFile(".github/workflows/plan.yml", "utf8");
  assert.match(plan, /ai-dev-framework:PLAN_REQUEST v=1/);
  assert.doesNotMatch(plan, /CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|openai-api-key|FRAMEWORK_CODEX_API_KEY|APP_CODEX_API_KEY/);
  assert.doesNotMatch(plan, /anthropics\/claude-code-action|openai\/codex-action/);

  let total = 0;
  for (const path of directCodexWorkflows) {
    const workflow = await readFile(path, "utf8");
    const matches = workflow.split(selector).length - 1;
    assert.ok(matches >= 1, `${path}: repository-scoped Codex secret selector missing`);
    total += matches;
    assert.doesNotMatch(workflow, /openai-api-key:\s*\$\{\{\s*secrets\.(?:FRAMEWORK_CODEX_API_KEY|APP_CODEX_API_KEY)\s*\}\}/);
  }
  // Worker 최초 IMPLEMENT는 Private subscription executor로 옮겨 repair 2개만 Codex key를 쓴다.
  assert.equal(total, 5);
});

test("Semantic REVIEW reusable workflow는 두 secret을 optional contract로 받는다", async () => {
  const workflow = await readFile(".github/workflows/semantic-review.yml", "utf8");
  assert.match(workflow, /FRAMEWORK_CODEX_API_KEY:\s*\n\s*required: false/);
  assert.match(workflow, /APP_CODEX_API_KEY:\s*\n\s*required: false/);
  assert.doesNotMatch(workflow, /(?:FRAMEWORK|APP)_CODEX_API_KEY:\s*\n\s*required: true/);
});
