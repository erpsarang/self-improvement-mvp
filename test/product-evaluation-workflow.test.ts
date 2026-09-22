import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(".github/workflows/product-evaluation.yml", "utf8");
const plan = await readFile(".github/workflows/plan.yml", "utf8");
const ownership = await readFile("policy/framework-distribution-ownership.v1.json", "utf8");
const moduleSource = await readFile("src/self-improvement/product-evaluation.ts", "utf8");

test("Human Merge된 default branch PR만 Product Evaluation bootstrap 대상이다", () => {
  assert.match(workflow, /pull_request:\n {4}types: \[closed\]/);
  assert.match(workflow, /github\.event\.pull_request\.merged == true/);
  assert.match(workflow, /github\.event\.pull_request\.base\.ref == github\.event\.repository\.default_branch/);
  assert.match(workflow, /ai-dev-framework:MERGE_READY issue=/);
  assert.match(workflow, /pr\.head\.ref !== `ai-publish\/issue-\$\{issueNumber\}`/);
  assert.match(workflow, /pr\.head\.sha !== reviewedSha/);
});

test("bootstrap은 자기 자신만 dispatch하고 IMPLEMENT나 LEARN을 시작하지 않는다", () => {
  const bootstrap = workflow.slice(workflow.indexOf("\n  bootstrap:\n"), workflow.indexOf("\n  prepare:\n"));
  assert.match(bootstrap, /workflow_id: 'product-evaluation\.yml'/);
  assert.match(bootstrap, /human_merge_pr_number: process\.env\.HUMAN_MERGE_PR_NUMBER/);
  assert.doesNotMatch(bootstrap, /workflow_id: 'plan\.yml'/);
  assert.doesNotMatch(workflow, /workflow_id: 'implement\.yml'|workflow_id: 'plan-implement-handoff\.yml'|workflow_id: 'trusted-rail\.yml'/);
  assert.doesNotMatch(workflow, /workflow_id: 'learn-source\.yml'|workflow_id: 'learn\.yml'/);
});

test("평가 대상은 지금 배포된 default branch이고 cycle 포함 여부를 exact하게 확인한다", () => {
  assert.match(workflow, /github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/);
  assert.match(workflow, /Trusted Product Evaluation must execute at the exact current default branch SHA/);
  assert.match(workflow, /Human Merge commit must be part of the currently deployed default branch/);
  assert.match(workflow, /comparison\.status !== 'identical' && comparison\.status !== 'ahead'/);
  assert.match(workflow, /Human Merge PR must be actually merged/);
  assert.match(workflow, /Human Merge PR exact identity mismatch/);
  // snapshot 내용은 배포된 SHA에서 읽는다.
  assert.match(workflow, /const deployedSha = currentDefault\.commit\.sha;/);
  assert.match(workflow, /path: product-target/);
});

test("Evaluator는 credential 없이 neutral workspace에서 read-only로 1회만 호출된다", () => {
  assert.match(workflow, /uses: openai\/codex-action@v1/);
  assert.match(workflow, /permission-profile: ":read-only"/);
  assert.match(workflow, /safety-strategy: drop-sudo/);
  assert.match(workflow, /working-directory: \$\{\{ runner\.temp \}\}\/product-evaluation-neutral/);
  assert.match(workflow, /codex-args: '\["-c","project_doc_max_bytes=0"\]'/);
  for (const token of ["GITHUB_TOKEN", "GH_TOKEN", "NODE_AUTH_TOKEN", "NPM_TOKEN"]) {
    assert.match(workflow, new RegExp(`${token}: ""`));
  }
  // 비용을 아끼기 위해 재시도로 AI를 다시 호출하지 않는다.
  assert.match(workflow, /AI Cost Guardrail: 동일 Product Evaluation run의 AI 호출은 최대 1 attempt만 허용합니다\./);
  assert.match(workflow, /if \[ "\$GITHUB_RUN_ATTEMPT" -gt 1 \]; then/);
  assert.equal(workflow.split("openai/codex-action@v1").length - 1, 2);
});

test("App repository와 canonical repository의 Codex key 경계를 지킨다", () => {
  assert.match(
    workflow,
    /openai-api-key: \$\{\{ secrets\[github\.repository == 'erpsarang\/self-improvement-mvp' && 'FRAMEWORK_CODEX_API_KEY' \|\| 'APP_CODEX_API_KEY'\] \}\}/,
  );
});

test("Framework runtime은 App 배포본과 canonical 양쪽에서 해석된다", () => {
  assert.match(workflow, /if \[ -f \.framework-runtime\/package-lock\.json \]; then/);
  assert.match(workflow, /npm ci --ignore-scripts --prefix \.framework-runtime/);
  assert.match(workflow, /ln -sT \.framework-runtime\/node_modules node_modules/);
  assert.match(workflow, /node_modules\/\.bin\/tsx src\/self-improvement\/product-evaluation-handler\.ts prepare/);
  assert.match(workflow, /node_modules\/\.bin\/tsx src\/self-improvement\/product-evaluation-handler\.ts finalize/);
  assert.match(workflow, /node_modules\/\.bin\/tsx src\/self-improvement\/product-evaluation-handler\.ts decide/);
});

