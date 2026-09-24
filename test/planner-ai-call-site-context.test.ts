import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AI_CALL_SITE_CONTEXT_MAX_FILE_BYTES,
  aiCallSiteCandidates,
  aiCallStepWindow,
  augmentPlanContextWithAiCallSites,
  isCanonicalFrameworkTarget,
} from "../src/self-improvement/plan-ai-call-site-context.js";
import { needsAiExecutionPlanContext } from "../src/self-improvement/plan-context-policy.js";
import {
  PLAN_CONTEXT_MAX_FILES,
  selectPlanContext,
  verifyPlanContextPack,
  type PlanContextFile,
  type PlanContextPack,
} from "../src/self-improvement/planner.js";

// self-improvement-mvp #244: Framework 자체 요구. 기본 선택은 AI 호출 지점 8곳 중 1곳만 문맥에 넣었다.
const FRAMEWORK_AI_COST_REQUIREMENT = [
  "[업무 요구] AI 호출 비용을 서비스 품질 저하 없이 절감하고 싶다",
  "",
  "현재 Framework의 PLAN, IMPLEMENT/FIX, Semantic REVIEW, LEARN, Product Evaluation 등에서 OpenAI API를 사용하고 있다.",
  "모델을 명시하지 않은 `action-default`가 선택되고 있다. 각 AI 단계의 역할에 맞춰 모델과 reasoning effort를 명시적으로 선택하고 비용·품질을 비교할 수 있어야 한다.",
].join("\n");

function callStep(name: string, effort: string, extra = ""): string {
  return [
    `      - name: ${name}`,
    "        id: ai",
    "        uses: openai/codex-action@v1",
    "        with:",
    "          openai-api-key: ${{ secrets.FRAMEWORK_CODEX_API_KEY }}",
    "          prompt-file: prompt.md",
    `          effort: ${effort}`,
    "          codex-args: '[\"-c\",\"project_doc_max_bytes=0\"]'",
    extra,
  ].filter((line) => line !== "").join("\n");
}

function workflow(name: string, steps: readonly string[], trailer = ""): string {
  return [
    `name: ${name}`,
    "on: workflow_dispatch",
    "jobs:",
    "  run:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - name: 신뢰 control-plane checkout 확인 (한글 step 이름: byte 오프셋과 문자 인덱스가 달라진다)",
    "        run: echo 준비",
    ...steps,
    "      - name: record",
    "        run: echo done",
    trailer,
  ].join("\n");
}

interface Fixture {
  readonly root: string;
  readonly target: string;
}

function makeTarget(packageName: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), "planner-ai-call-site-"));
  const target = join(root, "target");
  mkdirSync(join(target, ".github", "workflows"), { recursive: true });
  mkdirSync(join(target, "src", "self-improvement"), { recursive: true });
  mkdirSync(join(target, "test"), { recursive: true });
  writeFileSync(
    join(target, "package.json"),
    JSON.stringify({ name: packageName, private: true, type: "module", scripts: { build: "tsc --noEmit", test: "npm run build && node --test --import tsx test/*.test.ts" } }, null, 2),
  );
  writeFileSync(join(target, "tsconfig.json"), "{}\n");
  writeFileSync(join(target, ".github", "workflows", "plan.yml"), workflow("Read-only AI PLAN", [callStep("Untrusted read-only AI Planner", "medium")]));
  writeFileSync(join(target, ".github", "workflows", "semantic-review.yml"), workflow("Semantic REVIEW", [callStep("Untrusted read-only Semantic Reviewer", "medium")]));
  writeFileSync(
    join(target, ".github", "workflows", "plan-implement-worker.yml"),
    workflow("PLAN Bounded IMPLEMENT Worker", [callStep("Untrusted bounded IMPLEMENT Worker", "low"), callStep("IMPLEMENT Worker retry", "low")]),
  );
  writeFileSync(join(target, ".github", "workflows", "ci.yml"), workflow("CI", ["      - run: npm test"]));
  writeFileSync(join(target, ".github", "workflows", "notes.md"), "not a workflow\n");
  writeFileSync(join(target, "src", "self-improvement", "learn-handler.ts"), "export const model = process.env.LEARNER_MODEL ?? 'action-default';\n");
  writeFileSync(join(target, "src", "self-improvement", "planner.ts"), "export const PLAN = 'PLAN';\n");
  writeFileSync(join(target, "test", "learn-handler.test.ts"), "import { model } from '../src/self-improvement/learn-handler.js';\nvoid model;\n");
  return { root, target };
}

