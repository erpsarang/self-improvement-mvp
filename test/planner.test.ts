import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { assertOutsideTarget, snapshot, validatePlan, createPlanPrompt } from "../src/self-improvement/planner.js";

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
      { path: "README.md", quote: "Order list", finding: "검색 사용법을 문서화합니다." },
    ], approach: ["고객 이름 필터 추가"], changeCandidates: ["orders.ts: 필터 추가"],
    acceptanceCriteria: ["김민수 검색 시 해당 고객 주문만 표시"], testStrategy: ["빈 검색과 고객 일치 테스트 추가"], questions: [],
  };
  return { root, target, output, plan };
}

test("business requirement produces artifacts outside unchanged target with repository evidence", () => {
  const f = fixture();
  try {
    const before = snapshot(f.target);
    const requirement = join(f.output, "requirement.md");
    writeFileSync(requirement, "고객 이름으로 주문을 찾고 싶어요.");
    const run = (command: string) => spawnSync(process.execPath, ["--import", "tsx", resolve("src/self-improvement/planner-handler.ts"), command], {
      env: { ...process.env, PLAN_TARGET: f.target, PLAN_OUTPUT: f.output, PLAN_REQUIREMENT: requirement, PLAN_REPOSITORY: "example/orders", PLAN_SHA: "a".repeat(40) }, encoding: "utf8",
    });
    const prepared = run("prepare");
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.match(readFileSync(join(f.output, "prompt.md"), "utf8"), /고객 이름/);
    // Stub only the external AI response; exercise real preparation and artifact generation.
    writeFileSync(join(f.output, "raw-plan.json"), JSON.stringify(f.plan));
    const result = run("artifact");
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(f.output, "PLAN.md"), "utf8"), /테스트 전략/);
    assert.deepEqual(snapshot(f.target), before);
    writeFileSync(join(f.target, "orders.ts"), "modified");
    assert.notEqual(run("artifact").status, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("rejects invented evidence, missing strategies, empty requirements and target output paths", () => {
  const f = fixture();
  try {
    const files = snapshot(f.target);
    assert.throws(() => validatePlan({ ...f.plan, analysis: [{ path: "../outside", quote: "x", finding: "x" }] }, f.target, files));
    assert.throws(() => validatePlan({ ...f.plan, analysis: [{ path: "orders.ts", quote: "invented", finding: "x" }] }, f.target, files));
    assert.throws(() => validatePlan({ ...f.plan, testStrategy: [] }, f.target, files));
    assert.throws(() => createPlanPrompt("  ", f.target));
    assert.throws(() => assertOutsideTarget(f.target, f.target));
    mkdirSync(join(f.target, "nested"));
    assert.throws(() => assertOutsideTarget(f.target, join(f.target, "nested")));
    symlinkSync(f.target, join(f.root, "alias"));
    assert.throws(() => assertOutsideTarget(f.target, join(f.root, "alias")));
    symlinkSync(f.output, join(f.target, "escape"));
    assert.throws(() => snapshot(f.target), /Unsupported/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("PLAN workflow is standalone and enforces read-only execution", () => {
  const workflow = readFileSync(".github/workflows/plan.yml", "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permission-profile: ":read-only"/);
  assert.match(workflow, /safety-strategy: drop-sudo/);
  assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 2);
  assert.doesNotMatch(workflow.split("  provenance:")[0]!, /(?:contents|issues|pull-requests): write|workflow_run:|workflow_call:|git (?:commit|push|checkout -b)|trusted-rail/);
  assert.match(workflow, /runner.temp.*ai-plan\/PLAN.md/);
});
