import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { augmentPlanContextWithBusinessRelations } from "../src/self-improvement/plan-business-context.js";
import { selectPlanContext } from "../src/self-improvement/planner.js";

test("순수 업무 요구만으로 fixture 문자열의 가짜 import를 무시하고 실제 업무 source와 direct test를 보존한다", () => {
  const root = mkdtempSync(join(tmpdir(), "planner-business-context-"));
  try {
    mkdirSync(join(root, "src", "self-improvement"), { recursive: true });
    mkdirSync(join(root, "test"));
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    mkdirSync(join(root, "docs"));

    writeFileSync(
      join(root, "src", "batch-order-analysis.ts"),
      "export interface BatchOrderAnalysisResult { summary: { totalCount: number } }\nexport function analyzeOrderBatch() { return { results: [], summary: { totalCount: 0 } }; }\n",
    );
    writeFileSync(
      join(root, "src", "order-analysis.ts"),
      "export type ReasonCode = 'INVALID_QUANTITY' | 'CUSTOMER_BLOCKED' | 'MATERIAL_BLOCKED' | 'INSUFFICIENT_STOCK';\nexport const SHIP_READY = 'SHIP_READY';\n",
    );
    writeFileSync(
      join(root, "src", "self-improvement", "planner.ts"),
      "export const plannerNoise = 'PLAN context implementationScope summary status';\n",
    );
    writeFileSync(
      join(root, "src", "self-improvement", "plan-candidate-bridge-handler.ts"),
      "export const bridgeNoise = 'candidate bridge provenance exact SHA';\n",
    );
    writeFileSync(
      join(root, "test", "planner-context-policy.test.ts"),
      "const unrelated = 'PLAN context implementationScope workflow provenance'; void unrelated;\n",
    );
    writeFileSync(
      join(root, "test", "framework-self-test.test.ts"),
      [
        "import { selectPlanContext } from '../src/self-improvement/planner.js';",
        "const fixture = \"예외 주문 원인을 사유별로 집계하고 가장 많이 발생한 원인을 보여준다. 기존 주문 판정 결과는 유지한다. import { analyzeOrderBatch } from '../src/batch-order-analysis.js';\";",
        "const repeated = \"예외 주문 원인을 사유별로 집계하고 가장 많이 발생한 원인을 보여준다. 기존 주문 판정 결과는 유지한다.\";",
        "void fixture; void repeated; void selectPlanContext;",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "test", "batch-order-analysis.test.ts"),
      [
        "import { analyzeOrderBatch } from '../src/batch-order-analysis.js';",
        "import { SHIP_READY } from '../src/order-analysis.js';",
        "test('예외 주문 집계', () => {",
        "  const result = analyzeOrderBatch();",
        "  void result; void SHIP_READY;",
        "});",
        "// 기존 주문 판정 결과는 유지한다.",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, ".github", "workflows", "plan.yml"),
      "name: PLAN\non: workflow_dispatch\n",
    );
    writeFileSync(join(root, "package.json"), "{\"scripts\":{\"test\":\"node --test\"}}\n");
    writeFileSync(join(root, "docs", "framework.md"), "PLAN Framework exact SHA provenance\n");

    const requirement = "예외 주문 원인을 사유별로 집계하고 가장 많이 발생한 원인을 보여준다. 기존 주문 판정 결과는 유지한다.";
    const options = { maxFiles: 4, maxBytes: 20_000, maxFileBytes: 4_000 };
    const selectedFirst = selectPlanContext(requirement, root, "example/orders", "a".repeat(40), options);
    const selectedSecond = selectPlanContext(requirement, root, "example/orders", "a".repeat(40), options);
    const selectedPaths = selectedFirst.files.map((file) => file.path);
    const first = augmentPlanContextWithBusinessRelations(requirement, root, selectedFirst, options);
    const second = augmentPlanContextWithBusinessRelations(requirement, root, selectedSecond, options);
    const paths = first.files.map((file) => file.path);

    assert.deepEqual(selectedFirst, selectedSecond);
    assert.ok(selectedPaths.includes("test/framework-self-test.test.ts"), `fixture competitor was not selected: ${selectedPaths.join(", ")}`);
    assert.deepEqual(first, second);
    assert.ok(paths.length >= 2 && paths.length <= 4);
    assert.deepEqual(paths.slice(0, 2), ["src/batch-order-analysis.ts", "test/batch-order-analysis.test.ts"]);
    assert.notEqual(paths[1], "test/framework-self-test.test.ts");
    assert.ok(!requirement.includes("src/"));
    assert.ok(!requirement.includes("analyzeOrderBatch"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exact runtime hint가 있으면 더 높은 lexical relevance의 다른 application 관계가 이를 덮어쓰지 않는다", () => {
  const root = mkdtempSync(join(tmpdir(), "planner-runtime-hint-priority-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "test"));

    writeFileSync(
      join(root, "src", "batch-order-analysis.ts"),
      "export interface BatchOrderAnalysisResult { summary: { totalCount: number } }\nexport function analyzeOrderBatch() { return { results: [], summary: { totalCount: 0 } }; }\n",
    );
    writeFileSync(
      join(root, "src", "order-analysis.ts"),
      "export function analyzeOrder() { return { status: 'SHIP_READY', reasonCodes: [] }; }\n",
    );
    writeFileSync(
      join(root, "test", "batch-order-analysis.test.ts"),
      [
        "import { analyzeOrderBatch } from '../src/batch-order-analysis.js';",
        "test('batch contract', () => { void analyzeOrderBatch; });",
        "// 기존 주문 판정 결과는 유지한다.",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "test", "order-analysis.test.ts"),
      [
        "import { analyzeOrder } from '../src/order-analysis.js';",
        "const business = '예외 주문 원인을 사유별로 묶어서 각각 몇 건인지 보여주고 어떤 사유가 가장 많이 발생했는지 바로 알 수 있으면 좋겠습니다.';",
        "const repeated = '예외 주문 원인을 사유별로 묶어서 각각 몇 건인지 보여주고 어떤 사유가 가장 많이 발생했는지 바로 알 수 있으면 좋겠습니다.';",
        "test('업무 문장 경쟁자', () => { void analyzeOrder; void business; void repeated; });",
        "// 현재 사용하고 있는 각 주문의 출고 가능 예외 판정 결과는 바뀌지 않아야 합니다.",
        "",
      ].join("\n"),
    );

    const requirement = [
      "예외 주문 원인을 사유별로 묶어서 각각 몇 건인지 보여주고 어떤 사유가 가장 많이 발생했는지 바로 알 수 있으면 좋겠습니다.",
      "대상은 `src/batch-order-analysis.ts`의 batch 분석입니다.",
      "현재 사용하고 있는 각 주문의 출고 가능/예외 판정 결과는 바뀌지 않아야 합니다.",
    ].join("\n");
    const options = { maxFiles: 4, maxBytes: 20_000, maxFileBytes: 4_000 };
    const selected = selectPlanContext(requirement, root, "example/orders", "b".repeat(40), options);
    const selectedPaths = selected.files.map((file) => file.path);
    assert.ok(selectedPaths.includes("src/batch-order-analysis.ts"), `explicit runtime was not selected: ${selectedPaths.join(", ")}`);

    const augmented = augmentPlanContextWithBusinessRelations(requirement, root, selected, options);
    const paths = augmented.files.map((file) => file.path);
    assert.deepEqual(paths.slice(0, 2), ["src/batch-order-analysis.ts", "test/batch-order-analysis.test.ts"]);
    assert.notEqual(paths[0], "src/order-analysis.ts");
    assert.notEqual(paths[1], "test/order-analysis.test.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("선택된 business runtime의 직접 App import와 각 direct test를 one-hop으로 함께 보존한다", () => {
  const root = mkdtempSync(join(tmpdir(), "planner-business-direct-imports-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "test"));

    writeFileSync(
      join(root, "src", "app-evidence.ts"),
      [
        "import { analyzeOrderBatch } from './batch-order-analysis.js';",
        "import type { OrderInput } from './order-analysis.js';",
        "export function createEvidence(order: OrderInput) { return analyzeOrderBatch([order]); }",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "src", "batch-order-analysis.ts"),
      [
        "import { analyzeOrder, type OrderInput } from './order-analysis.js';",
        "export function analyzeOrderBatch(orders: OrderInput[]) { return orders.map(analyzeOrder); }",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "src", "order-analysis.ts"),
      [
        "export interface OrderInput { orderId: string; customerId: string; materialId: string; orderQuantity: number; }",
        "export function analyzeOrder(order: OrderInput) { return { orderId: order.orderId, status: 'SHIP_READY' }; }",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "test", "app-evidence.test.ts"),
      [
        "import { createEvidence } from '../src/app-evidence.js';",
        "const requirement = '주문 상세 정보를 실제 업무 수준으로 입력하고 확인한다 주문 아이템 수량 거래처 예상금액 납기일 주문 코멘트';",
        "test('runtime evidence', () => { void createEvidence; void requirement; });",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "test", "batch-order-analysis.test.ts"),
      [
        "import { analyzeOrderBatch } from '../src/batch-order-analysis.js';",
        "test('batch direct test', () => { void analyzeOrderBatch; });",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "test", "order-analysis.test.ts"),
      [
        "import { analyzeOrder } from '../src/order-analysis.js';",
        "test('order direct test', () => { void analyzeOrder; });",
        "",
      ].join("\n"),
    );

    const requirement = [
      "주문 상세 정보를 실제 업무 수준으로 입력하고 확인하고 싶다.",
      "주문 아이템, 수량, 예상금액, 납기일, 거래처, 주문 코멘트를 명확하게 다룬다.",
      "기존 예외 판정 의미는 바꾸지 않는다.",
    ].join(" ");
    const options = { maxFiles: 8, maxBytes: 40_000, maxFileBytes: 8_000 };
    const selected = selectPlanContext(requirement, root, "example/orders", "c".repeat(40), options);
    const augmented = augmentPlanContextWithBusinessRelations(requirement, root, selected, options);
    const paths = augmented.files.map((file) => file.path);

    assert.ok(paths.includes("src/app-evidence.ts"), `missing selected business runtime: ${paths.join(", ")}`);
    assert.ok(paths.includes("test/app-evidence.test.ts"), `missing selected business direct test: ${paths.join(", ")}`);
    assert.ok(paths.includes("src/batch-order-analysis.ts"), `missing direct runtime dependency: ${paths.join(", ")}`);
    assert.ok(paths.includes("test/batch-order-analysis.test.ts"), `missing dependency direct test: ${paths.join(", ")}`);
    assert.ok(paths.includes("src/order-analysis.ts"), `missing direct runtime dependency: ${paths.join(", ")}`);
    assert.ok(paths.includes("test/order-analysis.test.ts"), `missing dependency direct test: ${paths.join(", ")}`);
    assert.ok(paths.length <= 8);
    assert.ok(augmented.totalBytes <= 40_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("business-context 보강이 프로젝트 실행 설정을 Framework noise보다 우선 보존한다", () => {
  const root = mkdtempSync(join(tmpdir(), "planner-business-project-config-"));
  try {
    mkdirSync(join(root, "src", "self-improvement"), { recursive: true });
    mkdirSync(join(root, "test"));

    writeFileSync(
      join(root, "src", "batch-order-analysis.ts"),
      [
        "import { analyzeOrder } from './order-analysis.js';",
        "export function analyzeOrderBatch(orders: unknown[]) { return orders.map(analyzeOrder); }",
        "// 주문 파일 분석 결과에서 정상 주문과 예외 주문 현황, 처리 순서와 조치 내용을 제공한다.",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "src", "order-analysis.ts"),
      [
        "export function analyzeOrder(order: unknown) { return { order, status: 'SHIP_READY' }; }",
        "// 주문의 예외 사유와 확인 조치 내용을 결정한다.",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "test", "batch-order-analysis.test.ts"),
      [
        "import { analyzeOrderBatch } from '../src/batch-order-analysis.js';",
        "test('주문 파일 분석과 처리 순서', () => { void analyzeOrderBatch; });",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "test", "order-analysis.test.ts"),
      [
        "import { analyzeOrder } from '../src/order-analysis.js';",
        "test('주문 예외 사유와 조치', () => { void analyzeOrder; });",
        "",
      ].join("\n"),
    );

    writeFileSync(join(root, "src", "self-improvement", "json-noise.ts"), "export const noise = 'JSON';\n");
    writeFileSync(join(root, "src", "self-improvement", "sap-noise.ts"), "export const noise = 'SAP';\n");
    writeFileSync(join(root, "src", "self-improvement", "erp-noise.ts"), "export const noise = 'ERP';\n");
    writeFileSync(join(root, "src", "self-improvement", "ai-noise.ts"), "export const noise = 'AI';\n");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ type: "module", scripts: { build: "tsc --noEmit", test: "node --test" }, devDependencies: { tsx: "1.0.0", typescript: "1.0.0" } }),
    );

    const requirement = [
      "주문 JSON 파일을 지정해 분석을 실행하고 정상 주문과 예외 주문 현황, 처리 순서와 확인 조치 내용을 보고 싶다.",
      "웹 화면, SAP/ERP 직접 연결, AI 자유문장 생성은 범위에서 제외한다.",
    ].join(" ");
    const options = { maxFiles: 8, maxBytes: 40_000, maxFileBytes: 4_000 };
    const selected = selectPlanContext(requirement, root, "example/orders", "d".repeat(40), options);
    const selectedPaths = selected.files.map((file) => file.path);
    assert.ok(selectedPaths.includes("package.json"), `initial project config was not selected: ${selectedPaths.join(", ")}`);

    const augmented = augmentPlanContextWithBusinessRelations(requirement, root, selected, options);
    const paths = augmented.files.map((file) => file.path);

    assert.ok(paths.includes("src/batch-order-analysis.ts"), `missing business runtime: ${paths.join(", ")}`);
    assert.ok(paths.includes("test/batch-order-analysis.test.ts"), `missing business direct test: ${paths.join(", ")}`);
    assert.ok(paths.includes("package.json"), `project execution config was evicted: ${paths.join(", ")}`);
    assert.ok(paths.length <= 8);
    assert.ok(augmented.totalBytes <= 40_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("business augmentation은 npm run으로 선택된 CLI source/direct test/package 계약을 byte budget에서도 보존한다", () => {
  const root = mkdtempSync(join(tmpdir(), "planner-business-preserve-primary-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "test"));

    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { analyze: "node --import tsx src/order-analysis-cli.ts" } }),
    );
    writeFileSync(
      join(root, "src", "order-analysis-cli.ts"),
      [
        "import { analyzeOrderBatch } from './batch-order-analysis.js';",
        "export function runOrderAnalysisCli() { return analyzeOrderBatch([]); }",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "test", "order-analysis-cli.test.ts"),
      [
        "import { runOrderAnalysisCli } from '../src/order-analysis-cli.js';",
        "test('CLI CSV contract', () => { void runOrderAnalysisCli; });",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "src", "batch-order-analysis.ts"),
      [
        "import { analyzeOrder } from './order-analysis.js';",
        "export function analyzeOrderBatch(orders: unknown[]) { return orders.map(analyzeOrder); }",
        "export const business = '예외 주문 CSV 엑셀 주문번호 자재 수량 거래처 예상금액 납기일 주문 코멘트 예외 사유';",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "test", "batch-order-analysis.test.ts"),
      [
        "import { analyzeOrderBatch } from '../src/batch-order-analysis.js';",
        "const business = '예외 주문 CSV 엑셀 주문번호 자재 수량 거래처 예상금액 납기일 주문 코멘트 예외 사유 '.repeat(80);",
        "test('업무 관계 경쟁자', () => { void analyzeOrderBatch; void business; });",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "src", "order-analysis.ts"),
      "export function analyzeOrder(order: unknown) { return { order, status: 'SHIP_READY' }; }\n",
    );
    writeFileSync(
      join(root, "test", "order-analysis.test.ts"),
      [
        "import { analyzeOrder } from '../src/order-analysis.js';",
        "test('order contract', () => { void analyzeOrder; });",
        "",
      ].join("\n"),
    );

    const requirement = [
      "예외 주문 목록을 엑셀에서 바로 다루고 싶다.",
      "기존 `npm run analyze -- orders.json` 사용 방식은 유지한다.",
      "필요할 때만 `--csv <output.csv>`로 주문번호, 자재, 수량, 거래처, 예상금액, 납기일, 주문 코멘트, 예외 사유를 저장한다.",
    ].join(" ");
    const options = { maxFiles: 6, maxBytes: 14_000, maxFileBytes: 5_000 };
    const selected = selectPlanContext(requirement, root, "example/orders", "e".repeat(40), options);
    const selectedPaths = selected.files.map((file) => file.path);
    assert.ok(selectedPaths.includes("src/order-analysis-cli.ts"), `missing CLI source before augmentation: ${selectedPaths.join(", ")}`);
    assert.ok(selectedPaths.includes("test/order-analysis-cli.test.ts"), `missing CLI test before augmentation: ${selectedPaths.join(", ")}`);
    assert.ok(selectedPaths.includes("package.json"), `missing package before augmentation: ${selectedPaths.join(", ")}`);

    const augmented = augmentPlanContextWithBusinessRelations(requirement, root, selected, options);
    const paths = augmented.files.map((file) => file.path);
    assert.ok(paths.includes("src/order-analysis-cli.ts"), `CLI source was evicted: ${paths.join(", ")}`);
    assert.ok(paths.includes("test/order-analysis-cli.test.ts"), `CLI direct test was evicted: ${paths.join(", ")}`);
    assert.ok(paths.includes("package.json"), `package contract was evicted: ${paths.join(", ")}`);
    assert.ok(paths.includes("src/batch-order-analysis.ts"), `business source was not added: ${paths.join(", ")}`);
    assert.ok(paths.includes("test/batch-order-analysis.test.ts"), `business direct test was not added: ${paths.join(", ")}`);
    assert.ok(paths.length <= 6);
    assert.ok(augmented.totalBytes <= 14_000);

    const withoutDirectTestFiles = selected.files
      .filter((file) => file.path !== "test/order-analysis-cli.test.ts")
      .map((file, index) => ({ ...file, evidenceId: `E${index + 1}` }));
    const withoutDirectTestPayload = {
      schemaVersion: selected.schemaVersion,
      kind: selected.kind,
      repository: selected.repository,
      sha: selected.sha,
      files: withoutDirectTestFiles,
      totalBytes: withoutDirectTestFiles.reduce((sum, file) => sum + file.byteLength, 0),
    };
    const withoutDirectTest = {
      ...withoutDirectTestPayload,
      digestAlgorithm: "sha256" as const,
      contextDigest: createHash("sha256").update(JSON.stringify(withoutDirectTestPayload), "utf8").digest("hex"),
    };
    const recovered = augmentPlanContextWithBusinessRelations(requirement, root, withoutDirectTest, options);
    const recoveredPaths = recovered.files.map((file) => file.path);
    assert.ok(recoveredPaths.includes("src/order-analysis-cli.ts"), `CLI source missing after recovery: ${recoveredPaths.join(", ")}`);
    assert.ok(recoveredPaths.includes("test/order-analysis-cli.test.ts"), `CLI direct test was not recovered: ${recoveredPaths.join(", ")}`);
    assert.ok(recoveredPaths.includes("package.json"), `package contract missing after recovery: ${recoveredPaths.join(", ")}`);
    assert.ok(recovered.totalBytes <= 14_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("브라우저 Web 신규 기능 PLAN은 package.json과 tsconfig.json을 최종 Context Pack에 보존한다", () => {
  const root = mkdtempSync(join(tmpdir(), "planner-web-bootstrap-context-"));
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "test"));

    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ type: "module", scripts: { test: "node --test" }, devDependencies: { typescript: "1.0.0" } }),
    );
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { module: "NodeNext", target: "ES2022" }, include: ["src", "test"] }),
    );
    writeFileSync(
      join(root, "src", "order-analysis.ts"),
      "export function analyzeOrders() { return '주문 CSV 분석 결과'; }\n",
    );
    writeFileSync(
      join(root, "test", "order-analysis.test.ts"),
      [
        "import { analyzeOrders } from '../src/order-analysis.js';",
        "const browserCsvRequirement = '브라우저에서 주문 CSV 파일을 올리고 분석 결과를 확인한다.';",
        "void analyzeOrders; void browserCsvRequirement;",
        "",
      ].join("\n"),
    );

    const requirement = [
      "브라우저에서 주문 CSV 파일을 올리고 분석 결과를 확인하고 싶다.",
      "기존 분석 엔진을 재사용하고 Web 전용으로 판정 로직을 복제하지 않는다.",
      "이번 범위에서 제외: 사용자 로그인/권한, 데이터베이스 저장, 운영 배포/HTTPS 구성.",
    ].join("\n");
    const options = { maxFiles: 4, maxBytes: 16_000, maxFileBytes: 4_000 };
    const selected = selectPlanContext(requirement, root, "example/orders", "e".repeat(40), options);
    const selectedPaths = selected.files.map((file) => file.path);
    assert.ok(selectedPaths.includes("package.json"), `missing package.json: ${selectedPaths.join(", ")}`);
    assert.ok(selectedPaths.includes("tsconfig.json"), `missing tsconfig.json: ${selectedPaths.join(", ")}`);

    const augmented = augmentPlanContextWithBusinessRelations(requirement, root, selected, options);
    const paths = augmented.files.map((file) => file.path);
    assert.ok(paths.includes("package.json"), `package.json was evicted: ${paths.join(", ")}`);
    assert.ok(paths.includes("tsconfig.json"), `tsconfig.json was evicted: ${paths.join(", ")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