/** 기존 pack의 파일 목록을 바꿔 trusted Context Pack을 다시 묶는다 (evidenceId E1..En, digest 재계산). */
function repack(context: PlanContextPack, files: readonly PlanContextFile[]): PlanContextPack {
  const rebound = files.map((file, index) => ({ ...file, evidenceId: `E${index + 1}` }));
  const payload = {
    schemaVersion: 1 as const,
    kind: "trusted-plan-context-pack" as const,
    repository: context.repository,
    sha: context.sha,
    files: rebound,
    totalBytes: rebound.reduce((sum, file) => sum + file.byteLength, 0),
  };
  const pack: PlanContextPack = {
    ...payload,
    digestAlgorithm: "sha256",
    contextDigest: createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex"),
  };
  verifyPlanContextPack(pack);
  return pack;
}

/** 기본 선택기가 마지막 슬롯에서 남은 예산만큼 잘라 넣은 모양: #244 run 36005345836의 package.json은 offset 231부터 2바이트("ci")였다. */
function truncatedExcerpt(file: PlanContextFile, text: string, startOffset: number, bytes: number): PlanContextFile {
  const content = text.slice(startOffset, startOffset + bytes);
  return {
    ...file,
    startOffset,
    byteLength: Buffer.byteLength(content, "utf8"),
    contentDigest: createHash("sha256").update(content, "utf8").digest("hex"),
    content,
  };
}

test("needsAiExecutionPlanContext는 AI 주체어와 실행 관심사가 함께 있을 때만 true다", () => {
  assert.equal(needsAiExecutionPlanContext(FRAMEWORK_AI_COST_REQUIREMENT), true);
  assert.equal(needsAiExecutionPlanContext("Semantic REVIEW의 AI 호출 재시도 상한을 낮춘다"), true);
  assert.equal(needsAiExecutionPlanContext("Use a cheaper LLM model for the LEARN stage and record token usage"), true);

  // App 기능 요구: AI가 등장해도 실행 정책이 아니다.
  assert.equal(needsAiExecutionPlanContext("AI 분석 결과를 화면에 표시한다"), false);
  // AI와 무관한 비용/모델 요구.
  assert.equal(needsAiExecutionPlanContext("출고 비용을 주문 데이터 모델에 추가하고 CSV로 내려받는다"), false);
  assert.equal(needsAiExecutionPlanContext("선택 파일이 바뀌면 이전 분석 결과와 다운로드를 무효화한다"), false);
});

test("isCanonicalFrameworkTarget은 root package.json name으로 canonical Framework tree만 인정한다", () => {
  const framework = makeTarget("self-improvement-mvp");
  const app = makeTarget("sales-order-exception-analyzer");
  try {
    assert.equal(isCanonicalFrameworkTarget(framework.target), true);
    assert.equal(isCanonicalFrameworkTarget(app.target), false);
    writeFileSync(join(app.target, "package.json"), "{not json");
    assert.equal(isCanonicalFrameworkTarget(app.target), false);
    rmSync(join(app.target, "package.json"));
    assert.equal(isCanonicalFrameworkTarget(app.target), false);
    // 실제 canonical repo 자신도 인정된다.
    assert.equal(isCanonicalFrameworkTarget(process.cwd()), true);
  } finally {
    rmSync(framework.root, { recursive: true, force: true });
    rmSync(app.root, { recursive: true, force: true });
  }
});

