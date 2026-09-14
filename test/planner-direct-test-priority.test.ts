import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { selectPlanContext } from "../src/self-improvement/planner.js";

test("PLAN Context는 여러 test-like 파일이 경쟁해도 명시된 runtime source의 direct test를 보존한다", () => {
  const root = mkdtempSync(join(tmpdir(), "planner-direct-test-"));
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
      "export const plannerNoise = 'PLAN summary status reasonCodes ReasonCode analyzeOrderBatch BatchOrderAnalysisResult';\n",
    );
    writeFileSync(
      join(root, "src", "self-improvement", "plan-candidate-bridge-handler.ts"),
      "export const bridgeNoise = 'summary status reasonCodes SHIP_READY';\n",
    );
    writeFileSync(
      join(root, "test", "planner-context-policy.test.ts"),
      "const unrelated = 'PLAN summary status reasonCodes ReasonCode SHIP_READY analyzeOrderBatch BatchOrderAnalysisResult'; void unrelated;\n",
    );
    writeFileSync(
      join(root, "test", "batch-order-analysis.test.ts"),
      "import { analyzeOrderBatch } from '../src/batch-order-analysis.js';\nconst summary = analyzeOrderBatch().summary;\nvoid summary;\n",
    );
    writeFileSync(
      join(root, ".github", "workflows", "plan.yml"),
      "name: PLAN summary status reasonCodes ReasonCode SHIP_READY\n",
    );
    writeFileSync(join(root, "package.json"), "{\"scripts\":{\"test\":\"node --test\"}}\n");
    writeFileSync(join(root, "docs", "framework.md"), "PLAN summary status reasonCodes\n");

    const requirement = [
      "예외 주문 원인을 집계한다.",
      "대상은 `src/batch-order-analysis.ts`의 `analyzeOrderBatch`와 `BatchOrderAnalysisResult`다.",
      "기존 주문별 `status`와 `reasonCodes`는 바꾸지 않는다.",
      "모든 `ReasonCode`별 건수와 최다 사유를 반환하고 SHIP_READY는 제외한다.",
      "기존 테스트가 계속 통과해야 한다.",
    ].join(" ");

    const options = { maxFiles: 4, maxBytes: 20_000, maxFileBytes: 4_000 };
    const first = selectPlanContext(requirement, root, "example/orders", "a".repeat(40), options);
    const second = selectPlanContext(requirement, root, "example/orders", "a".repeat(40), options);
    const paths = first.files.map((file) => file.path);

    assert.deepEqual(first, second);
    assert.equal(paths.length, 4);
    assert.ok(paths.includes("src/batch-order-analysis.ts"), `missing explicit runtime source: ${paths.join(", ")}`);
    assert.ok(paths.includes("test/batch-order-analysis.test.ts"), `missing direct test: ${paths.join(", ")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
