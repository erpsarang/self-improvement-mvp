import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPlanPrompt,
  selectPlanContext,
  validatePlan,
} from "../src/self-improvement/planner.js";

test("PLAN prompt keeps questions blocking-only and preserves fail-closed ready validation", () => {
  const root = mkdtempSync(join(tmpdir(), "planner-blocking-contract-"));
  const target = join(root, "target");
  mkdirSync(target);
  writeFileSync(join(target, "orders.ts"), "export const orders = [];\n");

  try {
    const context = selectPlanContext(
      "orders 집계 기능을 구현한다",
      target,
      "example/orders",
      "a".repeat(40),
    );
    const prompt = createPlanPrompt("orders 집계 기능을 구현한다", context);

    assert.match(prompt, /blocking question만 작성하세요/);
    assert.match(prompt, /비차단 확인\/참고 사항은 questions에 넣지 말고/);
    assert.match(prompt, /implementationScope\.ready=true이면 questions는 반드시 빈 배열 \[\]이어야 합니다/);
    assert.match(prompt, /blocking question이 하나라도 있으면 implementationScope\.ready=false/);

    const plan = {
      summary: "orders 집계 기능 추가",
      analysis: [{ evidenceId: context.files[0]!.evidenceId, finding: "집계 구현 후보 파일이다." }],
      approach: ["집계 로직을 추가한다"],
      changeCandidates: [`${context.files[0]!.path} 변경`],
      acceptanceCriteria: ["집계 결과를 확인할 수 있다"],
      testStrategy: ["npm test로 검증한다"],
      questions: ["비차단 확인 사항"],
      implementationScope: {
        ready: true,
        allowedPaths: [context.files[0]!.path],
        contextPaths: [],
        requiredChanges: ["집계 로직을 추가한다"],
        forbiddenChanges: [],
        validationCommands: ["npm test"],
      },
    };

    assert.throws(
      () => validatePlan(plan, target, context),
      /implementationScope\.ready requires no blocking questions/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
