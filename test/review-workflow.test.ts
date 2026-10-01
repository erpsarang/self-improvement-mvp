import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const trustedRail = await readFile(".github/workflows/trusted-rail.yml", "utf8");
const reviewWorkflow = await readFile(".github/workflows/semantic-review.yml", "utf8");
const prepareSection = reviewWorkflow.split("\n  review_prepare:\n")[1]?.split("\n  review_agent:\n")[0] ?? "";
const agentSection = reviewWorkflow.split("\n  review_agent:\n")[1]?.split("\n  review_exchange:\n")[0] ?? "";
const exchangeSection = reviewWorkflow.split("\n  review_exchange:\n")[1]?.split("\n  review_finalize:\n")[0] ?? "";
const finalizeSection = reviewWorkflow.split("\n  review_finalize:\n")[1] ?? "";

test("Trusted Rail은 VERIFY 성공 뒤 Semantic REVIEW reusable workflow를 동기 호출한다", () => {
  assert.match(trustedRail, /\n  review:\n/);
  assert.match(trustedRail, /needs: verify_finalize/);
  assert.match(trustedRail, /needs\.verify_finalize\.result == 'success'/);
  assert.match(trustedRail, /uses: \.\/\.github\/workflows\/semantic-review\.yml/);
  assert.doesNotMatch(reviewWorkflow, /workflow_run:/);
  assert.match(reviewWorkflow, /workflow_call:/);
});

test("REVIEW는 trusted prepare → isolated request → subscription exchange → trusted finalize로 runner를 분리한다", () => {
  assert.match(reviewWorkflow, /\n  review_prepare:\n/);
  assert.match(reviewWorkflow, /\n  review_agent:\n/);
  assert.match(reviewWorkflow, /\n  review_exchange:\n/);
  assert.match(reviewWorkflow, /\n  review_finalize:\n/);
  assert.match(agentSection, /needs: review_prepare/);
  assert.match(exchangeSection, /needs: \[review_prepare, review_agent\]/);
  assert.match(finalizeSection, /needs: \[review_prepare, review_agent, review_exchange\]/);
  assert.match(finalizeSection, /needs\.review_agent\.result == 'success'/);
  assert.match(finalizeSection, /needs\.review_exchange\.result == 'success'/);
});

test("trusted REVIEW prepare/request/finalize는 read-only이고 Issue write는 checkout 없는 subscription exchange에만 있다", () => {
  assert.match(prepareSection, /permissions:\n      contents: read\n      actions: read/);
  assert.match(agentSection, /permissions:\n      contents: read\n    runs-on:/);
  assert.match(finalizeSection, /permissions:\n      contents: read\n      actions: read/);
  for (const section of [prepareSection, agentSection, finalizeSection]) {
    assert.doesNotMatch(section, /contents: write|pull-requests: write|issues: write/);
  }
  assert.match(exchangeSection, /permissions:\n      actions: read\n      issues: write\n    uses: \.\/\.github\/workflows\/subscription-exchange\.yml\n/);
  assert.doesNotMatch(exchangeSection, /steps:|runs-on:|actions\/checkout@/);
  assert.equal((reviewWorkflow.match(/issues: write/g) ?? []).length, 1);
  // Trusted Rail은 REVIEW_REQUEST marker를 위해서만 review 호출에 issues: write를 준다.
  const railReview = trustedRail.split("\n  review:\n")[1]?.split("\n  orchestrate:\n")[0] ?? "";
  assert.match(railReview, /permissions:\n      contents: read\n      actions: read\n      issues: write\n    uses: \.\/\.github\/workflows\/semantic-review\.yml\n/);
});

test("REVIEW request는 exact verified SHA를 credential-free checkout하고 AI를 직접 호출하지 않는다", () => {
  assert.match(agentSection, /ref: \$\{\{ needs\.review_prepare\.outputs\.verified_head_sha \}\}/);
  assert.match(agentSection, /persist-credentials: false/);
  assert.match(agentSection, /GITHUB_TOKEN: ""/);
  assert.match(agentSection, /GH_TOKEN: ""/);
  assert.match(agentSection, /NODE_AUTH_TOKEN: ""/);
  assert.match(agentSection, /NPM_TOKEN: ""/);
  assert.doesNotMatch(reviewWorkflow, /openai\/codex-action|openai-api-key|CODEX_API_KEY|model: gpt-/);
  assert.doesNotMatch(agentSection, /secrets\./);
});

