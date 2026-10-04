import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

test("PLAN model은 subscription request에 명시하고 Framework에는 직접 Codex 호출이 남지 않는다", async () => {
  const plan = await readFile(".github/workflows/plan.yml", "utf8");
  assert.doesNotMatch(plan, /uses:\s*(?:anthropics\/claude-code-action|openai\/codex-action)@/);
  assert.match(plan, /PLAN_MODEL: \$\{\{ needs\.plan\.outputs\.planner_model \}\}/);
  assert.match(plan, /model=\$\{model\} -->/);

  // legacy AUTHORIZE/IMPLEMENT 입구와 수동 smoke를 지워 Codex Action과 Codex API key를 쓰는 workflow가 없다.
  for (const name of await readdir(".github/workflows")) {
    const workflow = await readFile(`.github/workflows/${name}`, "utf8");
    assert.doesNotMatch(workflow, /openai\/codex-action|CODEX_API_KEY|model: gpt-/, name);
  }
});

test("PLAN은 기본 sonnet이고 복잡한 요구만 Opus, PLAN Worker·REVIEW·FIX는 subscription executor를 쓴다", async () => {
  const plan = await readFile(".github/workflows/plan.yml", "utf8");
  assert.match(plan, /source\.kind === 'HUMAN' && complexRequirement \? 'opus' : 'sonnet'/);

  const worker = await readFile(".github/workflows/plan-implement-worker.yml", "utf8");
  // 최초 IMPLEMENT와 repair 1/2는 Private subscription executor(sonnet)로 옮겨 Codex model을 쓰지 않는다.
  assert.doesNotMatch(worker, /uses:\s*openai\/codex-action@|model: gpt-/);

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
  assert.match(learn, /LEARNER_REASONING_EFFORT: medium\n/);
});

test("Product Discovery는 subscription executor(opus)를 쓰고 provenance도 일치한다", async () => {
  const product = await readFile(".github/workflows/product-evaluation.yml", "utf8");
  assert.doesNotMatch(product, /uses:\s*openai\/codex-action@|model: gpt-/);
  assert.match(product, /kind: PRODUCT_EVALUATION\n/);
  assert.match(product, /EVALUATOR_PROVIDER: claude-max-subscription\n/);
  assert.match(product, /EVALUATOR_MODEL: opus\n/);
  assert.match(product, /EVALUATOR_REASONING_EFFORT: medium\n/);
});