test("Issue 생성은 trusted finalize의 결정적 판단 뒤에만 일어난다", () => {
  assert.match(workflow, /\n {2}finalize:\n/);
  assert.match(workflow, /needs: \[prepare, evaluator\]/);
  assert.match(workflow, /needs\.evaluator\.result == 'success'/);
  assert.match(workflow, /if: steps\.decide\.outputs\.action == 'create'/);
  assert.match(workflow, /if: steps\.decide\.outputs\.action == 'skip'/);
  assert.match(workflow, /if \(decision\.action !== 'create'\) throw new Error\('issue decision is not create'\)/);
  // 제목/본문은 AI 출력이 아니라 검증된 decision 파일에서만 온다.
  assert.match(workflow, /title: decision\.title/);
  assert.match(workflow, /body: decision\.body/);
});

test("Product Evaluation은 read-only PLAN 제안에서 멈추고 Human authority를 침범하지 않는다", () => {
  assert.match(workflow, /permissions: \{\}/);
  assert.doesNotMatch(workflow, /pulls\.merge|mergePullRequest|enablePullRequestAutoMerge|git\s+push/);
  assert.doesNotMatch(workflow, /pulls\.create/);
  assert.doesNotMatch(workflow, /contents: write/);
  // 평가 job은 어떤 write 권한도 갖지 않는다.
  assert.match(workflow, /\n {2}evaluator:\n[\s\S]*?permissions:\n {6}contents: read\n/);
  // Issue를 만드는 job의 write 권한은 issues와 PLAN dispatch용 actions뿐이다.
  assert.match(workflow, /\n {2}finalize:\n[\s\S]*?permissions:\n {6}contents: read\n {6}issues: write\n {6}actions: write\n/);
});

test("후보 Issue가 생성되면 read-only PLAN을 정확히 한 번 자동 시작하고 승인은 사람에게 남긴다", () => {
  assert.match(moduleSource, /SELF_IMPROVEMENT_TITLE_PREFIX = "\[Self-Improvement\]"/);
  // Issue 이벤트로는 PLAN이 시작되지 않는다. [업무 요구] 접두사를 쓰지 않으므로 dispatch가 유일한 경로다.
  assert.match(plan, /startsWith\(github\.event\.issue\.title, '\[업무 요구\]'\)/);
  assert.doesNotMatch(workflow, /\[업무 요구\]/);
  assert.equal(workflow.split("workflow_id: 'plan.yml'").length - 1, 1);
  assert.match(workflow, /if: steps\.decide\.outputs\.action == 'create' && steps\.create\.outputs\.issue_number != ''/);
  assert.match(workflow, /inputs: \{ issue_number: issueNumber \}/);
  // 승인 댓글이나 IMPLEMENT는 어디에서도 만들지 않는다.
  assert.doesNotMatch(workflow, /issues\.createComment|body: 'PLAN-승인'/);
  assert.match(moduleSource, /PLAN-승인 이후에만 구현이 시작됩니다/);
});

test("가드레일은 계약 모듈에 구조적으로 박혀 있다", () => {
  assert.match(moduleSource, /product evaluation allows at most one candidate per cycle/);
  assert.match(moduleSource, /must not target Framework-owned paths/);
  assert.match(moduleSource, /references a path outside the product snapshot/);
  assert.match(moduleSource, /이미 열린 Improvement Candidate Issue가 있습니다/);
  assert.match(moduleSource, /같은 제목의 Issue가 이미 있습니다/);
});

test("Product Evaluation은 canonical distribution으로 App repository에 전달된다", () => {
  for (const path of [
    ".github/workflows/product-evaluation.yml",
    "src/self-improvement/product-evaluation.ts",
    "src/self-improvement/product-evaluation-handler.ts",
  ]) {
    assert.equal(ownership.includes(`"sourcePath": "${path}"`), true, path);
  }
});

test("prepare는 사람이 not_planned로 닫은 후보만 읽어 평가 입력에 넣는다", () => {
  assert.match(workflow, /\n {2}prepare:\n[\s\S]*?permissions:\n {6}contents: read\n {6}pull-requests: read\n {6}issues: read\n/);
  assert.match(workflow, /issue\.state_reason !== 'not_planned'/);
  assert.match(workflow, /issue\.title\.startsWith\(prefix\)/);
  assert.match(workflow, /comment\.user\?\.login !== 'github-actions\[bot\]'/);
  assert.match(workflow, /REJECTED_CANDIDATES_JSON: \$\{\{ runner\.temp \}\}\/product-evaluation\/rejected-candidates\.json/);
  // 기각 후보 수집은 읽기 전용이고 AI 호출을 늘리지 않는다.
  assert.doesNotMatch(workflow, /issues\.update|issues\.createComment/);
  assert.equal(workflow.split("openai/codex-action@v1").length - 1, 2);
});
