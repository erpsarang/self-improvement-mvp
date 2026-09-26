import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { needsHumanOutputPlanContext, planImpactTestScopeGuidance } from "../src/self-improvement/plan-context-policy.js";
import { selectPlanContext } from "../src/self-improvement/planner.js";

test("business result fields status/summary do not activate human-output context and direct test stays visible", () => {
  const root = mkdtempSync(join(tmpdir(), "planner-business-context-"));
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "test"));
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });

    writeFileSync(
      join(root, "src", "batch-order-analysis.ts"),
      "export function analyzeOrderBatch() { return { results: [], summary: { totalCount: 0 } }; }\n",
    );
    writeFileSync(
      join(root, "test", "batch-order-analysis.test.ts"),
      "import { analyzeOrderBatch } from '../src/batch-order-analysis.js';\nconst summary = analyzeOrderBatch().summary;\nvoid summary;\n",
    );
    writeFileSync(
      join(root, ".github", "workflows", "plan.yml"),
      "name: unrelated human output\nstatus summary comment user\n",
    );

    const requirement = "예외 주문 사유를 집계한다. src/batch-order-analysis.ts의 반환 summary를 확장하되 기존 주문별 status와 reasonCodes는 바꾸지 않고 기존 테스트가 계속 통과해야 한다.";
    assert.equal(needsHumanOutputPlanContext(requirement), false);

    const context = selectPlanContext(requirement, root, "example/orders", "a".repeat(40), {
      maxFiles: 4,
      maxBytes: 16_000,
      maxFileBytes: 4_000,
    });
    const paths = context.files.map((file) => file.path);
    assert.ok(paths.includes("src/batch-order-analysis.ts"), `missing runtime source: ${paths.join(", ")}`);
    assert.ok(paths.includes("test/batch-order-analysis.test.ts"), `missing existing direct test: ${paths.join(", ")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit human-facing requirement still activates human-output context", () => {
  assert.equal(needsHumanOutputPlanContext("실행 상태를 사람이 이해하기 쉽게 표시하고 다음 행동을 안내한다."), true);
  assert.equal(needsHumanOutputPlanContext("Add a user-facing issue comment with the next action."), true);
});
test("브라우저 App UI 표시 요구는 Framework human-output context를 활성화하지 않는다", () => {
  const requirement = [
    "브라우저에서 주문 CSV 파일을 올리고 분석 결과를 화면에 표시하고 싶다.",
    "잘못된 CSV 입력이면 사용자가 이해할 수 있는 오류 메시지를 화면에 표시한다.",
    "기존 CLI의 JSON/CSV 입력 기능은 그대로 유지한다.",
  ].join("\n");
  assert.equal(needsHumanOutputPlanContext(requirement), false);
});

test("PLAN guidance allows only actually impacted existing tests into write scope", () => {
  const guidance = planImpactTestScopeGuidance();
  assert.match(guidance, /수정이 실제로 필요할 때만/);
  assert.match(guidance, /exact path/);
  assert.match(guidance, /allowedPaths/);
  assert.match(guidance, /무관한 테스트로 범위를 넓히지 마세요/);
});


test("provenance의 사용자/Human/Issue 문구만으로 human-output context를 활성화하지 않는다", () => {
  const requirement = [
    "## 사용자 요구",
    "주문마다 주문 아이템, 수량, 예상금액, 납기일, 거래처, 주문 코멘트를 명확하게 입력하고 확인할 수 있어야 한다.",
    "Human이 Improvement Candidate를 채택하여 실제 App Requirement로 승격한다.",
    "이 Issue는 새로운 User Requirement다.",
    "다음 단계는 Read-only AI PLAN이다.",
    "PLAN 이후 Human exact PLAN-승인을 거친다.",
  ].join("\n");

  assert.equal(needsHumanOutputPlanContext(requirement), false);
});

test("실제 human-facing 출력 동사가 있을 때만 human-output context를 활성화한다", () => {
  assert.equal(needsHumanOutputPlanContext("사용자에게 현재 처리 상태를 표시한다."), true);
  assert.equal(needsHumanOutputPlanContext("사람이 이해할 수 있도록 다음 행동을 안내한다."), true);
  assert.equal(needsHumanOutputPlanContext("Issue에 승인 결과 코멘트를 남긴다."), true);
  assert.equal(needsHumanOutputPlanContext("Add a human-facing message with the next action."), true);
  assert.equal(needsHumanOutputPlanContext("The Issue stores status and summary fields."), false);
  assert.equal(needsHumanOutputPlanContext("주문 코멘트를 데이터 모델에 보존한다."), false);
  assert.equal(needsHumanOutputPlanContext("Preserve the order comment field in the model."), false);
});


test("README/Product Guide 문서화 요구는 기존 README와 package 실행 계약을 bounded Context에 우선 보존한다 (#286)", () => {
  const root = mkdtempSync(join(tmpdir(), "planner-documentation-context-"));
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "test"));
    writeFileSync(join(root, "README.md"), "# 초기 MVP\n주문을 분석합니다.\n");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { test: "node --test", build: "tsc", dev: "vite", analyze: "node src/order-analysis-cli.ts" } }),
    );
    writeFileSync(
      join(root, "src", "order-csv.ts"),
      "export const csv = '주문 CSV 고객 기준 자재 재고 기준 누락 분석 availableQuantity';\n",
    );
    writeFileSync(
      join(root, "src", "order-analysis-cli.ts"),
      "export const cli = 'CLI 주문 분석 실행 사용법';\n",
    );
    writeFileSync(
      join(root, "src", "web-main.ts"),
      "export const web = '브라우저 CSV 양식 다운로드 결과 예외 CSV';\n",
    );
    writeFileSync(
      join(root, "test", "order-csv.test.ts"),
      "import { csv } from '../src/order-csv.js'; test('CSV 분석', () => void csv);\n",
    );

    const requirement = [
      "[업무 요구] README를 현재 구현과 제품 비전을 반영한 Product Guide로 재작성하고 싶다",
      "현재 구현 기능, 설치방법, 실행방법, CSV 사용법과 결과 해석을 실제 코드와 테스트 근거로 정확히 설명한다.",
      "미래 비전과 현재 구현을 분리하고 README 외 제품 기능은 변경하지 않는다.",
    ].join("\n");
    const pack = selectPlanContext(requirement, root, "example/orders", "f".repeat(40), {
      maxFiles: 4,
      maxBytes: 16_000,
      maxFileBytes: 4_000,
    });
    const paths = pack.files.map((file) => file.path);

    assert.deepEqual(paths.slice(0, 2), ["README.md", "package.json"]);
    assert.ok(paths.some((path) => path.startsWith("src/")), `missing implementation evidence: ${paths.join(", ")}`);
    assert.ok(paths.length <= 4);
    assert.ok(pack.totalBytes <= 16_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("README 사용법 문서화 요구는 CSV 입력·기준·양식·웹 계약을 일반 분석 테스트보다 먼저 보존한다 (#288)", () => {
  const root = mkdtempSync(join(tmpdir(), "planner-documentation-contract-context-"));
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "test"));
    writeFileSync(join(root, "README.md"), "# 초기 MVP\n");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { test: "node --test", build: "tsc", dev: "vite" } }),
    );
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
    writeFileSync(
      join(root, "src", "order-csv.ts"),
      "export const csv = 'CSV 파싱 검증 예외 CSV 출력';\n",
    );
    writeFileSync(
      join(root, "src", "csv-decision-reference.ts"),
      "export const reference = '고객 자재 기준 조회 여러 누락 기준';\n",
    );
    writeFileSync(
      join(root, "src", "order-csv-template.ts"),
      "export const template = '업로드 기준 주문 CSV 양식';\n",
    );
    writeFileSync(
      join(root, "src", "web-main.ts"),
      "export const web = '브라우저 업로드 분석 결과 다운로드';\n",
    );
    writeFileSync(
      join(root, "src", "batch-order-analysis.ts"),
      "export const batch = '주문 분석 결과 우선순위';\n",
    );
    writeFileSync(
      join(root, "test", "batch-order-analysis.test.ts"),
      "import { batch } from '../src/batch-order-analysis.js'; test('batch', () => void batch);\n",
    );

    const requirement = [
      "[업무 요구] README를 현재 구현과 제품 비전을 반영한 Product Guide로 재작성하고 싶다",
      "설치·웹 실행과 세 CSV 분석 방식, CSV 파싱·검증, 업로드 기준 조회, 여러 누락 기준 사전점검을 설명한다.",
      "주문 CSV 양식 활용과 예외 CSV 다운로드/출력 사용법을 실제 구현 근거로 정확히 안내한다.",
      "README 외 제품 기능은 변경하지 않는다.",
    ].join("\n");
    const pack = selectPlanContext(requirement, root, "example/orders", "e".repeat(40), {
      maxFiles: 8,
      maxBytes: 32_000,
      maxFileBytes: 4_000,
    });
    const paths = pack.files.map((file) => file.path);

    for (const path of [
      "README.md",
      "package.json",
      "src/order-csv.ts",
      "src/csv-decision-reference.ts",
      "src/order-csv-template.ts",
      "src/web-main.ts",
    ]) {
      assert.ok(paths.includes(path), `missing documentation contract: ${path}; got ${paths.join(", ")}`);
    }
    assert.ok(!paths.includes("tsconfig.json"), `documentation contract slot was consumed by tsconfig: ${paths.join(", ")}`);
    assert.ok(paths.length <= 8);
    assert.ok(pack.totalBytes <= 32_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
