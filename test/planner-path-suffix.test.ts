import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkPlanPathBounds,
  explicitPlanPaths,
  joinedFileNameParts,
  planPathSuffixMatches,
  selectPlanContext,
  validatePlan,
  type PlanContextPack,
} from "../src/self-improvement/planner.js";

// App transportation_guide #2: PLAN run 38885217871은 `static/index.html`, run 38887176176은 `index.html`·`static/app.js`로
// ready PLAN 전체가 거부됐다. 허용 경로는 `src/transportation_guide/static/…`였다(#391 8번과 같은 규칙).

function webFixture() {
  const root = mkdtempSync(join(tmpdir(), "planner-suffix-"));
  const target = join(root, "target");
  mkdirSync(join(target, "src", "guide", "static"), { recursive: true });
  mkdirSync(join(target, "src", "admin", "static"), { recursive: true });
  writeFileSync(join(target, "src", "guide", "server.py"), "def serve(): pass\n");
  writeFileSync(join(target, "src", "guide", "static", "index.html"), "<html>guide</html>\n");
  writeFileSync(join(target, "src", "guide", "static", "app.js"), "// guide\n");
  writeFileSync(join(target, "src", "admin", "static", "index.html"), "<html>admin</html>\n");
  writeFileSync(join(target, "README.md"), "guide\n");
  return { root, target };
}

function contextFor(target: string): PlanContextPack {
  return selectPlanContext("guide 화면 index app server", target, "example/guide", "a".repeat(40), { maxFiles: 8 });
}

function planWith(
  context: PlanContextPack,
  allowedPaths: string[],
  text: { approach?: string[]; changeCandidates?: string[]; testStrategy?: string[]; requiredChanges?: string[] },
) {
  const files = context.files.slice(0, 1);
  return {
    summary: "화면 추가",
    analysis: files.map((file) => ({ evidenceId: file.evidenceId, finding: "서버가 정적 화면을 제공한다." })),
    approach: text.approach ?? ["화면을 만든다"],
    changeCandidates: text.changeCandidates ?? [`${allowedPaths[0]} 변경`],
    acceptanceCriteria: ["화면이 보인다"],
    testStrategy: text.testStrategy ?? ["서버 테스트를 추가한다"],
    questions: [],
    implementationScope: {
      ready: true,
      allowedPaths,
      contextPaths: [],
      requiredChanges: text.requiredChanges ?? ["화면을 구현한다"],
      forbiddenChanges: ["승인 또는 병합 경계를 변경하지 않는다"],
      validationCommands: ["npm test"],
    },
  };
}

const GUIDE_PATHS = ["src/guide/static/index.html", "src/guide/static/app.js"];

test("planPathSuffixMatches는 폴더 경계 기준의 끝부분만 찾고 글자가 같은 경로와 부분 문자열은 제외한다", () => {
  const candidates = ["src/guide/static/index.html", "src/admin/static/index.html", "src/guide/static/app.js"];
  assert.deepEqual(planPathSuffixMatches("static/app.js", candidates), ["src/guide/static/app.js"]);
  assert.deepEqual(planPathSuffixMatches("index.html", candidates), ["src/guide/static/index.html", "src/admin/static/index.html"]);
  assert.deepEqual(planPathSuffixMatches("src/guide/static/app.js", candidates), []);
  assert.deepEqual(planPathSuffixMatches("tatic/app.js", candidates), []);
  assert.deepEqual(planPathSuffixMatches("static/app.j", candidates), []);
});

