import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { COMPLEX_REQUIREMENT_CHECKBOX, REQUIREMENT_LINT_MARKER } from "../src/self-improvement/requirement-lint.js";

const workflow = await readFile(".github/workflows/requirement-lint.yml", "utf8");
const plan = await readFile(".github/workflows/plan.yml", "utf8");

function job(name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `${name} job exists`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z_]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

test("점검은 업무 요구 Issue의 opened/edited/reopened와 수동 실행에서만 시작한다", () => {
  assert.match(workflow, /issues:\s*\n\s*types: \[opened, edited, reopened\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /issue_number:\s*\n\s*description: [^\n]+\n\s*required: true/);
  assert.match(workflow, /post_comment:[\s\S]*?default: true[\s\S]*?type: boolean/);
});

test("lint job은 PLAN과 같은 조건(제목 prefix, OWNER/MEMBER/COLLABORATOR, 기본 브랜치 수동 실행)을 지킨다", () => {
  const condition = job("lint").split("\n    runs-on:", 1)[0] ?? "";
  assert.match(
    condition,
    /github\.event_name == 'issues' &&\s+startsWith\(github\.event\.issue\.title, '\[업무 요구\]'\) &&\s+contains\(fromJSON\('\["OWNER","MEMBER","COLLABORATOR"\]'\), github\.event\.issue\.author_association\)\)/,
  );
  assert.match(condition, /github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/);
  assert.doesNotMatch(condition, /CONTRIBUTOR|FIRST_TIME|NONE/);
  assert.equal((condition.match(/github\.event_name == 'issues'/g) ?? []).length, 1);
});

test("권한은 최소다: 전체 비움, lint는 읽기만, issues: write는 댓글 job 하나뿐이다", () => {
  assert.match(workflow, /\npermissions: \{\}\n/);
  assert.match(job("lint"), /permissions:\s*\n\s*contents: read\n\s*issues: read\n/);
  assert.doesNotMatch(job("lint"), /:\s*write\b/);
  assert.match(job("comment"), /permissions:\s*\n\s*issues: write\n/);
  assert.equal((workflow.match(/^\s+[a-z-]+: write$/gm) ?? []).length, 1);
});

test("AI, secret, executor, 대상 코드 실행이 없다", () => {
  assert.doesNotMatch(workflow, /secrets\./);
  assert.doesNotMatch(workflow, /EXECUTOR|anthropic|claude|codex|openai/i);
  assert.doesNotMatch(workflow, /workflow_run|pull_request_target/);
  // Issue 본문은 쓰기 권한 없는 lint job의 파일로만 다룬다. 댓글 job은 checkout도 하지 않는다.
  assert.doesNotMatch(job("comment"), /actions\/checkout/);
  assert.doesNotMatch(workflow, /\$\{\{\s*github\.event\.issue\.(body|title)\s*\}\}/);
});

test("댓글은 한 개를 marker로 찾아 갱신하고, 봇이 쓴 댓글만 대상으로 삼는다", () => {
  assert.ok(workflow.includes(`const MARKER = '${REQUIREMENT_LINT_MARKER}';`));
  assert.match(workflow, /const BOT = 'github-actions\[bot\]'/);
  assert.match(workflow, /comment\.user\?\.login === BOT && \(comment\.body \?\? ''\)\.startsWith\(MARKER\)/);
  assert.match(workflow, /updateComment/);
  assert.match(workflow, /createComment/);
  assert.match(workflow, /body\.startsWith\(MARKER\)/);
});

test("점검 결과는 PLAN을 막는 경로가 없다: 별도 workflow이고 plan.yml은 이 workflow를 참조하지 않는다", () => {
  assert.match(workflow, /^name: Requirement Lint$/m);
  assert.doesNotMatch(plan, /requirement-lint|Requirement Lint|REQUIREMENT_LINT/);
  const code = workflow.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
  assert.doesNotMatch(code, /needs:\s*\[?plan\b|workflow_run|workflows:\s*\[?\s*["']?Read-only AI PLAN/);
});

test("R2의 복잡한 요구 정규식은 plan.yml의 정의와 같다", () => {
  const literal = /const complexRequirement = (\/.+\/[a-z]*)\.test\(issue\.body\);/.exec(plan)?.[1];
  assert.ok(literal, "plan.yml에서 정규식 리터럴을 찾는다");
  assert.equal(literal, String(COMPLEX_REQUIREMENT_CHECKBOX));
});

test("멀티라인 출력은 임의 delimiter를 쓰고 댓글 본문을 스크립트에 직접 끼워 넣지 않는다", () => {
  assert.match(workflow, /delimiter="REQUIREMENT_LINT_\$\(od -An -N16/);
  assert.match(workflow, /LINT_COMMENT: \$\{\{ needs\.lint\.outputs\.comment \}\}/);
  const commentScript = job("comment").split("script: |")[1] ?? "";
  assert.ok(commentScript.length > 0, "댓글 job에 script가 있다");
  assert.doesNotMatch(commentScript, /\$\{\{/);
});

test("같은 Issue의 점검은 차례로 돌고, 건너뛰는 실행이 진행 중인 점검을 취소하지 않는다", () => {
  assert.match(workflow, /concurrency:\s*\n\s*group: requirement-lint-/);
  assert.doesNotMatch(workflow, /cancel-in-progress:\s*true/);
});

test("사람이 쓴 본문인지 판단해 R2에 넘기고, 입력 파일로만 전달한다", () => {
  assert.match(workflow, /issue\.user\?\.type === 'User' && !\/<!-- ai-dev-framework:PRODUCT_IMPROVEMENT \//);
  assert.match(workflow, /JSON\.stringify\(\{ title: issue\.title, body, authoredByHuman \}\)/);
});
