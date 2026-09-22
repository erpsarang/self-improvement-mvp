import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyImpactedTestCompanions, augmentPlanContextWithBusinessRelations } from "../src/self-improvement/plan-business-context.js";
import { PLAN_IMPLEMENT_MAX_FILES, selectPlanContext, validatePlan, type PlanContextPack } from "../src/self-improvement/planner.js";

const SHA = "621b8415c52c87facc45b27c7f06a85b7fb3d27b";
const requirement = [
  "[Self-Improvement] 추천 작품을 늘리고 전체 작품을 보기 전까지 중복 추천을 방지하기",
  "src/classics.js에 작품을 추가하고 src/recommendation.js와 src/web.js의 추천 규칙을 미열람 우선으로 바꾼다.",
].join("\n");

/** classic-paragraph-wit #9 1차 PLAN과 같은 구조: 기존 test/web.test.js가 변경 대상 소스를 import한다. */
function appFixture(): { target: string; context: PlanContextPack } {
  const root = mkdtempSync(join(tmpdir(), "planner-companion-"));
  mkdirSync(join(root, "src", "self-improvement"), { recursive: true });
  mkdirSync(join(root, "test", "self-improvement"), { recursive: true });
  const write = (path: string, text: string) => writeFileSync(join(root, path), text);
  write("src/classics.js", "export const classics = [{ id: 'pride-and-prejudice' }, { id: 'a-tale-of-two-cities' }];\n");
  write("src/recommendation.js", "import { classics } from './classics.js';\nexport function getRecommendation(random = Math.random, previousId) { return classics[0]; }\n");
  write("src/web.js", "import { getRecommendation } from './recommendation.js';\nexport function initWeb(document) { getRecommendation(); }\n");
  write("src/app.js", "export function getAppStatus() { return { status: 'READY' }; }\n");
  write("src/self-improvement/planner.ts", "export const planner = 1;\n");
  write("test/web.test.js", "import { getRecommendation } from '../src/recommendation.js';\nimport { initWeb } from '../src/web.js';\ntest('추천 규칙', () => { initWeb({}); getRecommendation(); });\n");
  write("test/app.test.js", "import { getAppStatus } from '../src/app.js';\ntest('status', () => { getAppStatus(); });\n");
  write("test/self-improvement/planner.test.ts", "import { planner } from '../../src/self-improvement/planner.js';\nvoid planner;\n");
  write("package.json", "{ \"name\": \"fixture\", \"type\": \"module\", \"scripts\": { \"test\": \"node --test\" } }\n");
  const selected = selectPlanContext(requirement, root, "erpsarang/classic-paragraph-wit", SHA);
  const context = augmentPlanContextWithBusinessRelations(requirement, root, selected);
  return { target: root, context };
}

function readyPlan(context: PlanContextPack, allowedPaths: readonly string[], extra: Record<string, unknown> = {}) {
  const paths = new Set(context.files.map((file) => file.path));
  for (const path of allowedPaths) assert.equal(paths.has(path), true, `fixture context must contain ${path}`);
  return {
    summary: "추천 작품을 늘리고 미열람 우선 추천으로 바꾼다",
    analysis: [{ evidenceId: context.files[0]!.evidenceId, finding: "추천 규칙 변경 후보" }],
    approach: ["작품 추가와 미열람 우선 추천"],
    changeCandidates: allowedPaths.map((path) => `${path} 변경`),
    acceptanceCriteria: ["세 작품이 서로 다르게 표시된다"],
    testStrategy: ["추천 순회 테스트 추가"],
    questions: [],
    implementationScope: {
      ready: true,
      allowedPaths: [...allowedPaths],
      contextPaths: ["package.json"],
      requiredChanges: ["src/classics.js에 작품을 추가한다"],
      forbiddenChanges: ["승인 경계를 바꾸지 않는다"],
      validationCommands: ["npm test"],
    },
    ...extra,
  };
}

test("Context Pack에 있는 기존 테스트가 변경 대상 소스를 import하면 trusted 단계가 allowedPaths에 추가한다", () => {
  const { target, context } = appFixture();
  assert.equal(context.files.some((file) => file.path === "test/web.test.js"), true, "fixture는 1차 PLAN처럼 test/web.test.js를 Context Pack에 담는다");
  const raw = readyPlan(context, ["src/classics.js", "src/recommendation.js", "src/web.js"]);

  const { plan, companions } = applyImpactedTestCompanions(target, context, raw);
  assert.deepEqual(companions, ["test/web.test.js"]);
  const scope = plan.implementationScope as { allowedPaths: string[]; requiredChanges: string[]; contextPaths: string[] };
  assert.deepEqual(scope.allowedPaths, ["src/classics.js", "src/recommendation.js", "src/web.js", "test/web.test.js"]);
  assert.match(scope.requiredChanges.at(-1)!, /test\/web\.test\.js.*삭제하거나 건너뛰지 않는다/);
  // app.test.js는 변경 대상을 import하지 않으므로 넓히지 않는다.
  assert.equal(scope.allowedPaths.includes("test/app.test.js"), false);

  // 보강된 scope는 그대로 trusted validation을 통과하고 Worker에게 전달된다.
  const validated = validatePlan(plan, target, context);
  assert.deepEqual((validated.implementationScope as { allowedPaths: string[] }).allowedPaths, scope.allowedPaths);
});

test("보강은 결정적이고 멱등이며 이미 포함된 테스트를 중복시키지 않는다", () => {
  const { target, context } = appFixture();
  const raw = readyPlan(context, ["src/web.js", "test/web.test.js"]);
  const first = applyImpactedTestCompanions(target, context, raw);
  assert.deepEqual(first.companions, []);
  assert.strictEqual(first.plan, raw);

  const again = applyImpactedTestCompanions(target, context, applyImpactedTestCompanions(target, context, readyPlan(context, ["src/web.js"])).plan);
  assert.deepEqual(again.companions, []);
});

test("ready=false이거나 scope 모양이 맞지 않으면 손대지 않는다", () => {
  const { target, context } = appFixture();
  const paused = { ...readyPlan(context, ["src/web.js"]), implementationScope: { ready: false, allowedPaths: [], contextPaths: [], requiredChanges: [], forbiddenChanges: [], validationCommands: [] } };
  assert.strictEqual(applyImpactedTestCompanions(target, context, paused).plan, paused);
  const malformed = { ...readyPlan(context, ["src/web.js"]), implementationScope: "broken" };
  assert.strictEqual(applyImpactedTestCompanions(target, context, malformed).plan, malformed);
  assert.strictEqual(applyImpactedTestCompanions(target, context, null).plan, null);
});

test("bounded slot이 모자라면 조용히 넘기지 않고 fail-closed 한다", () => {
  const { target, context } = appFixture();
  const filler = Array.from({ length: PLAN_IMPLEMENT_MAX_FILES - 1 }, (_, index) => `src/new-${index}.js`);
  const raw = readyPlan(context, ["src/web.js"]);
  (raw.implementationScope as { allowedPaths: string[] }).allowedPaths.push(...filler);
  assert.throws(() => applyImpactedTestCompanions(target, context, raw), /cannot hold existing tests that import changed sources/);
});
