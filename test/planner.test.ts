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
  PLAN_SCHEMA,
  selectPlanContext,
  snapshot,
  validatePlan,
  verifyPlanContextPack,
  type PlanContextPack,
} from "../src/self-improvement/planner.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "planner-test-"));
  const target = join(root, "target");
  const output = join(root, "output");
  mkdirSync(target); mkdirSync(output);
  writeFileSync(join(target, "orders.ts"), "export const orders = [];\n");
  writeFileSync(join(target, "orders.test.ts"), "assert.deepEqual(orders, []);\n");
  writeFileSync(join(target, "README.md"), "Order list\n");
  return { root, target, output };
}

function planFor(context: PlanContextPack) {
  return {
    summary: "고객 이름으로 주문 검색",
    analysis: context.files.slice(0, Math.min(2, context.files.length)).map((file, index) => ({
      evidenceId: file.evidenceId,
      finding: index === 0 ? "주문 검색 동작을 변경할 후보입니다." : "관련 테스트 또는 문서를 함께 확인해야 합니다.",
    })),
    approach: ["고객 이름 필터 추가"],
    changeCandidates: ["주문 조회 로직과 관련 테스트를 제한된 문맥 안에서 수정"],
    acceptanceCriteria: ["김민수 검색 시 해당 고객 주문만 표시"],
    testStrategy: ["빈 검색과 고객 일치 테스트 추가"],
    questions: [],
  };
}

test("business requirement produces bounded PLAN artifacts with trusted evidence IDs", () => {
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
    assert.match(prompt, /evidenceId/);
    assert.match(prompt, /path나 원문 quote를 직접 작성하지 마세요/);
    const context = JSON.parse(readFileSync(join(f.output, "PLAN-context.json"), "utf8")) as PlanContextPack;
    assert.doesNotThrow(() => verifyPlanContextPack(context));
    assert.ok(context.files.length <= PLAN_CONTEXT_MAX_FILES);
    assert.ok(context.totalBytes <= PLAN_CONTEXT_MAX_BYTES);
    assert.deepEqual(context.files.map((file, index) => file.evidenceId), context.files.map((_, index) => `E${index + 1}`));

    // Stub only the external AI response; trusted finalize resolves IDs to exact path/digest.
    writeFileSync(join(f.output, "raw-plan.json"), JSON.stringify(planFor(context)));
    const result = run("artifact");
    assert.equal(result.status, 0, result.stderr);
    const planArtifact = JSON.parse(readFileSync(join(f.output, "PLAN.json"), "utf8"));
    assert.equal(planArtifact.plan.analysis[0].evidenceId, context.files[0]!.evidenceId);
    assert.equal(planArtifact.plan.analysis[0].path, context.files[0]!.path);
    assert.equal(planArtifact.plan.analysis[0].contentDigest, context.files[0]!.contentDigest);
    assert.match(readFileSync(join(f.output, "PLAN.md"), "utf8"), /\[E1\]/);
    assert.deepEqual(snapshot(f.target), before);
    writeFileSync(join(f.target, "orders.ts"), "modified");
    assert.notEqual(run("artifact").status, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("deterministic Context Pack binds PLAN analysis to evidence IDs only", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.target, "unrelated.ts"), "export const unrelated = true;\n".repeat(1000));
    const requirement = "orders 주문 필터를 설계한다";
    const first = selectPlanContext(requirement, f.target, "example/orders", "b".repeat(40), { maxFiles: 2, maxBytes: 5000, maxFileBytes: 3000 });
    const second = selectPlanContext(requirement, f.target, "example/orders", "b".repeat(40), { maxFiles: 2, maxBytes: 5000, maxFileBytes: 3000 });
    assert.deepEqual(first, second);
    assert.ok(first.files.length <= 2);
    assert.ok(first.totalBytes <= 5000);
    assert.deepEqual(first.files.map((file) => file.evidenceId), first.files.map((_, index) => `E${index + 1}`));
    assert.doesNotThrow(() => verifyPlanContextPack(first));
    assert.match(createPlanPrompt(requirement, first), /Trusted Context Pack/);

    const minimal = {
      summary: "설계",
      analysis: [{ evidenceId: first.files[0]!.evidenceId, finding: "근거" }],
      approach: ["접근"], changeCandidates: ["후보"], acceptanceCriteria: ["완료"], testStrategy: ["테스트"], questions: [],
    };
    const normalized = validatePlan(minimal, f.target, first);
    const analysis = normalized.analysis as Array<{ evidenceId: string; path: string; contentDigest: string; finding: string }>;
    assert.equal(analysis[0]!.path, first.files[0]!.path);
    assert.equal(analysis[0]!.contentDigest, first.files[0]!.contentDigest);
    assert.throws(() => validatePlan({ ...minimal, analysis: [{ evidenceId: "E999", finding: "근거" }] }, f.target, first), /outside bounded PLAN context/);
    assert.throws(() => validatePlan({ ...minimal, analysis: [minimal.analysis[0], minimal.analysis[0]] }, f.target, first), /Duplicate PLAN evidence ID/);

    const tampered = structuredClone(first);
    tampered.files[0]!.evidenceId = "E2";
    assert.throws(() => verifyPlanContextPack(tampered), /evidence identity/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("rejects free-form quote/path evidence, missing strategies, empty requirements and target output paths", () => {
  const f = fixture();
  try {
    const context = selectPlanContext("orders 주문", f.target, "example/orders", "c".repeat(40));
    const valid = planFor(context);
    const evidenceId = context.files[0]!.evidenceId;
    assert.throws(() => validatePlan({ ...valid, analysis: [{ evidenceId, finding: "근거", quote: "invented" }] }, f.target, context), /Invalid analysis evidence fields/);
    assert.throws(() => validatePlan({ ...valid, analysis: [{ path: context.files[0]!.path, quote: "invented", finding: "x" }] }, f.target, context), /Invalid analysis evidence fields/);
    assert.throws(() => validatePlan({ ...valid, testStrategy: [] }, f.target, context));
    assert.throws(() => selectPlanContext("  ", f.target, "example/orders", "d".repeat(40)));
    assert.throws(() => assertOutsideTarget(f.target, f.target));
    mkdirSync(join(f.target, "nested"));
    assert.throws(() => assertOutsideTarget(f.target, join(f.target, "nested")));
    symlinkSync(f.target, join(f.root, "alias"));
    assert.throws(() => assertOutsideTarget(f.target, join(f.root, "alias")));
    symlinkSync(f.output, join(f.target, "escape"));
    assert.throws(() => snapshot(f.target), /Unsupported/);

    const schemaText = JSON.stringify(PLAN_SCHEMA.properties.analysis);
    assert.match(schemaText, /evidenceId/);
    assert.doesNotMatch(schemaText, /quote/);
    assert.doesNotMatch(schemaText, /"path"/);
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
