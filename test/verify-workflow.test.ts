import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(".github/workflows/trusted-rail.yml", "utf8");
const prepareSection = workflow.split("\n  verify_prepare:\n")[1]?.split("\n  verify_candidate:\n")[0] ?? "";
const candidateSection = workflow.split("\n  verify_candidate:\n")[1]?.split("\n  verify_finalize:\n")[0] ?? "";
const finalizeSection = workflow.split("\n  verify_finalize:\n")[1] ?? "";

test("VERIFY는 trusted prepare → isolated candidate → trusted finalize의 세 job으로 분리된다", () => {
  assert.match(workflow, /\n  verify_prepare:\n/);
  assert.match(workflow, /\n  verify_candidate:\n/);
  assert.match(workflow, /\n  verify_finalize:\n/);
  assert.match(candidateSection, /needs: verify_prepare/);
  assert.match(finalizeSection, /needs: \[verify_prepare, verify_candidate\]/);
  assert.match(finalizeSection, /needs\.verify_candidate\.result == 'success'/);
});

test("trusted VERIFY prepare/finalize는 read-only이고 candidate job에도 write 권한이 없다", () => {
  assert.match(prepareSection, /permissions:\n      contents: read\n      actions: read/);
  assert.match(candidateSection, /permissions:\n      contents: read/);
  assert.match(finalizeSection, /permissions:\n      contents: read\n      actions: read/);
  for (const section of [prepareSection, candidateSection, finalizeSection]) {
    assert.doesNotMatch(section, /contents: write|pull-requests: write|issues: write/);
  }
});

test("candidate runner에는 trusted handler와 PUBLISH provenance가 존재하지 않는다", () => {
  assert.doesNotMatch(candidateSection, /verify-handler\.ts|publish\.json|actions\/download-artifact/);
  assert.match(candidateSection, /GITHUB_TOKEN: ""/);
  assert.match(candidateSection, /GH_TOKEN: ""/);
  assert.match(candidateSection, /NODE_AUTH_TOKEN: ""/);
  assert.match(candidateSection, /NPM_TOKEN: ""/);
});

test("candidate 검증 대상은 trusted prepare가 정한 exact publishedHeadSha뿐이다", () => {
  assert.match(candidateSection, /ref: \$\{\{ needs\.verify_prepare\.outputs\.published_head_sha \}\}/);
  assert.match(candidateSection, /persist-credentials: false/);
  assert.match(candidateSection, /ACTUAL_SHA="\$\(git rev-parse HEAD\)"/);
  assert.match(candidateSection, /ACTUAL_SHA" != "\$EXPECTED_SHA/);
  assert.match(candidateSection, /working-directory: verified-target\n        run: npm ci/);
  assert.match(candidateSection, /working-directory: verified-target\n        run: npm test/);
  assert.match(candidateSection, /working-directory: verified-target\n        run: npm run build/);
  assert.match(candidateSection, /git show --check --format= HEAD/);
});

test("PUBLISH provenance는 prepare와 finalize의 trusted runner에서 각각 재검증된다", () => {
  assert.match(prepareSection, /verify-handler\.ts prepare/);
  assert.match(finalizeSection, /verify-handler\.ts prepare/);
  assert.match(finalizeSection, /prepare와 동일 PUBLISH artifact인지 확인/);
  assert.match(finalizeSection, /VERIFY provenance identity changed between prepare and finalize/);
});

test("remote publish HEAD는 candidate 실행 전과 trusted finalize에서 exact match를 확인한다", () => {
  assert.match(prepareSection, /remote publish HEAD exact match 확인/);
  assert.match(prepareSection, /data\.object\.sha !== expected/);
  assert.match(finalizeSection, /검증 종료 시 remote publish HEAD 재확인/);
  assert.match(finalizeSection, /data\.object\.sha !== expected/);
});

test("candidate job 성공만 trusted finalize의 전제이며 candidate 산출물은 provenance 입력이 아니다", () => {
  assert.match(finalizeSection, /needs\.verify_candidate\.result == 'success'/);
  assert.doesNotMatch(finalizeSection, /needs\.verify_candidate\.outputs/);
  assert.match(finalizeSection, /VERIFIED_HEAD_SHA: \$\{\{ steps\.revalidate_verify\.outputs\.published_head_sha \}\}/);
  assert.match(finalizeSection, /verify-handler\.ts finalize/);
  assert.match(finalizeSection, /verify-provenance-issue-/);
});

test("VERIFY 어느 job도 push/merge를 수행하지 않는다", () => {
  const verifySections = `${prepareSection}\n${candidateSection}\n${finalizeSection}`;
  assert.doesNotMatch(verifySections, /git\s+push|gh pr merge|auto-merge|AUTO_MERGE/);
});