test("REVIEW request는 Private 계약의 exact identity와 review-context 원문을 담은 3개 파일 artifact다", () => {
  for (const key of ["schemaVersion: 1", "kind: 'trusted-review-request'", "repository: env.REVIEW_REPOSITORY", "headSha: env.VERIFIED_SHA", "reviewInput: {", "rail: {"]) {
    assert.ok(agentSection.includes(key), key);
  }
  assert.ok(agentSection.includes("const model = 'opus';"));
  assert.match(agentSection, /REVIEW_INPUT_DIGEST: \$\{\{ needs\.review_prepare\.outputs\.review_input_artifact_digest \}\}/);
  assert.match(prepareSection, /review_input_artifact_digest: \$\{\{ steps\.review_input_upload\.outputs\.artifact-digest \}\}/);
  // patch와 파일 목록은 내용 digest가 붙은 구획으로 prompt에 그대로 들어간다.
  assert.ok(agentSection.includes("section('review-context/changed-files.txt', fs.readFileSync('review-neutral/review-context/changed-files.txt', 'utf8'))"));
  assert.ok(agentSection.includes("section('review-context/patch.diff', fs.readFileSync('review-neutral/review-context/patch.diff', 'utf8'))"));
  assert.ok(agentSection.includes("-----BEGIN ${name} sha256=${digest}-----"));
  assert.ok(agentSection.includes("-----END ${name} sha256=${digest}-----"));
  assert.ok(agentSection.includes("fs.copyFileSync(path.join(env.RUNNER_TEMP, 'review-input', 'review-output.schema.json'), path.join(output, 'schema.json'));"));
  assert.ok(agentSection.includes(`= "f:identity.json f:prompt.md f:schema.json "`));
  assert.match(agentSection, /request_artifact_digest: \$\{\{ steps\.review_request_upload\.outputs\.artifact-digest \}\}/);
  // full checkout을 지운 뒤에만 request를 만든다.
  assert.ok(agentSection.indexOf("test ! -e review-target") < agentSection.indexOf("REVIEW_REQUEST 입력 고정"));
});

test("REVIEW subscription exchange는 opus REVIEW 계약으로 기존 reviewer output artifact를 만든다", () => {
  assert.match(exchangeSection, /kind: REVIEW\n/);
  assert.match(exchangeSection, /result_artifact_name: reviewer-output-issue-\$\{\{ needs\.review_prepare\.outputs\.issue_number \}\}-\$\{\{ github\.run_id \}\}-attempt-\$\{\{ github\.run_attempt \}\}\n/);
  assert.match(exchangeSection, /result_file_name: reviewer\.json\n/);
  assert.match(exchangeSection, /request_artifact_digest: \$\{\{ needs\.review_agent\.outputs\.request_artifact_digest \}\}/);
  assert.match(exchangeSection, /EXECUTOR_DISPATCH_TOKEN: \$\{\{ secrets\.EXECUTOR_DISPATCH_TOKEN \}\}/);
  assert.match(finalizeSection, /REVIEWER_PROVIDER: claude-max-subscription/);
});

test("Semantic REVIEW는 AI 호출 전에 bounded patch를 만들고 full checkout을 폐기한다", () => {
  assert.match(prepareSection, /base_sha: \${\{ steps\.review_source\.outputs\.base_sha \}\}/);
  assert.match(agentSection, /fetch-depth: 0/);
  assert.match(agentSection, /MAX_CHANGED_FILES: "12"/);
  assert.match(agentSection, /MAX_PATCH_BYTES: "65536"/);
  assert.match(agentSection, /git diff --name-only -z --diff-filter=ACDMRT/);
  assert.match(agentSection, /refuses binary diffs before AI invocation/);
  assert.match(agentSection, /review-neutral\/review-context\/patch\.diff/);
  assert.match(agentSection, /rm -rf review-target/);
  assert.match(agentSection, /test ! -e review-target/);
});

