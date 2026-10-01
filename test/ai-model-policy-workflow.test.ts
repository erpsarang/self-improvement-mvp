import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const codexWorkflowPaths = [
  ".github/workflows/plan-implement-worker.yml",
  ".github/workflows/implement.yml",
  ".github/workflows/fix-worker.yml",
  ".github/workflows/semantic-review.yml",
  ".github/workflows/learn.yml",
  ".github/workflows/product-evaluation.yml",
  ".github/workflows/bounded-fix-smoke.yml",
  ".github/workflows/single-pass-smoke.yml",
] as const;

test("모든 lifecycle AI 호출은 provider별 model을 명시한다", async () => {
  const plan = await readFile(".github/workflows/plan.yml", "utf8");
  assert.equal((plan.match(/uses:\s*anthropics\/claude-code-action\/base-action@/g) ?? []).length, 1);
  assert.match(plan, /--model \$\{\{ steps\.input\.outputs\.planner_model \}\}/);

  for (const path of codexWorkflowPaths) {
    const workflow = await readFile(path, "utf8");
    const calls = workflow.match(/uses:\s*openai\/codex-action@/g) ?? [];
    const models = workflow.match(/^\s+model:\s*\S+/gm) ?? [];
    assert.ok(calls.length > 0, path);
    assert.equal(models.length, calls.length, `${path}: AI 호출 수와 explicit model 수가 달라서는 안 됩니다`);
  }
});

test("고레버리지 PLAN은 Opus, IMPLEMENT·REVIEW·FIX는 Sol을 명시한다", async () => {
  const plan = await readFile(".github/workflows/plan.yml", "utf8");
  assert.match(plan, /productImprovementCandidate \? 'sonnet' : 'opus'/);

  const worker = await readFile(".github/workflows/plan-implement-worker.yml", "utf8");
  assert.equal((worker.match(/model: gpt-6-sol\n\s+effort: medium/g) ?? []).length, 2);
  assert.equal((worker.match(/model: gpt-6-luna\n\s+effort: medium/g) ?? []).length, 2);

  const implement = await readFile(".github/workflows/implement.yml", "utf8");
  assert.match(implement, /model: gpt-6-sol\n\s+effort: medium/);

  const fix = await readFile(".github/workflows/fix-worker.yml", "utf8");
  assert.match(fix, /model: gpt-6-sol\n\s+effort: medium/);

  const review = await readFile(".github/workflows/semantic-review.yml", "utf8");
  assert.match(review, /model: gpt-6-sol\n\s+effort: medium/);
});

test("반복 read-only 평가와 smoke는 Luna를 명시하고 provenance도 일치한다", async () => {
  const learn = await readFile(".github/workflows/learn.yml", "utf8");
  assert.match(learn, /model: gpt-6-luna/);
  assert.match(learn, /LEARNER_MODEL: gpt-6-luna/);

  const product = await readFile(".github/workflows/product-evaluation.yml", "utf8");
  assert.match(product, /model: gpt-6-luna/);
  assert.match(product, /EVALUATOR_MODEL: gpt-6-luna/);

  for (const path of [
    ".github/workflows/bounded-fix-smoke.yml",
    ".github/workflows/single-pass-smoke.yml",
  ]) {
    const workflow = await readFile(path, "utf8");
    assert.match(workflow, /model: gpt-6-luna\n\s+effort: low/);
  }
});
