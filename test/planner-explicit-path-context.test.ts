import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { augmentPlanContextWithExplicitPaths } from "../src/self-improvement/plan-explicit-path-context.js";
import { selectPlanContext, verifyPlanContextPack } from "../src/self-improvement/planner.js";

test("PLAN Context는 Requirement의 실재 exact path를 등장 순서대로 heuristic보다 우선한다", () => {
  const root = mkdtempSync(join(tmpdir(), "planner-explicit-path-"));
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "test"));
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });

    writeFileSync(join(root, "src", "noise.ts"), "learn test execution provenance context ".repeat(100));
    writeFileSync(join(root, "src", "second.ts"), "export const second = true;\n");
    writeFileSync(join(root, "src", "first.ts"), "export const first = true;\n");
    writeFileSync(join(root, ".github", "workflows", "plan.yml"), "name: plan\n");
    writeFileSync(join(root, "test", "example.test.ts"), "const ok = true; void ok;\n");

    const requirement = [
      "다음 exact Context Anchor를 사용한다.",
      "`src/second.ts`",
      "`src/missing.ts`",
      "`src/first.ts`",
      "`.github/workflows/plan.yml`",
      "`test/example.test.ts`",
    ].join("\n");
    const base = selectPlanContext(requirement, root, "example/framework", "a".repeat(40));
    const options = { maxFiles: 3, maxBytes: 10_000, maxFileBytes: 4_000 };
    const first = augmentPlanContextWithExplicitPaths(requirement, root, base, options);
    const second = augmentPlanContextWithExplicitPaths(requirement, root, base, options);

    assert.deepEqual(first, second);
    assert.doesNotThrow(() => verifyPlanContextPack(first));
    assert.deepEqual(first.files.map((file) => file.path), [
      "src/second.ts",
      "src/first.ts",
      ".github/workflows/plan.yml",
    ]);
    assert.ok(!first.files.some((file) => file.path === "src/missing.ts"));
    assert.ok(first.totalBytes <= options.maxBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PLAN Context explicit path augmentation은 byte budget을 넘지 않고 뒤 heuristic context만 생략한다", () => {
  const root = mkdtempSync(join(tmpdir(), "planner-explicit-byte-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "one.ts"), "ONE ".repeat(100));
    writeFileSync(join(root, "src", "two.ts"), "TWO ".repeat(100));
    writeFileSync(join(root, "src", "noise.ts"), "noise ".repeat(100));

    const requirement = "`src/one.ts`와 `src/two.ts`를 먼저 본다.";
    const base = selectPlanContext(requirement, root, "example/framework", "b".repeat(40));
    const pack = augmentPlanContextWithExplicitPaths(requirement, root, base, {
      maxFiles: 3,
      maxBytes: 60,
      maxFileBytes: 40,
    });

    assert.doesNotThrow(() => verifyPlanContextPack(pack));
    assert.deepEqual(pack.files.map((file) => file.path), ["src/one.ts", "src/two.ts"]);
    assert.equal(pack.totalBytes, 60);
    assert.equal(pack.files[0]?.byteLength, 40);
    assert.equal(pack.files[1]?.byteLength, 20);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planner prepare pipeline은 explicit path 뒤에 direct impacted test evidence를 최종 보강한다", () => {
  const handler = readFileSync(join(process.cwd(), "src/self-improvement/planner-handler.ts"), "utf8");
  // AI call-site → explicit path → direct impacted test evidence 순서로 최종 Context를 확정한다.
  assert.match(handler, /const aiCallSiteContext = augmentPlanContextWithAiCallSites\(requirement, target, humanContext\);/);
  assert.match(handler, /const explicitContext = augmentPlanContextWithExplicitPaths\(requirement, target, aiCallSiteContext\);/);
  assert.match(handler, /const context = augmentPlanContextWithDirectTestEvidence\(target, explicitContext\);/);
});

// #259 재PLAN run 36086224421: Planner가 변경 대상 source의 기존 직접 테스트를 allowedPaths에 넣었지만,
// 업무 관계 보강이 보호한 source/직접 테스트 쌍을 뒤 보강(AI 호출 지점)이 버려 Context Pack에 그 테스트가 없었다.
// 명시 경로 보강은 명시된 App source의 exact-stem 직접 테스트(#124 규칙)를 source당 하나 함께 넣는다.
function directTestFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "planner-explicit-direct-test-"));
  mkdirSync(join(root, "src", "self-improvement"), { recursive: true });
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, "src", "cost.ts"), "export const cost = 1;\n");
  writeFileSync(join(root, "src", "baseline.ts"), "export const baseline = 0;\n");
  writeFileSync(join(root, "src", "self-improvement", "planner.ts"), "export const planner = 1;\n");
  // exact-stem 직접 테스트
  writeFileSync(join(root, "test", "cost.test.ts"), "import { cost } from '../src/cost.js';\nimport { baseline } from '../src/baseline.js';\nvoid cost; void baseline;\n");
  // baseline을 import하지만 stem이 다른 테스트는 직접 테스트가 아니다
  writeFileSync(join(root, "test", "summary.test.ts"), "import { baseline } from '../src/baseline.js';\nvoid baseline;\n");
  // 이름만 같고 import하지 않는 테스트도 직접 테스트가 아니다
  writeFileSync(join(root, "test", "baseline.test.ts"), "const unrelated = true; void unrelated;\n");
  writeFileSync(join(root, "test", "planner.test.ts"), "import { planner } from '../src/self-improvement/planner.js';\nvoid planner;\n");
  writeFileSync(join(root, "notes.md"), "noise ".repeat(200));
  return root;
}

