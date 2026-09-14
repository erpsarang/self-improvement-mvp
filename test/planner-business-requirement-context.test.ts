import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { augmentPlanContextWithBusinessRelations } from "../src/self-improvement/plan-business-context.js";
import { selectPlanContext } from "../src/self-improvement/planner.js";

test("순수 업무 요구만으로 관련 업무 test의 import를 따라 runtime source와 direct test를 함께 보존한다", () => {
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
      join(root, "test", "batch-order-analysis.test.ts"),
      [
        "import { analyzeOrderBatch } from '../src/batch-order-analysis.js';",
        "import { SHIP_READY } from '../src/order-analysis.js';",
        "test('예외 주문 원인을 사유별로 집계하고 가장 많이 발생한 원인을 보여준다', () => {",
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
    const first = augmentPlanContextWithBusinessRelations(requirement, root, selectedFirst, options);
    const second = augmentPlanContextWithBusinessRelations(requirement, root, selectedSecond, options);
    const paths = first.files.map((file) => file.path);

    assert.deepEqual(first, second);
    assert.ok(paths.length >= 2 && paths.length <= 4);
    assert.deepEqual(paths.slice(0, 2), ["src/batch-order-analysis.ts", "test/batch-order-analysis.test.ts"]);
    assert.ok(!requirement.includes("src/"));
    assert.ok(!requirement.includes("analyzeOrderBatch"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
