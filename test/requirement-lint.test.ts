import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { LEARN_INPUT_BUDGET } from "../src/self-improvement/learn-input-pack.js";
import {
  lintRequirement,
  renderRequirementLintComment,
  REQUIREMENT_LINT_MARKER,
  type LintResult,
  type LintRuleId,
} from "../src/self-improvement/requirement-lint.js";

interface AppIssueFixture {
  readonly source: string;
  readonly issue: number;
  readonly title: string;
  readonly body: string;
}

// purchase-request-app의 실제 [업무 요구] Issue 본문(저장 당시 그대로). #5와 #7은 요구 접수 규칙으로 문제를 겪은 본문이다.
function fixture(issue: number): AppIssueFixture {
  return JSON.parse(readFileSync(`test/fixtures/requirement-lint/app-issue-${issue}.json`, "utf8")) as AppIssueFixture;
}

function result(report: ReturnType<typeof lintRequirement>, id: LintRuleId): LintResult {
  const found = report.results.find((item) => item.id === id);
  assert.ok(found, `${id} result exists`);
  return found;
}

// lint 구현과 독립적으로 LEARN 증거 바이트를 계산한다. 실제 증거는 소문자 64자 hex digest를 담는다.
function evidenceBytes(title: string, body: string): number {
  const digest = "ab".repeat(32);
  return Buffer.byteLength(JSON.stringify({ title, body, digest }), "utf8");
}

const LIMIT = LEARN_INPUT_BUDGET.maxItemBytes;
const TITLE = "[업무 요구] 점검 시험";
const SCOPE_OK = "\n\n## 예상 변경 범위\n\n- `src/a.ts`\n- `test/a.test.ts`\n";

test("실제 Issue #5(본문 11,610B)는 R1 오류이고 측정값이 독립 계산과 같다", () => {
  const issue = fixture(5);
  const report = lintRequirement({ title: issue.title, body: issue.body });
  const r1 = result(report, "R1");
  assert.equal(r1.status, "error");
  assert.equal(Buffer.byteLength(issue.body, "utf8"), 11610);
  assert.ok(r1.summary.includes(`${evidenceBytes(issue.title, issue.body)}바이트`));
  assert.equal(result(report, "R2").summary.includes("opus"), true);
  assert.equal(result(report, "R3").summary, "예상 변경 파일 5개 / 한도 8개");
});

test("실제 Issue #7은 본문이 8,192B보다 짧아도 증거 기준으로 R1 오류이고 주소를 경고한다. 하나의 허용 경로 끝부분인 짧은 이름은 더 이상 경고하지 않는다", () => {
  const issue = fixture(7);
  const bodyBytes = Buffer.byteLength(issue.body, "utf8");
  assert.ok(bodyBytes < LIMIT, "본문 자체는 한도보다 짧다");
  assert.ok(evidenceBytes(issue.title, issue.body) > LIMIT, "증거 기준으로는 한도를 넘는다");
  const report = lintRequirement({ title: issue.title, body: issue.body });
  assert.equal(result(report, "R1").status, "error");
  assert.equal(result(report, "R3").summary, "예상 변경 파일 8개 / 한도 8개");
  assert.equal(result(report, "R3").status, "ok");
  const r4 = result(report, "R4");
  assert.equal(r4.status, "warning");
  // `index.html`은 허용 경로 `app/purchaserequests/webapp/index.html` 하나의 끝부분이다. PLAN 검증이 받아 주므로 경고하지 않는다.
  assert.ok(!r4.details.some((detail) => detail.includes("모호한 이름")));
  assert.ok(r4.details.some((detail) => detail.includes("주소(URL) 모양 2건")));
});

test("실제 Issue #11(PLAN 1회 통과, LEARN 성공)은 오류와 경고가 없고 sonnet이다", () => {
  const issue = fixture(11);
  const report = lintRequirement({ title: issue.title, body: issue.body });
  assert.equal(report.errorCount, 0);
  assert.equal(report.warningCount, 0);
  assert.equal(result(report, "R1").status, "ok");
  assert.equal(result(report, "R2").summary, "PLAN 모델: sonnet (복잡한 요구 체크 없음)");
  assert.equal(result(report, "R3").summary, "예상 변경 파일 4개 / 한도 8개");
  assert.equal(result(report, "R4").status, "ok");
});