test("명시된 App source의 기존 직접 테스트는 앞 단계가 버렸어도 최종 Context에 들어간다 (#259)", () => {
  const root = directTestFixture();
  try {
    const requirement = "## 예상 변경 범위\n\n- `src/cost.ts`\n- `src/baseline.ts`\n";
    // 앞 보강이 pack을 다시 만들어 직접 테스트를 잃은 모양: 들어오는 pack에 test/cost.test.ts가 없다.
    const withoutTest = selectPlanContext("notes", root, "example/app", "c".repeat(40));
    assert.ok(!withoutTest.files.some((file) => file.path === "test/cost.test.ts"));
    const pack = augmentPlanContextWithExplicitPaths(requirement, root, withoutTest);
    verifyPlanContextPack(pack);
    const paths = pack.files.map((file) => file.path);
    assert.deepEqual(paths.slice(0, 3), ["src/cost.ts", "src/baseline.ts", "test/cost.test.ts"]);
    assert.equal(pack.files.find((file) => file.path === "test/cost.test.ts")?.content, readFileSync(join(root, "test", "cost.test.ts"), "utf8"));
    // 직접 테스트만: stem이 다른 importer와 import하지 않는 동명 테스트는 넣지 않는다.
    assert.ok(!paths.includes("test/summary.test.ts"));
    assert.ok(!paths.includes("test/baseline.test.ts"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("직접 테스트 보강은 Framework source에는 적용하지 않고 이미 명시된 테스트를 중복하지 않는다", () => {
  const root = directTestFixture();
  try {
    const framework = augmentPlanContextWithExplicitPaths("`src/self-improvement/planner.ts`", root, selectPlanContext("notes", root, "example/app", "d".repeat(40)));
    assert.ok(!framework.files.some((file) => file.path === "test/planner.test.ts"));

    const named = augmentPlanContextWithExplicitPaths("`src/cost.ts`\n`test/cost.test.ts`", root, selectPlanContext("notes", root, "example/app", "d".repeat(40)));
    verifyPlanContextPack(named);
    assert.deepEqual(named.files.slice(0, 2).map((file) => file.path), ["src/cost.ts", "test/cost.test.ts"]);
    assert.equal(named.files.filter((file) => file.path === "test/cost.test.ts").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("직접 테스트 보강은 file/byte budget 안에서만 추가한다", () => {
  const root = directTestFixture();
  try {
    const requirement = "`src/cost.ts`";
    const base = selectPlanContext("notes", root, "example/app", "e".repeat(40));
    const one = augmentPlanContextWithExplicitPaths(requirement, root, base, { maxFiles: 1 });
    assert.deepEqual(one.files.map((file) => file.path), ["src/cost.ts"]);
    const sourceBytes = Buffer.byteLength(readFileSync(join(root, "src", "cost.ts")));
    const tight = augmentPlanContextWithExplicitPaths(requirement, root, base, { maxBytes: sourceBytes + 5 });
    verifyPlanContextPack(tight);
    assert.ok(tight.totalBytes <= sourceBytes + 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("실제 repo에서 #259 요구의 prepare pipeline Context에 test/ai-cost-comparison.test.ts가 들어가 trusted scope 검증 조건을 만족한다", async () => {
  const { augmentPlanContextWithBusinessRelations } = await import("../src/self-improvement/plan-business-context.js");
  const { augmentPlanContextWithHumanOutputSurfaces } = await import("../src/self-improvement/plan-human-output-context.js");
  const { augmentPlanContextWithAiCallSites } = await import("../src/self-improvement/plan-ai-call-site-context.js");
  const { needsHumanOutputPlanContext } = await import("../src/self-improvement/plan-context-policy.js");
  // PLAN 선택기는 symlink를 거부하므로 node_modules 등을 뺀 repository 파일 복사본을 target으로 쓴다.
  const target = mkdtempSync(join(tmpdir(), "planner-259-"));
  for (const entry of ["src", "test", "docs", ".github", "package.json", "tsconfig.json"]) {
    cpSync(join(process.cwd(), entry), join(target, entry), { recursive: true });
  }
  const requirement = [
    "[Self-Improvement] 실제 실행 비용 기록을 출처와 함께 비교할 수 있게 하기",
    "",
    "실행별 비용과 호출 수를 실제 기록에서 가져오고 출처를 결과에 함께 표시한다. 새 AI 호출이나 네트워크 조회를 전제하지 않는다.",
    "",
    "## 예상 변경 범위",
    "",
    "- `src/ai-cost-comparison.ts`",
    "- `src/ai-execution-baseline.ts`",
    "",
    "## 근거로 읽은 제품 파일",
    "",
    "- `docs/ai-cost-policy.md`",
    "- `src/ai-cost-comparison.ts`",
    "- `src/ai-execution-baseline.ts`",
  ].join("\n");
  const selected = selectPlanContext(requirement, target, "erpsarang/self-improvement-mvp", "f".repeat(40));
  const business = augmentPlanContextWithBusinessRelations(requirement, target, selected);
  const human = needsHumanOutputPlanContext(requirement) ? augmentPlanContextWithHumanOutputSurfaces(requirement, target, business) : business;
  const aiCallSites = augmentPlanContextWithAiCallSites(requirement, target, human);
  // 재현 조건: AI 호출 지점 보강 뒤에는 직접 테스트가 없다.
  assert.ok(!aiCallSites.files.some((file) => file.path === "test/ai-cost-comparison.test.ts"));
  const pack = augmentPlanContextWithExplicitPaths(requirement, target, aiCallSites);
  verifyPlanContextPack(pack);
  const paths = pack.files.map((file) => file.path);
  // validatePlan 규칙: 존재하는 allowedPath는 Context Pack 안에 있어야 한다. #259 Planner가 낸 경로를 그대로 쓴다.
  for (const allowedPath of ["src/ai-cost-comparison.ts", "src/ai-execution-baseline.ts", "test/ai-cost-comparison.test.ts"]) {
    assert.ok(paths.includes(allowedPath), `${allowedPath} must be in the bounded PLAN context: ${paths.join(", ")}`);
  }
  assert.ok(pack.files.length <= 8);
  rmSync(target, { recursive: true, force: true });
});

test("backtick으로 명시한 루트 파일은 실재 일반 파일일 때만 Context에 들어간다 (#273)", () => {
  const root = mkdtempSync(join(tmpdir(), "planner-explicit-root-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "package.json"), "{\"scripts\":{\"test\":\"node --test\"}}\n");
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    const requirement = "`src/a.ts`와 `package.json`을 본다. `missing.json`, `src`, `ready`는 파일이 아니다.";
    // 재현 조건: 앞 단계 Context에는 package.json이 없다 (run 36114594331에서는 workflow 발췌가 자리를 채웠다).
    const base = selectPlanContext(requirement, root, "example/framework", "c".repeat(40), { maxFiles: 1 });
    assert.ok(!base.files.some((file) => file.path === "package.json"), base.files.map((file) => file.path).join(", "));
    const pack = augmentPlanContextWithExplicitPaths(requirement, root, base);
    verifyPlanContextPack(pack);
    const paths = pack.files.map((file) => file.path);
    assert.deepEqual(paths.slice(0, 2), ["src/a.ts", "package.json"]);
    for (const absent of ["missing.json", "src", "ready"]) assert.ok(!paths.includes(absent), absent);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("큰 명시 파일은 backtick으로 명시한 symbol의 선언부를 중심으로 발췌한다 (#273)", () => {
  const root = mkdtempSync(join(tmpdir(), "planner-explicit-symbol-"));
  try {
    mkdirSync(join(root, "src"));
    const head = "// plan context requirement\nexport const early = targetPrompt;\n" + "const filler = 'plan context';\n".repeat(1_000);
    const body = "export function targetPrompt(requirement: string): string {\n  return `POLICY-SENTENCE ${requirement}`;\n}\n";
    writeFileSync(join(root, "src", "big.ts"), `${head}${body}`);
    const text = readFileSync(join(root, "src", "big.ts"), "utf8");
    const options = { maxFileBytes: 4_000 };

    const withSymbol = "`src/big.ts`의 `targetPrompt(requirement)` 정책을 plan context 요구에 맞게 바꾼다.";
    const pack = augmentPlanContextWithExplicitPaths(withSymbol, root, selectPlanContext(withSymbol, root, "example/framework", "d".repeat(40)), options);
    verifyPlanContextPack(pack);
    const file = pack.files.find((entry) => entry.path === "src/big.ts")!;
    assert.ok(file.startOffset > 0);
    assert.ok(file.content.includes("export function targetPrompt") && file.content.includes("POLICY-SENTENCE"));
    assert.equal(text.slice(file.startOffset, file.startOffset + file.content.length), file.content);

    // symbol이 없거나 파일에 없으면 기존 요구 단어 기준 발췌 그대로다.
    for (const requirement of ["`src/big.ts`의 plan context 요구를 바꾼다.", "`src/big.ts`의 `absentSymbol()` plan context 요구를 바꾼다."]) {
      const fallback = augmentPlanContextWithExplicitPaths(requirement, root, selectPlanContext(requirement, root, "example/framework", "d".repeat(40)), options);
      const excerpt = fallback.files.find((entry) => entry.path === "src/big.ts")!;
      assert.equal(excerpt.startOffset, 0);
      assert.ok(!excerpt.content.includes("POLICY-SENTENCE"));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("실제 repo에서 #273 요구의 prepare pipeline Context에 createPlanPrompt 선언부와 package.json이 들어간다", async () => {
  const { augmentPlanContextWithBusinessRelations } = await import("../src/self-improvement/plan-business-context.js");
  const { augmentPlanContextWithHumanOutputSurfaces } = await import("../src/self-improvement/plan-human-output-context.js");
  const { augmentPlanContextWithAiCallSites } = await import("../src/self-improvement/plan-ai-call-site-context.js");
  const { needsHumanOutputPlanContext } = await import("../src/self-improvement/plan-context-policy.js");
  const target = mkdtempSync(join(tmpdir(), "planner-273-"));
  try {
    for (const entry of ["src", "test", "docs", ".github", "package.json", "tsconfig.json"]) {
      cpSync(join(process.cwd(), entry), join(target, entry), { recursive: true });
    }
    // #273 본문의 Context 관련 요지 (run 36114594331에서 createPlanPrompt와 package.json이 빠졌다).
    const requirement = [
      "[업무 요구] PLAN이 사람이 정한 Issue 완료선을 임의로 후속 범위로 미루지 않게 하고 싶다",
      "",
      "현재 `src/self-improvement/planner.ts`의 PLAN prompt에는 첫 bounded slice를 우선하는 규칙이 있습니다.",
      "새 AI 호출, retry/fallback, 모델/effort 변경을 하지 않습니다. AI 비용도 발생했습니다.",
      "",
      "- 파일: `src/self-improvement/planner.ts`",
      "- symbol: `createPlanPrompt(requirement, context)`",
      "- `test/planner.test.ts`",
      "- `test/planner-blocking-questions-contract.test.ts`",
      "- `test/planner-context-policy.test.ts`",
      "- `package.json`",
    ].join("\n");
    const selected = selectPlanContext(requirement, target, "erpsarang/self-improvement-mvp", "f".repeat(40));
    const business = augmentPlanContextWithBusinessRelations(requirement, target, selected);
    const human = needsHumanOutputPlanContext(requirement) ? augmentPlanContextWithHumanOutputSurfaces(requirement, target, business) : business;
    const aiCallSites = augmentPlanContextWithAiCallSites(requirement, target, human);
    const pack = augmentPlanContextWithExplicitPaths(requirement, target, aiCallSites);
    verifyPlanContextPack(pack);
    const paths = pack.files.map((file) => file.path);
    assert.ok(paths.includes("package.json"), paths.join(", "));
    const planner = pack.files.find((file) => file.path === "src/self-improvement/planner.ts")!;
    assert.ok(planner.content.includes("export function createPlanPrompt("), `planner.ts excerpt starts at ${planner.startOffset}`);
    assert.ok(pack.files.length <= 8 && pack.totalBytes <= 80_000);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});