test("PLAN 문장이 허용 경로 하나의 끝부분만 쓰면 거부하지 않는다 (approach·testStrategy·requiredChanges·changeCandidates)", () => {
  const f = webFixture();
  try {
    const context = contextFor(f.target);
    const plan = planWith(context, GUIDE_PATHS, {
      approach: ["static/index.html: 입력창과 검색 버튼을 만든다", "GET /은 정적 app.js를 서빙한다"],
      changeCandidates: ["static/index.html (수정)", "static/app.js (수정)"],
      testStrategy: ["서버 테스트로 static/app.js 참조가 있는지 검사한다"],
      requiredChanges: ["static/index.html, static/app.js에 화면을 구현한다"],
    });
    const validated = validatePlan(plan, f.target, context);
    // 쓰기 범위는 글자 그대로의 허용 경로뿐이다. 짧은 이름이 범위를 넓히지 않는다.
    assert.deepEqual((validated as { implementationScope: { allowedPaths: string[] } }).implementationScope.allowedPaths, GUIDE_PATHS);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("끝부분이 둘 이상의 경로와 맞으면 모호해서 거부한다", () => {
  const f = webFixture();
  try {
    const context = contextFor(f.target);
    const plan = planWith(context, [...GUIDE_PATHS, "src/admin/static/index.html"], {
      approach: ["index.html에 입력창을 만든다"],
    });
    assert.throws(
      () => validatePlan(plan, f.target, context),
      /matches more than one bounded path: index\.html \(src\/guide\/static\/index\.html, src\/admin\/static\/index\.html\)/,
    );
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("허용 경로 어디의 끝부분도 아닌 경로와 폴더 경계가 아닌 부분 문자열은 계속 범위 밖으로 거부한다", () => {
  const f = webFixture();
  try {
    const context = contextFor(f.target);
    assert.throws(
      () => validatePlan(planWith(context, GUIDE_PATHS, { approach: ["other/index.html도 만든다"] }), f.target, context),
      /exact path outside bounded implementation scope: other\/index\.html/,
    );
    assert.throws(
      () => validatePlan(planWith(context, GUIDE_PATHS, { testStrategy: ["tatic/app.js를 확인한다"] }), f.target, context),
      /exact path outside bounded implementation scope: tatic\/app\.js/,
    );
    assert.throws(
      () => validatePlan(planWith(context, GUIDE_PATHS, { changeCandidates: ["docs/guide.md (신규)"] }), f.target, context),
      /change candidate path is outside allowedPaths: docs\/guide\.md/,
    );
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

// App transportation_guide #2: PLAN run 38979993091은 requiredChanges의 "test_recommend.py/test_server.py 보강"으로 거부됐다.
// 두 파일을 슬래시로 이어 쓴 줄임 표기를 폴더 `test_recommend.py` 안의 파일 하나로 읽었기 때문이다. 요구 본문에는 그 이름이 없었다.

test("이어 쓴 파일 이름은 별개 파일로 풀고, 풀 수 없는 경로는 null이다", () => {
  assert.deepEqual(joinedFileNameParts("test_recommend.py/test_server.py"), ["test_recommend.py", "test_server.py"]);
  assert.deepEqual(joinedFileNameParts("test/test_a.py/test_b.py/test_c.py"), ["test/test_a.py", "test/test_b.py", "test/test_c.py"]);
  assert.equal(joinedFileNameParts("src/guide/static/index.html"), null);
  assert.equal(joinedFileNameParts(".github/workflows/ci.yml"), null);
  // 폴더 이름이 점을 가져도 뒤따르는 것이 모두 파일 이름이 아니면 풀지 않는다.
  assert.equal(joinedFileNameParts("node_modules/next.js/lib/x.ts"), null);
  assert.equal(joinedFileNameParts("2.5/1.25"), null);
});

test("checkPlanPathBounds는 이어 쓴 파일 이름이 각각 범위 안일 때만 받아 준다", () => {
  const allowed = new Set(["test/test_recommend.py", "test/test_server.py", "src/guide/server.py"]);
  assert.deepEqual(checkPlanPathBounds("test_recommend.py/test_server.py", allowed), { kind: "inside" });
  assert.deepEqual(checkPlanPathBounds("test/test_recommend.py/test_server.py", allowed), { kind: "inside" });
  assert.deepEqual(checkPlanPathBounds("test_recommend.py/test_other.py", allowed), { kind: "outside", path: "test_other.py" });
  assert.deepEqual(checkPlanPathBounds("other/test_server.py", allowed), { kind: "outside", path: "other/test_server.py" });
  // 점 있는 실제 폴더는 경로 전체가 범위 안이면 풀기 전에 통과한다.
  assert.deepEqual(checkPlanPathBounds("docs/api.v2/spec.json", new Set(["docs/api.v2/spec.json"])), { kind: "inside" });
});

test("explicitPlanPaths는 이어 쓴 표기를 그대로 한 경로로 돌려주고 대조는 checkPlanPathBounds가 한다", () => {
  assert.deepEqual(explicitPlanPaths(["test_providers.py 신규 작성과 test_recommend.py/test_server.py 보강"]), ["test_recommend.py/test_server.py"]);
});

test("PLAN 문장이 두 테스트 파일을 슬래시로 이어 써도 각각 범위 안이면 거부하지 않고, 하나라도 범위 밖이면 거부한다", () => {
  const f = webFixture();
  try {
    const context = contextFor(f.target);
    const plan = planWith(context, GUIDE_PATHS, {
      requiredChanges: ["static/index.html과 static/app.js 보강", "static/index.html/app.js를 함께 고친다"],
    });
    assert.deepEqual(
      (validatePlan(plan, f.target, context) as { implementationScope: { allowedPaths: string[] } }).implementationScope.allowedPaths,
      GUIDE_PATHS,
    );
    assert.throws(
      () => validatePlan(planWith(context, GUIDE_PATHS, { requiredChanges: ["app.js/other.js 보강"] }), f.target, context),
      /exact path outside bounded implementation scope: other\.js/,
    );
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