test("R1 경계: 증거가 정확히 한도이면 경고, 1바이트 넘으면 오류, 90% 미만이면 통과", () => {
  const base = evidenceBytes(TITLE, "");
  const exact = "a".repeat(LIMIT - base);
  assert.equal(evidenceBytes(TITLE, exact), LIMIT);
  assert.equal(result(lintRequirement({ title: TITLE, body: exact }), "R1").status, "warning");
  assert.equal(result(lintRequirement({ title: TITLE, body: `${exact}a` }), "R1").status, "error");
  assert.equal(result(lintRequirement({ title: TITLE, body: "a".repeat(Math.floor(LIMIT * 0.9) - base - 1) }), "R1").status, "ok");
});

test("R1은 한글을 3바이트로, 줄바꿈과 따옴표의 이스케이프를 더해 센다", () => {
  const body = `"가"\n`.repeat(900);
  const expected = evidenceBytes(TITLE, body);
  assert.ok(expected > Buffer.byteLength(body, "utf8") + Buffer.byteLength(TITLE, "utf8"), "이스케이프로 더 커진다");
  const r1 = result(lintRequirement({ title: TITLE, body }), "R1");
  assert.ok(r1.summary.includes(`${expected}바이트`));
  assert.equal(r1.status, expected > LIMIT ? "error" : expected >= LIMIT * 0.9 ? "warning" : "ok");
});

test("R2는 복잡한 요구 체크박스 한 줄이 체크된 경우에만 opus를 알린다", () => {
  const checked = lintRequirement({ title: TITLE, body: "## 복잡한 요구인가요? (선택)\n\n- [x] 복잡한 요구입니다\n" });
  const unchecked = lintRequirement({ title: TITLE, body: "## 복잡한 요구인가요? (선택)\n\n- [ ] 복잡한 요구입니다\n" });
  assert.equal(result(checked, "R2").summary.startsWith("PLAN 모델: opus"), true);
  assert.equal(result(unchecked, "R2").summary.startsWith("PLAN 모델: sonnet"), true);
  assert.equal(result(checked, "R2").status, "info");
});

test("R3은 목록 항목의 파일만 세고 문장 속에 나열한 파일은 세지 않는다", () => {
  const body = [
    "## 예상 변경 범위",
    "",
    "- `src/a.ts`",
    "- `ui5.yaml` (새 파일)",
    "",
    "위 파일 외에는 바꾸지 않습니다. `package.json`, `package-lock.json`, `FRAMEWORK.md`는 그대로 둡니다.",
    "",
    "## 다음 절",
    "",
    "- `src/not-counted.ts`",
  ].join("\n");
  assert.equal(result(lintRequirement({ title: TITLE, body }), "R3").summary, "예상 변경 파일 2개 / 한도 8개");
});

test("R3은 9개부터 경고하고, 8개면 통과한다", () => {
  const list = (n: number) => `## 예상 변경 범위\n\n${Array.from({ length: n }, (_, i) => `- \`src/f${i}.ts\``).join("\n")}\n`;
  assert.equal(result(lintRequirement({ title: TITLE, body: list(8) }), "R3").status, "ok");
  const nine = result(lintRequirement({ title: TITLE, body: list(9) }), "R3");
  assert.equal(nine.status, "warning");
  assert.ok(nine.details[0]!.startsWith("1개를 줄이거나"));
});

test("R3은 package.json이 있고 lock이 없을 때 8개이면 경고하고, 7개이거나 lock이 있으면 통과한다", () => {
  const withPackage = (others: number, lock: boolean) => [
    "## 예상 변경 범위",
    "",
    "- `package.json`",
    ...(lock ? ["- `package-lock.json`"] : []),
    ...Array.from({ length: others }, (_, i) => `- \`src/f${i}.ts\``),
  ].join("\n");
  const full = result(lintRequirement({ title: TITLE, body: withPackage(7, false) }), "R3");
  assert.equal(full.status, "warning");
  assert.ok(full.details[0]!.includes("package-lock.json"));
  assert.equal(result(lintRequirement({ title: TITLE, body: withPackage(6, false) }), "R3").status, "ok");
  assert.equal(result(lintRequirement({ title: TITLE, body: withPackage(6, true) }), "R3").status, "ok");
});

test("R3와 R4는 ‘예상 변경 범위’ 절이 없으면 정보로 남고 주소만 점검한다", () => {
  const none = lintRequirement({ title: TITLE, body: "목표만 적은 본문입니다." });
  assert.equal(result(none, "R3").status, "info");
  assert.equal(result(none, "R4").status, "info");
  const url = lintRequirement({ title: TITLE, body: "접속은 http://localhost:8080/index.html 입니다." });
  assert.equal(result(url, "R4").status, "warning");
});

