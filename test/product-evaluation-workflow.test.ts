import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(".github/workflows/product-evaluation.yml", "utf8");
const plan = await readFile(".github/workflows/plan.yml", "utf8");
const ownership = await readFile("policy/framework-distribution-ownership.v1.json", "utf8");
const moduleSource = await readFile("src/self-improvement/product-evaluation.ts", "utf8");

test("Product Evaluation은 머지 후 자동으로 시작하지 않고 사람이 workflow_dispatch로만 실행한다", () => {
  assert.match(workflow, /\non:\n  workflow_dispatch:\n/);
  assert.doesNotMatch(workflow, /\n  pull_request:|pull_request_target/);
  assert.doesNotMatch(workflow, /\n  bootstrap:\n/);
  // 자기 자신을 dispatch하던 경로가 없다.
  assert.doesNotMatch(workflow, /workflow_id: 'product-evaluation\.yml'/);
  assert.doesNotMatch(workflow, /workflow_id: 'implement\.yml'|workflow_id: 'plan-implement-handoff\.yml'|workflow_id: 'trusted-rail\.yml'/);
  assert.doesNotMatch(workflow, /workflow_id: 'learn-source\.yml'|workflow_id: 'learn\.yml'/);
});

test("수동 실행도 exact MERGE_READY Human Merge PR만 평가 대상이다", () => {
  assert.match(workflow, /ai-dev-framework:MERGE_READY issue=/);
  assert.match(workflow, /new RegExp\(`\^ai-publish\/issue-\$\{issueNumber\}\(\?:-cycle-\[0-9a-f\]\{16\}\)\?\$`\)\.test\(pr\.head\.ref\)/);
  assert.match(workflow, /pr\.head\.sha !== reviewedHeadSha/);
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

const prepareJob = workflow.slice(workflow.indexOf("\n  prepare:\n"), workflow.indexOf("\n  evaluator:\n"));
const evaluatorJob = workflow.slice(workflow.indexOf("\n  evaluator:\n"), workflow.indexOf("\n  finalize:\n"));

test("Evaluator는 Private subscription executor에 exact snapshot만 담은 요청을 1회만 보낸다", () => {
  assert.doesNotMatch(workflow, /openai\/codex-action|CODEX_API_KEY|permission-profile|product-evaluation-neutral/);
  assert.match(evaluatorJob, /permissions:\n {6}actions: read\n {6}issues: write\n {4}uses: \.\/\.github\/workflows\/subscription-exchange\.yml/);
  assert.match(evaluatorJob, /^ {6}kind: PRODUCT_EVALUATION$/m);
  assert.match(evaluatorJob, /request_artifact_id: \$\{\{ needs\.prepare\.outputs\.subscription_request_artifact_id \}\}/);
  assert.match(evaluatorJob, /request_artifact_digest: \$\{\{ needs\.prepare\.outputs\.subscription_request_artifact_digest \}\}/);
  // 결과 artifact 이름과 파일은 기존 Evaluator output 그대로라 finalize의 snapshot binding 검증은 바뀌지 않는다.
  assert.match(evaluatorJob, /result_artifact_name: evaluator-output-issue-\$\{\{ needs\.prepare\.outputs\.issue_number \}\}-\$\{\{ github\.run_id \}\}-attempt-\$\{\{ github\.run_attempt \}\}/);
  assert.match(evaluatorJob, /result_file_name: evaluator\.json/);
  assert.deepEqual(workflow.match(/secrets\.[A-Za-z0-9_]+/g), ["secrets.EXECUTOR_DISPATCH_TOKEN"]);
  assert.match(prepareJob, /PRODUCT_EVALUATION_SUBSCRIPTION_DIR: \$\{\{ runner\.temp \}\}\/product-evaluation\/subscription-request/);
  // 비용을 아끼기 위해 재시도로 AI를 다시 호출하지 않는다. 요청 artifact를 올리기 전에 막는다.
  assert.match(workflow, /AI Cost Guardrail: 동일 Product Evaluation run의 AI 호출은 최대 1 attempt만 허용합니다\./);
  assert.match(workflow, /if \[ "\$GITHUB_RUN_ATTEMPT" -gt 1 \]; then/);
  assert.ok(prepareJob.indexOf("Product Evaluation AI 비용 상한 확인") < prepareJob.indexOf("PRODUCT_EVALUATION_REQUEST artifact 저장"));
  for (const step of ["Product Evaluation AI 비용 상한 확인", "PRODUCT_EVALUATION_REQUEST artifact 저장"]) {
    const block = prepareJob.slice(prepareJob.indexOf(`- name: ${step}`));
    assert.match(block, /^ {8}if: steps\.prepare\.outputs\.should_evaluate == 'true'$/m, step);
  }
  assert.equal(workflow.split("uses: ./.github/workflows/subscription-exchange.yml").length - 1, 1);
});

test("Evaluator provenance는 subscription executor와 sonnet을 기록한다", () => {
  assert.match(workflow, /EVALUATOR_PROVIDER: claude-max-subscription\n/);
  assert.match(workflow, /EVALUATOR_ACTION: \$\{\{ vars\.AI_EXECUTOR_REPOSITORY \}\}\/product-evaluation-poller\.yml\n/);
  assert.match(workflow, /EVALUATOR_MODEL: sonnet\n/);
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
  // 평가 job의 write 권한은 PRODUCT_EVALUATION_REQUEST marker 댓글용 issues뿐이다.
  assert.match(workflow, /\n {2}evaluator:\n[\s\S]*?permissions:\n {6}actions: read\n {6}issues: write\n {4}uses:/);
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
  assert.equal(workflow.split("uses: ./.github/workflows/subscription-exchange.yml").length - 1, 1);
});

test("제품 파일을 바꾸지 않은 cycle은 AI Evaluator를 호출하지 않고 사유를 남긴다", () => {
  const prepare = workflow.slice(workflow.indexOf("\n  prepare:\n"), workflow.indexOf("\n  evaluator:\n"));
  const evaluator = workflow.slice(workflow.indexOf("\n  evaluator:\n"), workflow.indexOf("\n  finalize:\n"));
  // 변경 경로는 이 Human Merge PR에서만 읽고, 조회 실패나 상한 도달은 평가 쪽으로 기운다.
  assert.match(prepare, /github\.paginate\(github\.rest\.pulls\.listFiles, \{\n\s+\.\.\.context\.repo,\n\s+pull_number: prNumber,/);
  assert.match(prepare, /file\.previous_filename \? \[file\.filename, file\.previous_filename\]/);
  assert.match(prepare, /complete: files\.length > 0 && files\.length < 3000/);
  assert.match(prepare, /let changedPaths = \{ complete: false, paths: \[\] \};/);
  assert.match(prepare, /PRODUCT_CHANGED_PATHS_JSON: \$\{\{ runner\.temp \}\}\/product-evaluation\/changed-paths\.json/);
  assert.match(prepare, /should_evaluate: \$\{\{ steps\.prepare\.outputs\.should_evaluate \}\}/);
  assert.match(evaluator, /if: needs\.prepare\.result == 'success' && needs\.prepare\.outputs\.should_evaluate == 'true'/);
  // finalize는 evaluator 성공에만 묶여 있어 생략 시 Issue 생성이나 자동 PLAN도 일어나지 않는다.
  assert.match(workflow, /if: needs\.prepare\.result == 'success' && needs\.evaluator\.result == 'success'/);
  assert.equal(workflow.split("uses: ./.github/workflows/subscription-exchange.yml").length - 1, 1);
});
