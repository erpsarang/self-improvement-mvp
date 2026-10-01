import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";

test("PLAN public workflow는 subscription/API credential을 보유하지 않고 App 배포 AI 경로에는 Codex key가 없다", async () => {
  const plan = await readFile(".github/workflows/plan.yml", "utf8");
  assert.match(plan, /ai-dev-framework:PLAN_REQUEST v=1/);
  assert.doesNotMatch(plan, /CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|openai-api-key|FRAMEWORK_CODEX_API_KEY|APP_CODEX_API_KEY/);
  assert.doesNotMatch(plan, /anthropics\/claude-code-action|openai\/codex-action/);

  // Product Evaluation까지 subscription executor로 옮겨 App repository용 Codex key를 고르는 workflow는 더 없다.
  for (const name of await readdir(".github/workflows")) {
    const workflow = await readFile(`.github/workflows/${name}`, "utf8");
    assert.doesNotMatch(workflow, /APP_CODEX_API_KEY/, name);
  }

  // PLAN Worker의 IMPLEMENT/repair, Semantic REVIEW, bounded FIX Worker, LEARN, Product Evaluation은 Private subscription executor를 쓰고 Codex/Claude credential을 갖지 않는다.
  for (const path of [
    ".github/workflows/plan-implement-worker.yml",
    ".github/workflows/semantic-review.yml",
    ".github/workflows/fix-worker.yml",
    ".github/workflows/learn.yml",
    ".github/workflows/product-evaluation.yml",
    ".github/workflows/subscription-exchange.yml",
  ]) {
    const workflow = await readFile(path, "utf8");
    assert.doesNotMatch(workflow, /openai\/codex-action|openai-api-key|FRAMEWORK_CODEX_API_KEY|APP_CODEX_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY/, path);
  }
});

test("Semantic REVIEW reusable workflow는 Private wake-up token 하나만 optional contract로 받는다", async () => {
  const workflow = await readFile(".github/workflows/semantic-review.yml", "utf8");
  assert.match(workflow, /secrets:\n\s+EXECUTOR_DISPATCH_TOKEN:\s*\n\s*required: false\n/);
  assert.doesNotMatch(workflow, /(?:FRAMEWORK|APP)_CODEX_API_KEY/);
  assert.deepEqual(workflow.match(/secrets\.[A-Za-z0-9_]+/g), ["secrets.EXECUTOR_DISPATCH_TOKEN"]);
});