test("R4는 변경 범위에 없는 경로 모양과 모호한 이름을 구분해 경고하고, 범위 안 경로와 하나의 경로 끝부분인 이름은 통과시킨다", () => {
  const body = [
    "`app/index.cds`는 필요 없고 `src/a.ts`는 바꿉니다. `resources/sap-ui-core.js`도 쓰지 않습니다. `test/a.test.ts`",
    "",
    "## 예상 변경 범위",
    "",
    "- `src/a.ts`",
    "- `test/a.test.ts`",
    "- `app/web/index.html`",
    "- `app/admin/index.html`",
    "- `app/web/app.js`",
    "",
    "README.md는 건드리지 않고 index.html은 새로 만듭니다. web/app.js와 admin/index.html은 그대로 둡니다.",
  ].join("\n");
  const r4 = result(lintRequirement({ title: TITLE, body }), "R4");
  assert.equal(r4.status, "warning");
  const outside = r4.details.find((detail) => detail.startsWith("‘예상 변경 범위’에 없는 경로 모양"));
  assert.ok(outside);
  assert.ok(outside.includes("`app/index.cds`") && outside.includes("`resources/sap-ui-core.js`") && outside.includes("`README.md`"));
  assert.ok(!outside.includes("`src/a.ts`") && !outside.includes("`test/a.test.ts`"));
  // `index.html`은 `app/web/index.html`과 `app/admin/index.html` 둘의 끝부분이라 모호하다.
  const ambiguous = r4.details.find((detail) => detail.startsWith("‘예상 변경 범위’의 여러 경로 끝부분과 맞는 모호한 이름"));
  assert.ok(ambiguous?.includes("`index.html`"));
  assert.ok(ambiguous);
  // `web/app.js`, `admin/index.html`은 각각 정확히 하나의 경로 끝부분이므로 어디에도 나오지 않는다.
  assert.ok(!outside.includes("web/app.js") && !outside.includes("admin/index.html"));
  assert.ok(!ambiguous.includes("web/app.js") && !ambiguous.includes("admin/index.html"));
});

test("R4는 모든 경로가 범위 안이고 주소가 없으면 통과한다", () => {
  const report = lintRequirement({ title: TITLE, body: `\`src/a.ts\`를 고칩니다.${SCOPE_OK}` });
  assert.equal(result(report, "R4").status, "ok");
  assert.equal(report.errorCount + report.warningCount, 0);
});

test("댓글은 marker를 갖고 본문 문장을 되풀이하지 않으며 경고 수를 알린다", () => {
  const secret = "이 문장은 댓글에 나오면 안 됩니다";
  const body = `${secret} \`app/other.ts\` http://example.test/x${SCOPE_OK}`;
  const comment = renderRequirementLintComment(lintRequirement({ title: TITLE, body }));
  assert.ok(comment.startsWith(REQUIREMENT_LINT_MARKER));
  assert.ok(!comment.includes(secret));
  assert.ok(!comment.includes("example.test"));
  assert.ok(comment.includes("`app/other.ts`"));
  assert.ok(comment.includes("경고 1건"));
  assert.ok(comment.includes("본문 수정만으로는 PLAN이 다시 시작되지 않습니다"));
});

test("고칠 점이 없으면 댓글이 그렇게 말한다", () => {
  const issue = fixture(11);
  const comment = renderRequirementLintComment(lintRequirement({ title: issue.title, body: issue.body }));
  assert.ok(comment.includes("고칠 점이 없습니다."));
  assert.ok(!comment.includes("### 고칠 점"));
});

test("한도와 정규식은 검증기 모듈에서 가져오고 lint 안에 다시 적지 않는다", () => {
  const source = readFileSync("src/self-improvement/requirement-lint.ts", "utf8");
  assert.ok(!/\b8[_,]?192\b/.test(source), "8192를 다시 적지 않는다");
  assert.ok(!/EXPLICIT_PLAN_PATH\s*=/.test(source), "EXPLICIT_PLAN_PATH를 다시 정의하지 않는다");
  assert.ok(!/PLAN_IMPLEMENT_MAX_FILES\s*=/.test(source), "PLAN_IMPLEMENT_MAX_FILES를 다시 정의하지 않는다");
  assert.ok(/from "\.\/learn-input-pack\.js"/.test(source) && /from "\.\/planner\.js"/.test(source));
});

