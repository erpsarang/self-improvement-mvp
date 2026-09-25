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

test("unresolved explicit Issue completion requires one concrete blocker and an empty fail-closed scope", () => {
  const root = mkdtempSync(join(tmpdir(), "planner-completion-blocker-"));
  const target = join(root, "target");
  mkdirSync(target);
  writeFileSync(join(target, "orders.ts"), "export const orders = [];\n");

  try {
    const requirement = "이번 Issue 안에서 orders A → B → C 연결과 실제 E2E까지 완료해야 한다. 일부만 구현하거나 후속 Issue로 미루면 완료가 아니다.";
    const context = selectPlanContext(requirement, target, "example/orders", "a".repeat(40));
    // Assert policy only: echoed requirement/context must not satisfy these checks.
    const policy = createPlanPrompt(requirement, context).split("\n사용자 요구(JSON 문자열):")[0]!;
    assert.match(policy, /현재 Context, 파일 budget 또는 검증 방법 때문에 전체 완료선을 확정할 수 없으면/);
    assert.match(policy, /implementationScope\.ready=false로 하고 결정을 막는 구체적인 실제 blocker 1개를 골라 questions에 Blocking Question 1개만 반환하세요/);
    assert.match(policy, /확정할 수 없는 필수 완료조건과 그 해결에 필요한 정보나 결정을 구체적으로 적으세요/);
    assert.match(policy, /allowedPaths\/contextPaths\/requiredChanges\/forbiddenChanges\/validationCommands는 모두 빈 배열로 반환하세요/);
    assert.match(policy, /명시적 Issue 완료선에 필수인 외부 사실이나 검증 근거가 없으면 위 완료선 정책에 따라 구체적인 blocker로 다루세요/);
    assert.match(policy, /필수 완료조건을 삭제하거나 후속 범위로 미뤄 budget에 맞추지 마세요/);
    assert.match(policy, /전체 완료선을 기존 budget 안에 담을 수 없으면 위 완료선 정책에 따라 implementationScope\.ready=false/);

    const blocked = {
      summary: "필수 실제 E2E 검증 근거가 없어 완료선을 확정할 수 없다",
      analysis: [{ evidenceId: context.files[0]!.evidenceId, finding: "orders 배열 선언만 확인할 수 있다." }],
      approach: ["실제 E2E 검증 근거를 확인한 뒤 전체 완료선의 구현 범위를 확정한다"],
      changeCandidates: ["검증 근거 확인 전에는 변경 범위를 확정하지 않는다"],
      acceptanceCriteria: ["A → B → C 연결과 실제 E2E를 같은 Issue 안에서 완료한다"],
      testStrategy: ["필수 실제 E2E 실행 방법과 성공 판정 근거를 확인해야 한다"],
      questions: ["필수 실제 E2E의 실행 방법과 성공 판정 기준을 확인할 수 있는 근거는 무엇인가요?"],
      implementationScope: {
        ready: false,
        allowedPaths: [],
        contextPaths: [],
        requiredChanges: [],
        forbiddenChanges: [],
        validationCommands: [],
      },
    };
    const normalized = validatePlan(blocked, target, context);
    assert.deepEqual(normalized.questions, blocked.questions);
    assert.deepEqual(normalized.implementationScope, blocked.implementationScope);

    for (const [key, values] of Object.entries({
      allowedPaths: [context.files[0]!.path],
      contextPaths: [context.files[0]!.path],
      requiredChanges: ["A만 구현한다"],
      forbiddenChanges: ["C를 변경하지 않는다"],
      validationCommands: ["npm test"],
    })) {
      assert.throws(
        () => validatePlan({
          ...blocked,
          implementationScope: { ...blocked.implementationScope, [key]: values },
        }, target, context),
        /implementationScope must be empty when ready=false/,
        key,
      );
    }
    assert.throws(
      () => validatePlan({
        ...blocked,
        implementationScope: {
          ...blocked.implementationScope,
          ready: true,
          allowedPaths: [context.files[0]!.path],
          requiredChanges: ["A만 구현한다"],
          validationCommands: ["npm test"],
        },
      }, target, context),
      /implementationScope\.ready requires no blocking questions/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
