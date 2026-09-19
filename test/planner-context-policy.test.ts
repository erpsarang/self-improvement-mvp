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
