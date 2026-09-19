import assert from "node:assert/strict";
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
