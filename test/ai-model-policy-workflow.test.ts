import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const codexWorkflowPaths = [
  ".github/workflows/implement.yml",
  ".github/workflows/bounded-fix-smoke.yml",
  ".github/workflows/single-pass-smoke.yml",
] as const;

test("PLAN model은 subscription request에 명시하고 나머지 lifecycle AI 호출은 explicit model을 유지한다", async () => {
  const plan = await readFile(".github/workflows/plan.yml", "utf8");
  assert.doesNotMatch(plan, /uses:\s*(?:anthropics\/claude-code-action|openai\/codex-action)@/);
  assert.match(plan, /PLAN_MODEL: \$\{\{ needs\.plan\.outputs\.planner_model \}\}/);
  assert.match(plan, /model=\$\{model\} -->/);

  for (const path of codexWorkflowPaths) {
    const workflow = await readFile(path, "utf8");
    const calls = workflow.match(/uses:\s*openai\/codex-action@/g) ?? [];
    const models = workflow.match(/^\s+model:\s*\S+/gm) ?? [];
    assert.ok(calls.length > 0, path);
    assert.equal(models.length, calls.length, `${path}: AI 호출 수와 explicit model 수가 달라서는 안 됩니다`);
  }
});

test("고레버리지 PLAN은 Opus, 구 IMPLEMENT는 Sol, PLAN Worker·REVIEW·FIX는 subscription executor를 쓴다", async () => {
  const plan = await readFile(".github/workflows/plan.yml", "utf8");
  assert.match(plan, /productImprovementCandidate \? 'sonnet' : 'opus'/);

  const worker = await readFile(".github/workflows/plan-implement-worker.yml", "utf8");
  // 최초 IMPLEMENT와 repair 1/2는 Private subscription executor(sonnet)로 옮겨 Codex model을 쓰지 않는다.
  assert.doesNotMatch(worker, /uses:\s*openai\/codex-action@|model: gpt-/);

  const implement = await readFile(".github/workflows/implement.yml", "utf8");
  assert.match(implement, /model: gpt-6-sol\n\s+effort: medium/);

  // bounded FIX Worker는 Private subscription executor(sonnet)로 옮겨 Codex model을 쓰지 않는다.
  const fix = await readFile(".github/workflows/fix-worker.yml", "utf8");
  assert.doesNotMatch(fix, /uses:\s*openai\/codex-action@|model: gpt-/);
  assert.match(fix, /kind: FIX\n/);

  // Semantic REVIEW는 Private subscription executor(opus)로 옮겨 Codex model을 쓰지 않는다.
  const review = await readFile(".github/workflows/semantic-review.yml", "utf8");
  assert.doesNotMatch(review, /uses:\s*openai\/codex-action@|model: gpt-/);
  assert.match(review, /kind: REVIEW\n/);
});

test("LEARN은 subscription executor(sonnet)를 쓰고 provenance도 일치한다", async () => {
  const learn = await readFile(".github/workflows/learn.yml", "utf8");
  assert.doesNotMatch(learn, /uses:\s*openai\/codex-action@|model: gpt-/);
  assert.match(learn, /kind: LEARN\n/);
  assert.match(learn, /LEARNER_PROVIDER: claude-max-subscription\n/);
  assert.match(learn, /LEARNER_MODEL: sonnet\n/);
});

test("Product Evaluation은 subscription executor(sonnet)를 쓰고 provenance도 일치한다", async () => {
  const product = await readFile(".github/workflows/product-evaluation.yml", "utf8");
  assert.doesNotMatch(product, /uses:\s*openai\/codex-action@|model: gpt-/);
  assert.match(product, /kind: PRODUCT_EVALUATION\n/);
  assert.match(product, /EVALUATOR_PROVIDER: claude-max-subscription\n/);
  assert.match(product, /EVALUATOR_MODEL: sonnet\n/);
});

test("smoke는 Luna를 명시한다", async () => {

  for (const path of [
    ".github/workflows/bounded-fix-smoke.yml",
    ".github/workflows/single-pass-smoke.yml",
  ]) {
    const workflow = await readFile(path, "utf8");
    assert.match(workflow, /model: gpt-6-luna\n\s+effort: low/);
  }
});