test("aiCallStepWindow는 첫 AI 호출 step 블록만 잘라내고 startOffset은 원문 byte 위치와 일치한다", () => {
  const text = workflow("PLAN Bounded IMPLEMENT Worker", [callStep("Untrusted bounded IMPLEMENT Worker", "low"), callStep("IMPLEMENT Worker retry", "low")]);
  const window = aiCallStepWindow(text, AI_CALL_SITE_CONTEXT_MAX_FILE_BYTES);
  assert.ok(window);
  // validatePlan이 쓰는 검사와 동일: 문자 인덱스 slice가 content와 같아야 한다 (byte 오프셋이면 한글 앞에서 어긋난다).
  assert.equal(text.slice(window.startOffset, window.startOffset + window.content.length), window.content);
  assert.notEqual(Buffer.byteLength(text.slice(0, window.startOffset), "utf8"), window.startOffset, "fixture must contain non-ASCII before the call step");
  assert.match(window.content, /^      - name: Untrusted bounded IMPLEMENT Worker\n/);
  assert.match(window.content, /uses: openai\/codex-action@v1/);
  assert.match(window.content, /effort: low/);
  assert.doesNotMatch(window.content, /IMPLEMENT Worker retry|name: record|actions\/checkout/);

  assert.equal(aiCallStepWindow(workflow("CI", ["      - run: npm test"]), AI_CALL_SITE_CONTEXT_MAX_FILE_BYTES), null);

  // 창은 파일당 상한을 넘지 않는다.
  const long = workflow("PLAN", [callStep("Planner", "medium", `          prompt: ${"x".repeat(5_000)}`)]);
  const trimmed = aiCallStepWindow(long, AI_CALL_SITE_CONTEXT_MAX_FILE_BYTES);
  assert.ok(trimmed);
  assert.ok(Buffer.byteLength(trimmed.content, "utf8") <= AI_CALL_SITE_CONTEXT_MAX_FILE_BYTES);
  assert.match(trimmed.content, /uses: openai\/codex-action@v1/);
});