test("reviewer는 target project code를 실행하지 않고 structured output schema를 사용한다", () => {
  assert.doesNotMatch(agentSection, /working-directory: review-target\n\s+run: npm (?:ci|test|run)/);
  assert.match(agentSection, /review-output\.schema\.json/);
  assert.match(exchangeSection, /reviewer-output-issue-/);
});

test("fresh trusted finalize는 VERIFY와 AUTHORIZE를 재검증하고 raw reviewer artifact만 별도로 검증한다", () => {
  assert.match(finalizeSection, /VERIFY provenance 재검증 및 AUTHORIZE source 재결정/);
  assert.match(finalizeSection, /원본 AUTHORIZE artifact 재다운로드/);
  assert.match(finalizeSection, /current 또는 이전 Reviewer output artifact 선택/);
  assert.match(finalizeSection, /review-handler\.ts finalize/);
  assert.match(finalizeSection, /review-provenance-issue-/);
  assert.doesNotMatch(finalizeSection, /needs\.review_agent\.outputs/);
});

test("REVIEW는 push, PR 생성, Merge, Auto Merge를 수행하지 않는다", () => {
  assert.doesNotMatch(reviewWorkflow, /git\s+push|gh pr|pulls\.create|auto-merge|AUTO_MERGE/);
});