test("PLAN_IMPLEMENT_MAX_FILES는 src 전체에서 한 곳에서만 정의된다", () => {
  const definitions = readdirSync("src/self-improvement")
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => /\b(?:export\s+)?const\s+PLAN_IMPLEMENT_MAX_FILES\b/.test(readFileSync(`src/self-improvement/${name}`, "utf8")));
  assert.deepEqual(definitions, ["planner.ts"]);
});

test("코드 블록 안의 # 줄은 ‘예상 변경 범위’ 절을 끊지 않는다", () => {
  const body = [
    "## 예상 변경 범위",
    "",
    "- `src/a.ts`",
    "",
    "```sh",
    "# 이 줄은 제목이 아니라 주석이다",
    "npm test",
    "```",
    "",
    "- `src/b.ts`",
    "",
    "## 다음 절",
    "- `src/not-counted.ts`",
  ].join("\n");
  const report = lintRequirement({ title: TITLE, body });
  assert.equal(result(report, "R3").summary, "예상 변경 파일 2개 / 한도 8개");
  // 범위 밖 절의 파일만 경고하고, 코드 블록 뒤에 이어진 `src/b.ts`는 범위 안으로 읽는다.
  const r4 = result(report, "R4");
  assert.equal(r4.status, "warning");
  assert.ok(r4.details[0]!.includes("`src/not-counted.ts`"));
  assert.ok(!r4.details[0]!.includes("`src/b.ts`") && !r4.details[0]!.includes("`src/a.ts`"));
});

test("‘변경 범위’ 제목이 코드 블록 안에만 있으면 절로 보지 않는다", () => {
  const body = ["```md", "## 예상 변경 범위", "- `src/a.ts`", "```"].join("\n");
  assert.equal(result(lintRequirement({ title: TITLE, body }), "R3").status, "info");
});

test("목록 항목 한 줄의 여러 파일과 앞머리 설명이 있어도 모두 변경 범위로 읽는다", () => {
  const body = [
    "본문에서 `src/b.ts`와 `src/c.ts`를 언급합니다.",
    "",
    "## 예상 변경 범위",
    "",
    "- `src/a.ts` 와 `src/b.ts`",
    "- 수정: `src/c.ts`",
    "1. `test/d.test.ts` (새 파일)",
  ].join("\n");
  const report = lintRequirement({ title: TITLE, body });
  assert.equal(result(report, "R3").summary, "예상 변경 파일 4개 / 한도 8개");
  assert.equal(result(report, "R4").status, "ok");
});

test("절은 있는데 읽을 수 있는 파일 목록이 없으면 0개 통과가 아니라 점검하지 않았다고 알린다", () => {
  const body = ["본문에 `src/a.ts`가 나옵니다.", "", "## 예상 변경 범위", "", "Dockerfile 하나만 바꿉니다."].join("\n");
  const report = lintRequirement({ title: TITLE, body });
  const r3 = result(report, "R3");
  assert.equal(r3.status, "info");
  assert.ok(r3.summary.includes("파일 목록을 읽지 못했습니다"));
  assert.equal(result(report, "R4").status, "info");
  assert.equal(report.warningCount, 0);
});

test("R2는 사람이 쓴 본문이 아니면 복잡한 요구 체크가 있어도 sonnet이라고 알린다", () => {
  const body = "- [x] 복잡한 요구입니다\n";
  assert.ok(result(lintRequirement({ title: TITLE, body, authoredByHuman: false }), "R2").summary.startsWith("PLAN 모델: sonnet"));
  assert.ok(result(lintRequirement({ title: TITLE, body, authoredByHuman: true }), "R2").summary.startsWith("PLAN 모델: opus"));
  assert.ok(result(lintRequirement({ title: TITLE, body }), "R2").summary.startsWith("PLAN 모델: opus"));
});

test("경로 추출은 검증기의 explicitPlanPaths를 쓰고 공유 정규식을 직접 쓰지 않는다", () => {
  const source = readFileSync("src/self-improvement/requirement-lint.ts", "utf8");
  assert.ok(/import \{[^}]*\bexplicitPlanPaths\b[^}]*\} from "\.\/planner\.js"/.test(source));
  assert.ok(!/\bEXPLICIT_PLAN_PATH\b/.test(source.replace(/^\/\/.*$/gm, "")), "코드에서 EXPLICIT_PLAN_PATH를 직접 쓰지 않는다");
});
