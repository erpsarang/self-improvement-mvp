import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(".github/workflows/trusted-rail.yml", "utf8");
const verifySection = workflow.split("\n  verify:\n")[1] ?? "";

test("VERIFY는 PUBLISH 성공 뒤에만 실행되고 read-only 권한을 가진다", () => {
  assert.match(verifySection, /needs: publish/);
  assert.match(verifySection, /needs\.publish\.result == 'success'/);
  assert.match(verifySection, /permissions:\n      contents: read\n      actions: read/);
  assert.doesNotMatch(verifySection, /contents: write|pull-requests: write|issues: write/);
});

test("VERIFY rerun은 current PUBLISH artifact를 우선하고 없으면 최신 prior attempt를 재사용한다", () => {
  assert.match(verifySection, /name: current 또는 이전 PUBLISH provenance artifact 선택/);
  assert.match(verifySection, /listWorkflowRunArtifacts/);
  assert.match(verifySection, /attempt === trustedRunAttempt/);
  assert.match(verifySection, /attempt < trustedRunAttempt/);
  assert.match(verifySection, /right\.attempt - left\.attempt/);
  assert.match(verifySection, /VERIFY attempt \$\{trustedRunAttempt\} reuses PUBLISH artifact from attempt \$\{latestAttempt\}/);
  assert.match(verifySection, /PUBLISH_ARTIFACT_NAME: \$\{\{ steps\.publish_artifact\.outputs\.name \}\}/);
});

test("VERIFY는 publish.json을 재검증하고 remote branch HEAD exact match를 두 번 확인한다", () => {
  assert.match(verifySection, /verify-handler\.ts prepare/);
  assert.match(verifySection, /github\.rest\.git\.getRef/);
  const mismatchChecks = verifySection.match(/data\.object\.sha !== expected/g) ?? [];
  assert.equal(mismatchChecks.length, 2);
  assert.match(verifySection, /remote publish HEAD mismatch/);
  assert.match(verifySection, /remote publish HEAD moved during VERIFY/);
});

test("검증 대상은 branch가 아니라 exact publishedHeadSha로 checkout한다", () => {
  assert.match(verifySection, /name: exact published SHA checkout/);
  assert.match(verifySection, /ref: \$\{\{ steps\.prepare_verify\.outputs\.published_head_sha \}\}/);
  assert.match(verifySection, /persist-credentials: false/);
  assert.match(verifySection, /ACTUAL_SHA="\$\(git rev-parse HEAD\)"/);
  assert.match(verifySection, /ACTUAL_SHA" != "\$EXPECTED_SHA/);
});

test("candidate 검증은 exact checkout 디렉터리에서 test/build/diff check를 실행한다", () => {
  assert.match(verifySection, /working-directory: verified-target\n        run: npm ci/);
  assert.match(verifySection, /working-directory: verified-target\n        run: npm test/);
  assert.match(verifySection, /working-directory: verified-target\n        run: npm run build/);
  assert.match(verifySection, /git show --check --format= HEAD/);
});

test("VERIFY 성공은 verified SHA provenance를 남기고 write/merge를 하지 않는다", () => {
  assert.match(verifySection, /verify-handler\.ts finalize/);
  assert.match(verifySection, /VERIFIED_HEAD_SHA: \$\{\{ steps\.verified_head\.outputs\.sha \}\}/);
  assert.match(verifySection, /verify-provenance-issue-/);
  assert.doesNotMatch(verifySection, /git\s+push|gh pr merge|auto-merge|AUTO_MERGE/);
});
