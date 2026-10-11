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

test("실제 Issue #7은 본문이 8,192B보다 짧아도 증거 기준으로 R1 오류이고 짧은 이름·주소를 경고한다", () => {
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
  assert.ok(r4.details.some((detail) => detail.includes("짧은 이름") && detail.includes("`index.html`")));
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

test("R4는 변경 범위에 없는 경로 모양과 짧은 이름을 구분해 경고하고, 범위 안 경로는 통과시킨다", () => {
  const body = [
    "`app/index.cds`는 필요 없고 `src/a.ts`는 바꿉니다. `resources/sap-ui-core.js`도 쓰지 않습니다. `test/a.test.ts`",
    "",
    "## 예상 변경 범위",
    "",
    "- `src/a.ts`",
    "- `test/a.test.ts`",
    "- `app/web/index.html`",
    "",
    "README.md는 건드리지 않고 index.html은 새로 만듭니다.",
  ].join("\n");
  const r4 = result(lintRequirement({ title: TITLE, body }), "R4");
  assert.equal(r4.status, "warning");
  const outside = r4.details.find((detail) => detail.startsWith("‘예상 변경 범위’에 없는 경로 모양"));
  assert.ok(outside);
  assert.ok(outside.includes("`app/index.cds`") && outside.includes("`resources/sap-ui-core.js`") && outside.includes("`README.md`"));
  assert.ok(!outside.includes("`src/a.ts`") && !outside.includes("`test/a.test.ts`"));
  const short = r4.details.find((detail) => detail.startsWith("허용 경로의 끝부분만 쓴 짧은 이름"));
  assert.ok(short?.includes("`index.html`"));
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