test("Semantic REVIEW patch는 trusted package-lock.json만 제외하고 나머지 경계는 그대로다 (#176 Rail run 35517080232)", () => {
  const start = agentSection.indexOf("- name: bounded REVIEW patch 생성 및 full checkout 폐기");
  assert.ok(start > 0);
  const step = agentSection.slice(start, agentSection.indexOf("\n      - name:", start + 10));

  // patch.diff에서만 repository root의 exact package-lock.json을 제외한다.
  assert.ok(step.includes(`git diff --no-ext-diff --no-color --unified="$context_lines" "$BASE_SHA" "$VERIFIED_SHA" -- . ':(top,exclude,literal)package-lock.json' \\`));
  assert.equal((step.match(/exclude/g) ?? []).length, 1);
  assert.equal((step.match(/package-lock\.json/g) ?? []).length, 2); // 주석 1 + pathspec 1
  assert.doesNotMatch(step, /exclude[^\n]*(\*|package\.json'|src\/|test\/)/);

  // changed-files.txt는 lock을 포함한 전체 변경 목록 그대로 (pathspec 없음).
  assert.ok(step.includes('git diff --name-only -z --diff-filter=ACDMRT "$BASE_SHA" "$VERIFIED_SHA" --\n'));
  assert.ok(step.includes("printf '%s\\n' \"${changed_files[@]}\" > ../review-neutral/review-context/changed-files.txt"));
  assert.ok(step.indexOf("changed-files.txt") < step.indexOf(":(top,exclude,literal)package-lock.json"));

  // 기존 budget / 차단 규칙 유지
  assert.match(step, /MAX_CHANGED_FILES: "12"/);
  assert.match(step, /MAX_PATCH_BYTES: "65536"/);
  assert.match(step, /\[ "\$changed_count" -eq 0 \] \|\| \[ "\$changed_count" -gt "\$MAX_CHANGED_FILES" \]/);
  assert.match(step, /\[ "\$patch_bytes" -eq 0 \] \|\| \[ "\$patch_bytes" -gt "\$MAX_PATCH_BYTES" \]/);
  // 예산을 넘으면 문맥 줄 수만 80 → 20 → 3으로 줄여 다시 만든다. 3줄로도 넘으면 기존처럼 AI 호출 전에 중단한다 (App #266).
  assert.ok(step.includes("for context_lines in 80 20 3; do"));
  assert.ok(step.includes('if [ "$patch_bytes" -le "$MAX_PATCH_BYTES" ]; then break; fi'));
  assert.ok(step.indexOf("for context_lines in 80 20 3; do") < step.indexOf('[ "$patch_bytes" -gt "$MAX_PATCH_BYTES" ]'));
  // binary 차단은 lock을 포함한 전체 diff에 대해 그대로 수행된다.
  assert.ok(step.includes('git diff --numstat "$BASE_SHA" "$VERIFIED_SHA" -- |'));
  assert.match(step, /refuses binary diffs before AI invocation/);
  // exact SHA 검증 유지
  assert.match(step, /git cat-file -e "\$\{BASE_SHA\}\^\{commit\}"/);
  assert.match(step, /\[ "\$\(git rev-parse HEAD\)" != "\$VERIFIED_SHA" \]/);
  assert.match(step, /BASE_SHA: \$\{\{ needs\.review_prepare\.outputs\.base_sha \}\}/);
  assert.match(step, /VERIFIED_SHA: \$\{\{ needs\.review_prepare\.outputs\.verified_head_sha \}\}/);
  // Reviewer는 repository 없이 bounded context만 받는다.
  assert.doesNotMatch(agentSection, /openai\/codex-action/);
  assert.match(agentSection, /rm -rf review-target/);
  // workflow 전체에서 제외 pathspec은 이 한 곳뿐이다.
  assert.equal((reviewWorkflow.match(/:\(top,exclude,literal\)/g) ?? []).length, 1);
});

test("PLAN 계보 REVIEW는 prepare와 fresh finalize 모두 승인된 PLAN artifact의 PLAN.json을 exact identity로 내려받아 심사 기준으로 쓴다 (#244 Rail run 35999983436)", () => {
  for (const section of [prepareSection, finalizeSection]) {
    const start = section.indexOf("- name: 승인된 PLAN artifact 다운로드");
    assert.ok(start > 0);
    const download = section.slice(start, section.indexOf("\n      - name:", start + 10));
    assert.match(download, /if: steps\.review_source\.outputs\.authority_kind == 'PLAN_AUTHORIZE'/);
    assert.match(download, /uses: actions\/download-artifact@v4/);
    assert.match(download, /name: \$\{\{ steps\.review_source\.outputs\.plan_artifact_name \}\}/);
    assert.match(download, /run-id: \$\{\{ steps\.review_source\.outputs\.plan_run_id \}\}/);
    assert.match(download, /github-token: \$\{\{ github\.token \}\}/);

    const checkStart = section.indexOf("- name: 승인된 PLAN artifact 구조 확인");
    assert.ok(checkStart > start);
    const check = section.slice(checkStart, section.indexOf("\n      - name:", checkStart + 10));
    assert.match(check, /if: steps\.review_source\.outputs\.authority_kind == 'PLAN_AUTHORIZE'/);
    assert.match(check, /-name PLAN\.json -print/);
    assert.match(check, /\[ "\$\{#plan_files\[@\]\}" -ne 1 \]/);
    assert.ok(check.includes('cp "${plan_files[0]}" "${RUNNER_TEMP}/review/plan.json"'));

    // PLAN_AUTHORIZE artifact 검증 뒤, handler 호출 전에 온다.
    assert.ok(section.indexOf("AUTHORIZE 또는 PLAN_AUTHORIZE artifact 구조 확인") < start);
    assert.ok(checkStart < section.indexOf("review-handler.ts prepare") || checkStart < section.indexOf("review-handler.ts finalize"));
    assert.match(section, /PLAN_JSON: \$\{\{ runner\.temp \}\}\/review\/plan\.json/);
  }
  // AI reviewer job은 PLAN artifact를 직접 받지 않는다. 승인 scope는 trusted prepare가 만든 prompt로만 전달된다.
  assert.doesNotMatch(agentSection, /plan_artifact_name|PLAN_JSON|review-plan-source/);
  // 권한은 그대로 read-only (기존 테스트가 고정).
  assert.equal((reviewWorkflow.match(/승인된 PLAN artifact 다운로드/g) ?? []).length, 2);
});
