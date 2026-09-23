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
  PLAN_ALLOWED_PATH_PATTERN,
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
  const allowedPath = context.files[0]!.path;
  return {
    summary: "고객 이름으로 주문 검색",
    analysis: context.files.slice(0, Math.min(2, context.files.length)).map((file, index) => ({
      evidenceId: file.evidenceId,
      finding: index === 0 ? "주문 검색 동작을 변경할 후보입니다." : "관련 테스트 또는 문서를 함께 확인해야 합니다.",
    })),
    approach: ["고객 이름 필터 추가"],
    changeCandidates: [`${allowedPath} 변경`],
    acceptanceCriteria: ["김민수 검색 시 해당 고객 주문만 표시"],
    testStrategy: ["빈 검색과 고객 일치 테스트 추가"],
    questions: [],
    implementationScope: {
      ready: true,
      allowedPaths: [allowedPath],
      contextPaths: [],
      requiredChanges: ["고객 이름 필터를 추가한다"],
      forbiddenChanges: ["승인 또는 병합 경계를 변경하지 않는다"],
      validationCommands: ["npm test"],
    },
  };
}

test("business requirement produces bounded PLAN artifacts with trusted evidence IDs and exact implementation scope", () => {
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
    assert.match(prompt, /implementationScope/);
    assert.match(prompt, /path나 원문 quote를 직접 작성하지 마세요/);
    const context = JSON.parse(readFileSync(join(f.output, "PLAN-context.json"), "utf8")) as PlanContextPack;
    assert.doesNotThrow(() => verifyPlanContextPack(context));
    assert.ok(context.files.length <= PLAN_CONTEXT_MAX_FILES);
    assert.ok(context.totalBytes <= PLAN_CONTEXT_MAX_BYTES);
    assert.deepEqual(context.files.map((file) => file.evidenceId), context.files.map((_, index) => `E${index + 1}`));

    writeFileSync(join(f.output, "raw-plan.json"), JSON.stringify(planFor(context)));
    const result = run("artifact");
    assert.equal(result.status, 0, result.stderr);
    const planArtifact = JSON.parse(readFileSync(join(f.output, "PLAN.json"), "utf8"));
    assert.equal(planArtifact.plan.analysis[0].evidenceId, context.files[0]!.evidenceId);
    assert.equal(planArtifact.plan.analysis[0].path, context.files[0]!.path);
    assert.equal(planArtifact.plan.analysis[0].contentDigest, context.files[0]!.contentDigest);
    assert.equal(planArtifact.plan.implementationScope.ready, true);
    assert.deepEqual(planArtifact.plan.implementationScope.allowedPaths, [context.files[0]!.path]);
    const markdown = readFileSync(join(f.output, "PLAN.md"), "utf8");
    assert.match(markdown, /\[E1\]/);
    assert.match(markdown, /IMPLEMENT 가능/);
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

    const minimal = planFor(first);
    const normalized = validatePlan(minimal, f.target, first);
    const analysis = normalized.analysis as Array<{ evidenceId: string; path: string; contentDigest: string; finding: string }>;
    assert.equal(analysis[0]!.path, first.files[0]!.path);
    assert.equal(analysis[0]!.contentDigest, first.files[0]!.contentDigest);
    assert.throws(() => validatePlan({ ...minimal, analysis: [{ evidenceId: "E999", finding: "근거" }] }, f.target, first), /outside bounded PLAN context/);
    assert.throws(() => validatePlan({ ...minimal, analysis: [minimal.analysis[0], minimal.analysis[0]] }, f.target, first), /Duplicate PLAN evidence ID/);

    const tampered = JSON.parse(JSON.stringify(first)) as any;
    tampered.files[0].evidenceId = "E2";
    assert.throws(() => verifyPlanContextPack(tampered), /evidence identity/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("implementation scope is fail-closed and cannot authorize unseen existing paths", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.target, "hidden.ts"), "export const hidden = true;\n");
    const context = selectPlanContext("orders 주문", f.target, "example/orders", "c".repeat(40), { maxFiles: 1 });
    const valid = planFor(context);

    assert.throws(() => validatePlan({
      ...valid,
      implementationScope: { ...valid.implementationScope, allowedPaths: ["hidden.ts"] },
    }, f.target, context), /outside bounded PLAN context/);
    assert.throws(() => validatePlan({
      ...valid,
      implementationScope: { ...valid.implementationScope, allowedPaths: ["../escape.ts"] },
    }, f.target, context), /Unsafe implementation scope path/);
    assert.throws(() => validatePlan({
      ...valid,
      implementationScope: { ...valid.implementationScope, validationCommands: ["npm exec dangerous"] },
    }, f.target, context), /Untrusted validation command/);
    assert.throws(() => validatePlan({ ...valid, questions: ["확인 필요"] }, f.target, context), /requires no blocking questions/);

    const paused = {
      ...valid,
      questions: ["정확한 출력 지점을 확인해야 합니다."],
      implementationScope: { ready: false, allowedPaths: [], contextPaths: [], requiredChanges: [], forbiddenChanges: [], validationCommands: [] },
    };
    const normalizedPaused = validatePlan(paused, f.target, context);
    assert.equal((normalizedPaused.implementationScope as { ready: boolean }).ready, false);
    assert.throws(() => validatePlan({
      ...paused,
      implementationScope: { ...paused.implementationScope, allowedPaths: ["new.ts"] },
    }, f.target, context), /must be empty when ready=false/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("ready PLAN은 Human approval 전에 package-lock companion capacity와 exact path self-consistency를 검증한다", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.target, "package.json"), '{"scripts":{"test":"node --test","build":"node --check orders.ts"}}\\n');
    const context = selectPlanContext("웹 package build 변경", f.target, "example/orders", "d".repeat(40), { maxFiles: 4 });
    assert.ok(context.files.some((file) => file.path === "package.json"));
    const base = planFor(context);
    const analysis = context.files.slice(0, Math.min(2, context.files.length)).map((file, index) => ({
      evidenceId: file.evidenceId,
      finding: index === 0 ? "웹 실행 설정 변경 후보입니다." : "기존 동작을 함께 확인해야 합니다.",
    }));

    const saturated = {
      ...base,
      analysis,
      changeCandidates: ["package.json: build script를 변경한다"],
      implementationScope: {
        ...base.implementationScope,
        allowedPaths: ["package.json", "src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts", "src/g.ts"],
        requiredChanges: ["package.json build script를 변경한다"],
      },
    };
    assert.throws(
      () => validatePlan(saturated, f.target, context),
      /package-lock\.json capacity within bounded scope/,
    );

    const missingTestPath = {
      ...base,
      testStrategy: ["test/new-web.test.ts를 신규 추가한다"],
    };
    assert.throws(
      () => validatePlan(missingTestPath, f.target, context),
      /exact path outside bounded implementation scope: test\/new-web\.test\.ts/,
    );

    const missingChangeCandidate = {
      ...base,
      changeCandidates: ["src/not-allowed.ts: 신규 구현 파일"],
    };
    assert.throws(
      () => validatePlan(missingChangeCandidate, f.target, context),
      /change candidate path is outside allowedPaths: src\/not-allowed\.ts/,
    );

    // 숫자 분수·비율·날짜는 repository 경로가 아니다 (#240: "2.5/1.25"가 PLAN을 버리게 했다).
    const numericFractions = {
      ...base,
      approach: ["주문수량 2.5/1.25 처럼 부족 수량을 표시한다", "비율 10/3 과 1/2.0 은 반올림한다", "납기 2026/10/15 형식을 유지한다"],
      testStrategy: ["1/2.0 표시와 2.5/1.25 표시를 검증한다"],
    };
    assert.doesNotThrow(() => validatePlan(numericFractions, f.target, context));
    const stillCatchesRealPath = {
      ...numericFractions,
      testStrategy: ["1/2.0 표시를 test/new-web.test.ts 에서 검증한다"],
    };
    assert.throws(
      () => validatePlan(stillCatchesRealPath, f.target, context),
      /exact path outside bounded implementation scope: test\/new-web\.test\.ts/,
    );
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("Context Pack deterministically reserves relevant source/test context before documentation", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.target, "src"));
    mkdirSync(join(f.target, "test"));
    mkdirSync(join(f.target, "docs"));
    writeFileSync(join(f.target, "src", "state.ts"), "export const MERGE_READY = 'MERGE_READY';\n");
    writeFileSync(join(f.target, "test", "state.test.ts"), "// MERGE_READY state test\n");
    writeFileSync(join(f.target, "docs", "states.md"), "MERGE_READY ".repeat(100));
    writeFileSync(join(f.target, "package.json"), '{"scripts":{"test":"node --test"}}\n');
    const context = selectPlanContext("MERGE_READY 상태를 표시한다", f.target, "example/orders", "d".repeat(40), { maxFiles: 4, maxBytes: 20_000 });
    const paths = context.files.map((file) => file.path);
    assert.ok(paths.some((path) => path.startsWith("src/") || path.startsWith("test/")));
    assert.ok(paths.includes("package.json"));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("rejects free-form quote/path evidence, missing strategies, empty requirements and target output paths", () => {
  const f = fixture();
  try {
    const context = selectPlanContext("orders 주문", f.target, "example/orders", "e".repeat(40));
    const valid = planFor(context);
    const evidenceId = context.files[0]!.evidenceId;
    assert.throws(() => validatePlan({ ...valid, analysis: [{ evidenceId, finding: "근거", quote: "invented" }] }, f.target, context), /Invalid analysis evidence fields/);
    assert.throws(() => validatePlan({ ...valid, analysis: [{ path: context.files[0]!.path, quote: "invented", finding: "x" }] }, f.target, context), /Invalid analysis evidence fields/);
    assert.throws(() => validatePlan({ ...valid, testStrategy: [] }, f.target, context));
    assert.throws(() => selectPlanContext("  ", f.target, "example/orders", "f".repeat(40)));
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
    const scopeSchema = JSON.stringify(PLAN_SCHEMA.properties.implementationScope);
    assert.match(scopeSchema, /allowedPaths/);
    assert.match(scopeSchema, /contextPaths/);
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

// ---------------------------------------------------------------------------
// #176 blocker: PLAN AI가 runner 절대경로를 allowedPaths로 반환 → trusted validation 실패
// ---------------------------------------------------------------------------

const REJECTED_ALLOWED_PATHS = [
  "/home/runner/work/_temp/plan-neutral/package.json",
  "/home/runner/work/_temp/plan-neutral/src/order-analysis-cli.ts",
  "/tmp/foo.ts",
  "C:\\repo\\foo.ts",
  "C:/repo/foo.ts",
  "../foo.ts",
  "./foo.ts",
  "src/../foo.ts",
  "src/./foo.ts",
  "src/*",
  "src/",
  "src//foo.ts",
  "src\\foo.ts",
  "src/foo?.ts",
  "src/[a].ts",
  ".",
  "..",
  "",
  " package.json",
];
const ACCEPTED_ALLOWED_PATHS = [
  "package.json",
  "package-lock.json",
  "index.html",
  "src/order-csv.ts",
  "src/web-main.ts",
  "test/order-csv.test.ts",
  ".github/workflows/ci.yml",
  ".gitignore",
  "docs/phase-1-plan.md",
];

test("PLAN prompt는 allowedPaths가 repository-relative path이며 filesystem 절대경로가 금지임을 명시한다", () => {
  const f = fixture();
  try {
    const context = selectPlanContext("orders 주문", f.target, "example/orders", "c".repeat(40), { maxFiles: 1 });
    const prompt = createPlanPrompt("주문 기능을 개선한다", context);
    // 1. repository-relative 규칙
    assert.match(prompt, /implementationScope\.allowedPaths 규칙:/);
    assert.match(prompt, /모든 allowedPaths는 repository root 기준 상대경로입니다/);
    assert.match(prompt, /exact path는 filesystem 절대경로가 아니라 repository root 기준 상대경로\(repository-relative path\)를 뜻합니다/);
    // 2. 절대경로 / runner 위치 금지
    assert.match(prompt, /절대경로는 금지입니다/);
    for (const forbidden of ["/home/...", "/tmp/...", "runner workspace", "plan-neutral", "PLAN_TARGET", "filesystem 실제 위치"]) {
      assert.ok(prompt.includes(forbidden), forbidden);
    }
    assert.match(prompt, /'\.\/' 또는 '\.\.\/' 로 시작하는 경로, backslash, 끝의 '\/', 디렉터리 경로, wildcard도 금지/);
    // 정상 예시
    for (const example of ["package.json", "src/feature.ts", "test/feature.test.ts"]) assert.ok(prompt.includes(example), example);
    // 3. 기존 파일은 Context Pack path 그대로
    assert.match(prompt, /Context Pack의 path 값을 글자 그대로 사용하세요/);
    // 4. 신규 파일도 repo-relative exact path
    assert.match(prompt, /신규 파일도 같은 형식의 repository-relative exact path로만 제안하세요/);
    // 기존 계약 문구는 유지
    assert.match(prompt, /wildcard\/placeholder를 쓰지 마세요/);
    assert.match(prompt, /implementationScope\.ready=true이면 questions는 반드시 빈 배열/);
    assert.match(prompt, /추가·수정·생성할 파일을 언급하면 repository-relative exact path를 쓰고 반드시 allowedPaths에 포함/);
    assert.match(prompt, /package-lock\.json companion을 추가할 수 있도록 8개 bounded slot 중 최소 1개를 비워두세요/);
    assert.match(prompt, /필요한 변경 파일이 8개 안에 들어오지 않으면 범위를 줄이세요/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("PLAN_SCHEMA는 allowedPaths의 절대경로/비정상 경로를 structured output 단계에서 거부한다", () => {
  const items = PLAN_SCHEMA.properties.implementationScope.properties.allowedPaths.items;
  assert.equal(items.pattern, PLAN_ALLOWED_PATH_PATTERN);
  assert.equal(items.type, "string");
  assert.equal(items.minLength, 1);
  assert.equal(items.maxLength, 500);
  assert.equal(PLAN_SCHEMA.properties.implementationScope.properties.allowedPaths.maxItems, 8);
  // lookahead 등 구현 의존 기능을 쓰지 않는다.
  assert.doesNotMatch(PLAN_ALLOWED_PATH_PATTERN, /\(\?[=!<]/);
  const pattern = new RegExp(PLAN_ALLOWED_PATH_PATTERN);
  for (const path of REJECTED_ALLOWED_PATHS) assert.equal(pattern.test(path), false, `must reject ${JSON.stringify(path)}`);
  for (const path of ACCEPTED_ALLOWED_PATHS) assert.equal(pattern.test(path), true, `must accept ${JSON.stringify(path)}`);
});

test("schema pattern은 trusted validator보다 느슨하지 않고, validator의 fail-closed 의미는 그대로다", () => {
  const f = fixture();
  try {
    const context = selectPlanContext("orders 주문", f.target, "example/orders", "c".repeat(40), { maxFiles: 1 });
    const valid = planFor(context);
    const pattern = new RegExp(PLAN_ALLOWED_PATH_PATTERN);
    const validatorAccepts = (path: string): boolean => {
      try {
        validatePlan({ ...valid, implementationScope: { ...valid.implementationScope, allowedPaths: [path] } }, f.target, context);
        return true;
      } catch (error) {
        if (/Unsafe implementation scope path|Invalid implementationScope/.test(String(error))) return false;
        throw error;
      }
    };
    // validator는 기존과 같이 모두 거부한다 (완화 없음).
    for (const path of REJECTED_ALLOWED_PATHS) {
      assert.throws(
        () => validatePlan({ ...valid, implementationScope: { ...valid.implementationScope, allowedPaths: [path] } }, f.target, context),
        /Unsafe implementation scope path|Invalid implementationScope/,
        JSON.stringify(path),
      );
    }
    // schema가 허용하는 신규 경로는 validator도 안전 경로로 인정한다: pattern ⊆ validator.
    for (const path of ACCEPTED_ALLOWED_PATHS) {
      assert.equal(pattern.test(path), true, path);
      assert.equal(validatorAccepts(path), true, `validator must accept ${path}`);
    }
    // validator는 허용하지만 schema는 더 엄격하게 거부하는 경우가 있어도 된다 (그 반대는 안 된다).
    for (const path of ["..foo.ts", "src/...", "-"]) {
      if (pattern.test(path)) assert.equal(validatorAccepts(path), true, path);
    }
    // 기존 파일이 bounded Context 밖이면 여전히 거부된다.
    writeFileSync(join(f.target, "hidden.ts"), "export const hidden = true;\n");
    assert.equal(pattern.test("hidden.ts"), true);
    assert.throws(
      () => validatePlan({ ...valid, implementationScope: { ...valid.implementationScope, allowedPaths: ["hidden.ts"] } }, f.target, context),
      /outside bounded PLAN context/,
    );
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
