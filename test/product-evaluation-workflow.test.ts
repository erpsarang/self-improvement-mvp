import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(".github/workflows/product-evaluation.yml", "utf8");
const plan = await readFile(".github/workflows/plan.yml", "utf8");
const ownership = await readFile("policy/framework-distribution-ownership.v1.json", "utf8");
const moduleSource = await readFile("src/self-improvement/product-evaluation.ts", "utf8");

test("Product Evaluation은 머지 후 자동으로 시작하지 않고 사람이 workflow_dispatch로만 실행한다", () => {
  assert.match(workflow, /\non:\n  workflow_dispatch:\n\n/);
  // 실행할 때 고를 입력이 없다. 평가 대상은 실행 시점의 기본 브랜치다.
  assert.doesNotMatch(workflow, /\n {4}inputs:|human_merge_pr_number/);
  assert.doesNotMatch(workflow, /\n  pull_request:|pull_request_target/);
  assert.doesNotMatch(workflow, /\n  bootstrap:\n/);
  // 자기 자신을 dispatch하던 경로가 없다.
  assert.doesNotMatch(workflow, /workflow_id: 'product-evaluation\.yml'/);
  assert.doesNotMatch(workflow, /workflow_id: 'implement\.yml'|workflow_id: 'plan-implement-handoff\.yml'|workflow_id: 'trusted-rail\.yml'/);
  assert.doesNotMatch(workflow, /workflow_id: 'learn-source\.yml'|workflow_id: 'learn\.yml'/);
});

test("평가 대상은 실행 시점의 기본 브랜치 SHA이고 Human Merge PR에 묶이지 않는다", () => {
  assert.match(workflow, /github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/);
  assert.match(workflow, /Trusted Product Evaluation must execute at the exact current default branch SHA/);
  assert.match(workflow, /context\.sha !== currentDefault\.commit\.sha/);
  assert.match(workflow, /deployedSha: currentDefault\.commit\.sha,/);
  assert.doesNotMatch(workflow, /MERGE_READY|pulls\.get\(|compareCommits|decideProductEvaluationNeed|\/changed-paths\.json/);
  // snapshot 내용은 배포된 SHA에서 읽는다.
  assert.match(workflow, /path: product-target/);
  // 요청 식별 정보와 artifact 이름은 이 run과 평가한 SHA로 정한다.
  assert.match(workflow, /request_artifact_name=product-discovery-request-\$\{GITHUB_SHA\}-\$\{GITHUB_RUN_ID\}-attempt-\$\{GITHUB_RUN_ATTEMPT\}/);
  assert.match(workflow, /subscription_request_artifact_name=product-discovery-subscription-\$\{GITHUB_SHA\}-\$\{GITHUB_RUN_ID\}-attempt-\$\{GITHUB_RUN_ATTEMPT\}/);
  assert.match(workflow, /name: product-improvement-decision-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_id \}\}-attempt-\$\{\{ github\.run_attempt \}\}/);
  assert.match(workflow, /group: product-evaluation-\$\{\{ github\.repository \}\}\n/);
});