test("Framework 자체 AI 실행 요구에서는 AI 호출 step 창이 evidence로 들어가고 기존 선택은 예산 안에서 유지된다", () => {
  const fixture = makeTarget("self-improvement-mvp");
  try {
    const base = selectPlanContext(FRAMEWORK_AI_COST_REQUIREMENT, fixture.target, "erpsarang/self-improvement-mvp", "a".repeat(40), {
      maxFiles: 6,
      maxBytes: 40_000,
      maxFileBytes: 8_000,
    });
    const augmented = augmentPlanContextWithAiCallSites(FRAMEWORK_AI_COST_REQUIREMENT, fixture.target, base, { maxFiles: 6, maxBytes: 40_000 });
    verifyPlanContextPack(augmented);

    const paths = augmented.files.map((file) => file.path);
    for (const expected of [".github/workflows/plan.yml", ".github/workflows/semantic-review.yml", ".github/workflows/plan-implement-worker.yml"]) {
      assert.ok(paths.includes(expected), `missing AI call site ${expected}: ${paths.join(", ")}`);
    }
    assert.ok(!paths.includes(".github/workflows/ci.yml"), "workflows without an AI call step are not call sites");
    assert.ok(!paths.includes(".github/workflows/notes.md"));
    assert.ok(paths.includes("package.json"), `project context is retained: ${paths.join(", ")}`);
    const packageFile = augmented.files.find((file) => file.path === "package.json")!;
    assert.equal(packageFile.content, readFileSync(join(fixture.target, "package.json"), "utf8"), "package.json is the whole file, not a leftover excerpt");
    assert.equal(packageFile.startOffset, 0);
    assert.ok(augmented.files.length <= 6);

    for (const file of augmented.files.filter((entry) => entry.path.startsWith(".github/workflows/"))) {
      assert.match(file.content, /uses: openai\/codex-action@v1/, file.path);
      assert.match(file.content, /effort: (?:low|medium)/, file.path);
      assert.ok(file.byteLength <= AI_CALL_SITE_CONTEXT_MAX_FILE_BYTES, file.path);
      const original = readFileSync(join(fixture.target, file.path), "utf8");
      assert.equal(original.slice(file.startOffset, file.startOffset + file.content.length), file.content, `${file.path} startOffset`);
    }
    // 호출 지점은 evidence 앞쪽에 오고 evidenceId는 다시 E1..En으로 묶인다.
    assert.deepEqual(augmented.files.map((file) => file.evidenceId), augmented.files.map((_, index) => `E${index + 1}`));
    assert.ok(augmented.files[0]!.path.startsWith(".github/workflows/"));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("App 배포본이나 AI 실행과 무관한 요구에서는 Context Pack을 바꾸지 않는다", () => {
  const app = makeTarget("sales-order-exception-analyzer");
  const framework = makeTarget("self-improvement-mvp");
  try {
    const appBase = selectPlanContext(FRAMEWORK_AI_COST_REQUIREMENT, app.target, "erpsarang/sales-order-exception-analyzer", "b".repeat(40));
    assert.equal(augmentPlanContextWithAiCallSites(FRAMEWORK_AI_COST_REQUIREMENT, app.target, appBase), appBase);

    const unrelated = "선택 파일이 바뀌면 이전 분석 결과와 다운로드를 무효화한다";
    const frameworkBase = selectPlanContext(unrelated, framework.target, "erpsarang/self-improvement-mvp", "c".repeat(40));
    assert.equal(augmentPlanContextWithAiCallSites(unrelated, framework.target, frameworkBase), frameworkBase);
  } finally {
    rmSync(app.root, { recursive: true, force: true });
    rmSync(framework.root, { recursive: true, force: true });
  }
});

test("호출 지점이 슬롯보다 많아도 기존 선택에 최소 1슬롯을 남기고 요구 관련도 순으로 자른다", () => {
  const fixture = makeTarget("self-improvement-mvp");
  try {
    for (const name of ["learn", "product-evaluation", "implement", "fix-worker", "bounded-fix-smoke", "single-pass-smoke"]) {
      writeFileSync(join(fixture.target, ".github", "workflows", `${name}.yml`), workflow(name, [callStep(`${name} AI step`, "medium")]));
    }
    const all = aiCallSiteCandidates(FRAMEWORK_AI_COST_REQUIREMENT, fixture.target);
    assert.equal(all.length, 9);

    const base = selectPlanContext(FRAMEWORK_AI_COST_REQUIREMENT, fixture.target, "erpsarang/self-improvement-mvp", "d".repeat(40));
    const augmented = augmentPlanContextWithAiCallSites(FRAMEWORK_AI_COST_REQUIREMENT, fixture.target, base);
    verifyPlanContextPack(augmented);
    const callSites = augmented.files.filter((file) => /uses: openai\/codex-action/.test(file.content));
    assert.equal(callSites.length, PLAN_CONTEXT_MAX_FILES - 1);
    assert.deepEqual(callSites.map((file) => file.path), all.slice(0, PLAN_CONTEXT_MAX_FILES - 1).map((file) => file.path));
    assert.equal(augmented.files.length, PLAN_CONTEXT_MAX_FILES);
    assert.ok(!augmented.files[PLAN_CONTEXT_MAX_FILES - 1]!.content.includes("openai/codex-action"), "the last slot stays with the primary selection");
    // 순위는 결정적이다: 같은 입력이면 같은 순서.
    assert.deepEqual(aiCallSiteCandidates(FRAMEWORK_AI_COST_REQUIREMENT, fixture.target).map((file) => file.path), all.map((file) => file.path));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("기본 pack의 package.json이 남은 예산에 잘린 excerpt여도 보강은 frozen target에서 다시 읽어 전체를 넣는다", () => {
  // #244 PLAN run 36005345836 / 36005912970: 기본 선택이 80,000바이트를 다 쓴 뒤 package.json이 2바이트로 들어갔고,
  // 보강이 그 excerpt를 그대로 보존해 Planner가 test/build script를 보지 못했다(validationCommands=[] → fail-closed).
  const fixture = makeTarget("self-improvement-mvp");
  try {
    const base = selectPlanContext(FRAMEWORK_AI_COST_REQUIREMENT, fixture.target, "erpsarang/self-improvement-mvp", "e".repeat(40));
    const packageText = readFileSync(join(fixture.target, "package.json"), "utf8");
    const tsconfigText = readFileSync(join(fixture.target, "tsconfig.json"), "utf8");
    const basePackage = base.files.find((file) => file.path === "package.json");
    assert.ok(basePackage, "fixture base selection must include package.json");
    const truncated = repack(base, base.files.map((file) => {
      if (file.path === "package.json") return truncatedExcerpt(file, packageText, packageText.indexOf("private"), 2);
      if (file.path === "tsconfig.json") return truncatedExcerpt(file, tsconfigText, 0, 1);
      return file;
    }));
    assert.equal(truncated.files.find((file) => file.path === "package.json")!.byteLength, 2);

    const augmented = augmentPlanContextWithAiCallSites(FRAMEWORK_AI_COST_REQUIREMENT, fixture.target, truncated);
    verifyPlanContextPack(augmented);
    const packageFile = augmented.files.find((file) => file.path === "package.json");
    assert.ok(packageFile, "package.json stays in the pack");
    assert.equal(packageFile.content, packageText);
    assert.equal(packageFile.startOffset, 0);
    assert.equal(packageFile.byteLength, Buffer.byteLength(packageText, "utf8"));
    assert.equal(packageFile.contentDigest, createHash("sha256").update(packageText, "utf8").digest("hex"));
    // Planner가 검증 명령을 판단할 근거가 보인다.
    assert.equal((JSON.parse(packageFile.content) as { scripts: Record<string, string> }).scripts.test, "npm run build && node --test --import tsx test/*.test.ts");
    // 기존 선택이 tsconfig.json을 골랐다면 그것도 다시 읽는다.
    if (truncated.files.some((file) => file.path === "tsconfig.json")) {
      assert.equal(augmented.files.find((file) => file.path === "tsconfig.json")?.content, tsconfigText);
    }
    // bootstrap은 호출 지점 바로 뒤, 나머지 기존 선택보다 앞에 온다.
    const callSiteCount = augmented.files.filter((file) => /uses: openai\/codex-action/.test(file.content)).length;
    assert.equal(augmented.files[callSiteCount]!.path, "package.json");
    assert.deepEqual(augmented.files.map((file) => file.evidenceId), augmented.files.map((_, index) => `E${index + 1}`));
    assert.equal(augmented.totalBytes, augmented.files.reduce((sum, file) => sum + file.byteLength, 0));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("기본 pack에 package.json이 없어도 canonical Framework target이면 보강이 package.json을 넣는다", () => {
  const fixture = makeTarget("self-improvement-mvp");
  try {
    const base = selectPlanContext(FRAMEWORK_AI_COST_REQUIREMENT, fixture.target, "erpsarang/self-improvement-mvp", "f".repeat(40));
    const without = repack(base, base.files.filter((file) => file.path !== "package.json" && file.path !== "tsconfig.json"));
    assert.ok(!without.files.some((file) => file.path === "package.json"));

    const augmented = augmentPlanContextWithAiCallSites(FRAMEWORK_AI_COST_REQUIREMENT, fixture.target, without);
    verifyPlanContextPack(augmented);
    const packageFile = augmented.files.find((file) => file.path === "package.json");
    assert.ok(packageFile, "package.json is added from the frozen target");
    assert.equal(packageFile.content, readFileSync(join(fixture.target, "package.json"), "utf8"));
    // tsconfig.json은 기존 선택이 고르지 않았으면 새로 넣지 않는다 (bootstrap 보강은 package.json에 한정).
    assert.ok(!augmented.files.some((file) => file.path === "tsconfig.json"));
    assert.ok(augmented.files.length <= PLAN_CONTEXT_MAX_FILES);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("실제 canonical repo에서 #244 모양의 2바이트 package.json excerpt는 보강 후 test/build script가 보이는 전체 파일이 된다", () => {
  const target = process.cwd();
  const packageText = readFileSync(join(target, "package.json"), "utf8");
  const seed: PlanContextFile = {
    evidenceId: "E1",
    path: "src/self-improvement/plan-context-policy.ts",
    startOffset: 0,
    byteLength: 0,
    digestAlgorithm: "sha256",
    contentDigest: "",
    content: "",
  };
  const policyText = readFileSync(join(target, seed.path), "utf8");
  const base = repack(
    { schemaVersion: 1, kind: "trusted-plan-context-pack", repository: "erpsarang/self-improvement-mvp", sha: "834554908df9796373b2ad010092cc61087cdc82", files: [], totalBytes: 0, digestAlgorithm: "sha256", contextDigest: "0".repeat(64) },
    [
      truncatedExcerpt(seed, policyText, 0, Math.min(policyText.length, 2_000)),
      truncatedExcerpt({ ...seed, path: "package.json" }, packageText, 231, 2),
    ],
  );
  assert.equal(base.files[1]!.content, "ci");

  const augmented = augmentPlanContextWithAiCallSites(FRAMEWORK_AI_COST_REQUIREMENT, target, base);
  verifyPlanContextPack(augmented);
  const packageFile = augmented.files.find((file) => file.path === "package.json");
  assert.ok(packageFile);
  assert.equal(packageFile.content, packageText);
  const scripts = (JSON.parse(packageFile.content) as { scripts: Record<string, string> }).scripts;
  assert.equal(typeof scripts.test, "string");
  assert.equal(typeof scripts.build, "string");
  assert.equal(packageText.slice(packageFile.startOffset, packageFile.startOffset + packageFile.content.length), packageFile.content);
});

test("실제 canonical repo에서 #244 요구는 lifecycle AI 호출 지점을 모두 문맥에 넣는다", () => {
  // 이 repo 자신을 target으로 쓴다. AI 호출 step을 가진 lifecycle workflow(smoke 제외)는 모두 들어가야 한다.
  const target = process.cwd();
  const workflows = readFileSync(join(target, ".github", "workflows", "plan.yml"), "utf8");
  assert.match(workflows, /uses: openai\/codex-action/);

  const candidates = aiCallSiteCandidates(FRAMEWORK_AI_COST_REQUIREMENT, target);
  const paths = candidates.map((file) => file.path);
  for (const lifecycle of ["plan", "plan-implement-worker", "implement", "fix-worker", "semantic-review", "learn", "product-evaluation"]) {
    assert.ok(paths.includes(`.github/workflows/${lifecycle}.yml`), `${lifecycle} must be an AI call-site candidate: ${paths.join(", ")}`);
  }
  const lifecycleOnly = paths.filter((path) => !/-smoke\.yml$/.test(path));
  assert.ok(lifecycleOnly.length <= PLAN_CONTEXT_MAX_FILES - 1, "all lifecycle call sites fit beside one primary slot");
  for (const file of candidates) {
    assert.match(file.content, /uses: openai\/codex-action/, file.path);
    assert.ok(file.byteLength <= AI_CALL_SITE_CONTEXT_MAX_FILE_BYTES, file.path);
    // trusted validatePlan의 frozen repository 검사 (#244 run 35971708433 회귀: byte 오프셋이 문자 인덱스로 쓰였다).
    const frozenText = readFileSync(join(target, file.path), "utf8");
    assert.equal(frozenText.slice(file.startOffset, file.startOffset + file.content.length), file.content, `${file.path} evidence must match frozen repository`);
  }
});
