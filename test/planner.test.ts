import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  assertOutsideTarget,
  createPlanPrompt,
  PLAN_CONTEXT_MAX_BYTES,
  PLAN_CONTEXT_MAX_FILES,
  selectPlanContext,
  snapshot,
  validatePlan,
  verifyPlanContextPack,
} from "../src/self-improvement/planner.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "planner-test-"));
  const target = join(root, "target");
  const output = join(root, "output");
  mkdirSync(target); mkdirSync(output);
  writeFileSync(join(target, "orders.ts"), "export const orders = [];\n");
  writeFileSync(join(target, "orders.test.ts"), "assert.deepEqual(orders, []);\n");
  writeFileSync(join(target, "README.md"), "Order list\n");
  const plan = {
    summary: "고객 이름으로 주문 검색", analysis: [
      { path: "orders.ts", quote: "export const orders = [];", finding: "주문 목록에 고객 검색 조건이 필요합니다." },
      { path: "orders.test.ts", quote: "assert.deepEqual(orders, []);", finding: "빈 결과 테스트를 유지합니다." },
    ], approach: ["고객 이름 필터 추가"], changeCandidates: ["orders.ts: 필터 추가"],
    acceptanceCriteria: ["김민수 검색 시 해당 고객 주문만 표시"], testStrategy: ["빈 검색과 고객 일치 테스트 추가"], questions: [],
  };
  return { root, target, output, plan };
}

test("business requirement produces bounded PLAN artifacts outside unchanged target", () => {
  const f = fixture();
  try {
    const before = snapshot(f.target);
    const requirement = join(f.output, "requirement.md");
    writeFileSync(requirement, "고객 이름으로 orders 주문을 찾고 싶어요.");
    const run = (command: string) => spawnSync(process.execPath, ["--import", "tsx", resolve("src/self-improvement/planner-handler.ts"), command], {
      env: { ...process.env, PLAN_TARGET: f.target, PLAN_OUTPUT: f.output, PLAN_REQUIREMENT: requirement, PLAN_REPOSITORY: "example/orders", PLAN_SHA: "a".repeat(40) }, encoding: "utf8",
    });
    const prepared = run("prepare");
    assert.equal(prepared.status, 0, prepared.stderr);
    const prompt = readFileSync(join(f.output, "prompt.md"), "utf8");
    assert.match(prompt, /고객 이름/);
    assert.match(prompt, /bounded PLAN/);
    assert.doesNotMatch(prompt, /repository 전체를 탐색하거나 filesystem\/network를 이용해 추가 문맥을 찾지 마세요[\s\S]*대상 repository:/);
    const context = JSON.parse(readFileSync(join(f.output, "PLAN-context.json"), "utf8"));
    assert.doesNotThrow(() => verifyPlanContextPack(context));
    assert.ok(context.files.length <= PLAN_CONTEXT_MAX_FILES);
    assert.ok(context.totalBytes <= PLAN_CONTEXT_MAX_BYTES);

    // Stub only the external AI response; exercise real preparation and trusted artifact generation.
    writeFileSync(join(f.output, "raw-plan.json"), JSON.stringify(f.plan));
    const result = run("artifact");
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(f.output, "PLAN.md"), "utf8"), /AI가 본 제한된 문맥/);
    assert.deepEqual(snapshot(f.target), before);
    writeFileSync(join(f.target, "orders.ts"), "modified");
    assert.notEqual(run("artifact").status, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("deterministic Context Pack is bounded and PLAN evidence cannot escape it", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.target, "unrelated.ts"), "export const unrelated = true;\n".repeat(1000));
    const requirement = "orders 주문 필터를 설계한다";
    const first = selectPlanContext(requirement, f.target, "example/orders", "b".repeat(40), { maxFiles: 2, maxBytes: 5000, maxFileBytes: 3000 });
    const second = selectPlanContext(requirement, f.target, "example/orders", "b".repeat(40), { maxFiles: 2, maxBytes: 5000, maxFileBytes: 3000 });
    assert.deepEqual(first, second);
    assert.ok(first.files.length <= 2);
    assert.ok(first.totalBytes <= 5000);
    assert.doesNotThrow(() => verifyPlanContextPack(first));
    assert.match(createPlanPrompt(requirement, first), /Trusted Context Pack/);

    const validPath = first.files[0]!.path;
    const validQuote = first.files[0]!.content.trim().split("\n")[0]!;
    const minimal = {
      summary: "설계", analysis: [{ path: validPath, quote: validQuote, finding: "근거" }],
      approach: ["접근"], changeCandidates: ["후보"], acceptanceCriteria: ["완료"], testStrategy: ["테스트"], questions: [],
    };
    assert.doesNotThrow(() => validatePlan(minimal, f.target, first));
    assert.throws(() => validatePlan({ ...minimal, analysis: [{ path: "unrelated.ts", quote: "export const unrelated = true;", finding: "근거" }] }, f.target, first), /outside bounded PLAN context/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("rejects invented evidence, missing strategies, empty requirements and target output paths", () => {
  const f = fixture();
  try {
    const context = selectPlanContext("orders 주문", f.target, "example/orders", "c".repeat(40));
    assert.throws(() => validatePlan({ ...f.plan, analysis: [{ path: "../outside", quote: "x", finding: "x" }] }, f.target, context));
    assert.throws(() => validatePlan({ ...f.plan, analysis: [{ path: "orders.ts", quote: "invented", finding: "x" }] }, f.target, context));
    assert.throws(() => validatePlan({ ...f.plan, testStrategy: [] }, f.target, context));
    assert.throws(() => selectPlanContext("  ", f.target, "example/orders", "d".repeat(40)));
    assert.throws(() => assertOutsideTarget(f.target, f.target));
    mkdirSync(join(f.target, "nested"));
    assert.throws(() => assertOutsideTarget(f.target, join(f.target, "nested")));
    symlinkSync(f.target, join(f.root, "alias"));
    assert.throws(() => assertOutsideTarget(f.target, join(f.root, "alias")));
    symlinkSync(f.output, join(f.target, "escape"));
    assert.throws(() => snapshot(f.target), /Unsupported/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("PLAN workflow removes repositories before bounded read-only AI execution", () => {
  const workflow = readFileSync(".github/workflows/plan.yml", "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /timeout-minutes: 5/);
  assert.match(workflow, /Remove repository checkouts before AI/);
  assert.match(workflow, /rm -rf planner-control plan-target/);
  assert.match(workflow, /Read-only bounded AI Planner[\s\S]*timeout-minutes: 3/);
  assert.match(workflow, /permission-profile: ":read-only"/);
  assert.match(workflow, /safety-strategy: drop-sudo/);
  assert.match(workflow, /effort: medium/);
  assert.doesNotMatch(workflow, /effort: high/);
  assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 4);
  assert.match(workflow, /Fresh Target checkout at frozen SHA for validation/);
  assert.doesNotMatch(workflow.split("  provenance:")[0]!, /(?:contents|issues|pull-requests): write|workflow_run:|workflow_call:|git (?:commit|push|checkout -b)|trusted-rail/);
  assert.match(workflow, /runner.temp.*ai-plan\/PLAN-context.json/);
});