test("교환 comment와 결과는 Framework가 만든 Discovery 전용 Issue 하나에 계속 남긴다", () => {
  const issueJob = workflow.slice(workflow.indexOf("\n  discovery_issue:\n"), workflow.indexOf("\n  prepare:\n"));
  assert.match(issueJob, /permissions:\n {6}issues: write\n/);
  assert.match(issueJob, /const title = '\[Product Discovery\] 실행 기록';/);
  assert.match(issueJob, /const marker = '<!-- ai-dev-framework:PRODUCT_DISCOVERY_LOG v=1 -->';/);
  // 사람이 같은 제목으로 만든 Issue는 쓰지 않는다. 여러 개면 fail-closed한다.
  assert.match(issueJob, /issue\.user\?\.login === 'github-actions\[bot\]'/);
  assert.match(issueJob, /\(issue\.body \|\| ''\)\.startsWith\(marker\)/);
  assert.match(issueJob, /if \(found\.length > 1\) \{\n\s+throw new Error/);
  assert.match(issueJob, /github\.rest\.issues\.create\(/);
  // Discovery Issue 제목은 PLAN ingress나 Improvement Candidate 접두사가 아니다.
  assert.doesNotMatch(issueJob, /\[업무 요구\]|\[Self-Improvement\]/);
  assert.match(workflow, /needs: discovery_issue\n/);
  assert.match(workflow, /DISCOVERY_ISSUE_NUMBER: \$\{\{ needs\.discovery_issue\.outputs\.issue_number \}\}/);
  assert.match(workflow, /issue_number: \$\{\{ needs\.prepare\.outputs\.issue_number \}\}/);
});

test("prepare는 최근 이력(완료한 요구, 최근 변경 경로)을 읽기 전용으로 모아 snapshot에 넣는다", () => {
  const prepare = workflow.slice(workflow.indexOf("\n  prepare:\n"), workflow.indexOf("\n  evaluator:\n"));
  assert.match(prepare, /issue\.state_reason !== 'completed'/);
  assert.match(prepare, /issue\.title === '\[Product Discovery\] 실행 기록'/);
  assert.match(prepare, /\.filter\(\(pull\) => pull\.merged_at\)/);
  assert.match(prepare, /\.slice\(0, recentPullRequests\)/);
  assert.match(prepare, /github\.rest\.pulls\.listFiles\(/);
  for (const name of ["PRODUCT_DISCOVERY_TARGET_JSON", "REJECTED_CANDIDATES_JSON", "COMPLETED_REQUIREMENTS_JSON", "RECENT_CHANGED_PATHS_JSON"]) {
    assert.match(prepare, new RegExp(`${name}: \\$\\{\\{ runner\\.temp \\}\\}/product-evaluation/`), name);
  }
  assert.doesNotMatch(prepare, /issues\.update|issues\.create|issues\.createComment/);
});

const prepareJob = workflow.slice(workflow.indexOf("\n  prepare:\n"), workflow.indexOf("\n  evaluator:\n"));
const evaluatorJob = workflow.slice(workflow.indexOf("\n  evaluator:\n"), workflow.indexOf("\n  finalize:\n"));

test("Evaluator는 Private subscription executor에 exact snapshot만 담은 요청을 1회만 보낸다", () => {
  assert.doesNotMatch(workflow, /openai\/codex-action|CODEX_API_KEY|permission-profile|product-evaluation-neutral/);
  assert.match(evaluatorJob, /permissions:\n {6}actions: read\n {6}issues: write\n {4}uses: \.\/\.github\/workflows\/subscription-exchange\.yml/);
  assert.match(evaluatorJob, /^ {6}kind: PRODUCT_EVALUATION$/m);
  assert.match(evaluatorJob, /request_artifact_id: \$\{\{ needs\.prepare\.outputs\.subscription_request_artifact_id \}\}/);
  assert.match(evaluatorJob, /request_artifact_digest: \$\{\{ needs\.prepare\.outputs\.subscription_request_artifact_digest \}\}/);
  // 결과 artifact 이름은 이 run과 SHA로 정하고 파일은 evaluator.json 하나다.
  assert.match(evaluatorJob, /result_artifact_name: evaluator-output-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_id \}\}-attempt-\$\{\{ github\.run_attempt \}\}/);
  assert.match(evaluatorJob, /result_file_name: evaluator\.json/);
  assert.deepEqual(workflow.match(/secrets\.[A-Za-z0-9_]+/g), ["secrets.EXECUTOR_DISPATCH_TOKEN"]);
  assert.match(prepareJob, /PRODUCT_EVALUATION_SUBSCRIPTION_DIR: \$\{\{ runner\.temp \}\}\/product-evaluation\/subscription-request/);
  // 비용을 아끼기 위해 재시도로 AI를 다시 호출하지 않는다. 요청 artifact를 올리기 전에 막는다.
  assert.match(workflow, /AI Cost Guardrail: 동일 Product Evaluation run의 AI 호출은 최대 1 attempt만 허용합니다\./);
  assert.match(workflow, /if \[ "\$GITHUB_RUN_ATTEMPT" -gt 1 \]; then/);
  assert.ok(prepareJob.indexOf("Product Evaluation AI 비용 상한 확인") < prepareJob.indexOf("PRODUCT_EVALUATION_REQUEST artifact 저장"));
  // 사람이 실행한 Discovery는 매번 AI를 1회 부른다. 생략 조건은 없다.
  assert.doesNotMatch(workflow, /should_evaluate/);
  assert.match(evaluatorJob, /if: needs\.prepare\.result == 'success'\n/);
  assert.equal(workflow.split("uses: ./.github/workflows/subscription-exchange.yml").length - 1, 1);
});

test("Evaluator provenance는 subscription executor와 opus를 기록한다", () => {
  assert.match(workflow, /EVALUATOR_PROVIDER: claude-max-subscription\n/);
  assert.match(workflow, /EVALUATOR_ACTION: \$\{\{ vars\.AI_EXECUTOR_REPOSITORY \}\}\/product-evaluation-poller\.yml\n/);
  assert.match(workflow, /EVALUATOR_MODEL: opus\n/);
  assert.match(workflow, /EVALUATOR_REASONING_EFFORT: medium\n/);
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
  // 승인 댓글이나 IMPLEMENT는 어디에서도 만들지 않는다. 남기는 댓글은 Discovery Issue의 결과 기록과 검증 실패 알림(#381) 둘뿐이고
  // 둘 다 Discovery 전용 Issue로만 간다.
  assert.doesNotMatch(workflow, /body: 'PLAN-승인'/);
  assert.equal(workflow.split("issues.createComment(").length - 1, 2);
  assert.equal(workflow.split("issue_number: Number(issueNumber), body });").length - 1, 2);
  assert.match(workflow, /await github\.rest\.issues\.createComment\(\{ \.\.\.context\.repo, issue_number: Number\(issueNumber\), body \}\);/);
  assert.match(workflow, /DISCOVERY_ISSUE_NUMBER: \$\{\{ needs\.prepare\.outputs\.issue_number \}\}\n {10}DISCOVERY_RESULT_COMMENT_MD/);
  assert.match(moduleSource, /PLAN-승인 이후에만 구현이 시작됩니다/);
});

test("가드레일은 계약 모듈에 구조적으로 박혀 있다", () => {
  assert.match(moduleSource, /product discovery allows at most one candidate per run/);
  assert.match(moduleSource, /product discovery must compare exactly/);
  assert.match(moduleSource, /compared candidates must come from different areas/);
  assert.match(moduleSource, /notSelected must give a reason for every candidate that was not selected/);
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
  assert.equal(workflow.split("uses: ./.github/workflows/subscription-exchange.yml").length - 1, 1);
});


test("trusted 검증이나 결정이 실패하면 Discovery 전용 Issue에 단계와 로그를 알리고 AI를 다시 부르지 않는다 (#381)", () => {
  const finalize = workflow.slice(workflow.indexOf("\n  finalize:\n"));
  const notice = finalize.slice(finalize.indexOf("- name: 검증 실패를 Discovery 전용 Issue에 알림"));
  assert.match(notice, /if: failure\(\)\n/);
  assert.match(notice, /DISCOVERY_ISSUE_NUMBER: \$\{\{ needs\.prepare\.outputs\.issue_number \}\}/);
  assert.match(notice, /steps\.finalize\.outcome/);
  assert.match(notice, /issues\.createComment\(/);
  // 알림은 댓글 하나뿐이다. 후보 Issue, PLAN, executor 호출은 만들지 않는다.
  assert.doesNotMatch(notice, /issues\.create\(|createWorkflowDispatch|EXECUTOR_DISPATCH_TOKEN|secrets\./);
  // 이미 쓰던 권한(issues: write) 안에서만 동작한다.
  assert.match(finalize, /permissions:\n {6}contents: read\n {6}issues: write\n {6}actions: write\n/);
});

const candidateWorkflow = await readFile(".github/workflows/improvement-candidate.yml", "utf8");

test("머지 뒤 자동 Discovery는 opt-in 변수와 결정적 조건이 맞을 때만 product-evaluation.yml을 dispatch한다 (#383)", () => {
  const gate = candidateWorkflow.slice(candidateWorkflow.indexOf("\n  discovery_gate:\n"));
  assert.match(candidateWorkflow, /\npermissions: \{\}\n/);
  assert.match(gate, /needs: candidate\n/);
  assert.match(gate, /vars\.AUTO_PRODUCT_DISCOVERY == 'on'/);
  assert.match(gate, /needs\.candidate\.result == 'success'/);
  // 기본 브랜치의 trusted 코드에서만 돈다.
  assert.match(gate, /github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/);
  assert.match(gate, /ref: \$\{\{ github\.sha \}\}\n\s+persist-credentials: false/);
  // 쓰기 권한은 이 job의 dispatch용 actions: write뿐이고, candidate job은 읽기만 한다.
  assert.match(gate, /permissions:\n {6}contents: read\n {6}issues: read\n {6}pull-requests: read\n {6}actions: write\n/);
  const candidateJob = candidateWorkflow.slice(candidateWorkflow.indexOf("\n  candidate:\n"), candidateWorkflow.indexOf("\n  discovery_gate:\n"));
  assert.doesNotMatch(candidateJob, /actions: write|issues: write|pull-requests: write/);
  // 판단은 AI 없이 결정적 함수가 하고, 봇이 쓴 기록만 믿는다.
  assert.match(gate, /product-evaluation-handler\.ts gate/);
  assert.match(gate, /issue\.user\?\.login === BOT/);
  assert.match(gate, /comment\.user\?\.login === BOT/);
  assert.match(gate, /\^ai-publish\\\/issue-\[0-9\]\+/);
  // dispatch는 Trusted Product Evaluation 하나뿐이고, 후보 Issue·PLAN·승인·Merge·secret·executor 호출은 없다.
  assert.equal(gate.split("createWorkflowDispatch(").length - 1, 1);
  assert.match(gate, /workflow_id: 'product-evaluation\.yml'/);
  assert.doesNotMatch(gate, /workflow_id: 'plan\.yml'|workflow_id: 'implement\.yml'|plan-authorize/);
  assert.doesNotMatch(gate, /issues\.create\(|issues\.createComment|pulls\.merge|git\s+push|secrets\.|EXECUTOR_DISPATCH_TOKEN/);
});
