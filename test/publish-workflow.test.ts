import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(".github/workflows/trusted-rail.yml", "utf8");
const publishSection =
  (workflow.split("\n  publish:\n")[1] ?? "").split("\n  verify:\n")[0] ?? "";

test("PUBLISH는 SEAL 성공과 should_run=true 뒤에만 실행된다", () => {
  assert.match(workflow, /outputs:\n      should_run: \$\{\{ steps\.candidate_artifact\.outputs\.should_run \}\}/);
  assert.match(publishSection, /needs: seal/);
  assert.match(publishSection, /needs\.seal\.result == 'success'/);
  assert.match(publishSection, /needs\.seal\.outputs\.should_run == 'true'/);
});

test("SEAL은 read-only이고 write 권한은 PUBLISH job에만 있다", () => {
  const sealSection = workflow.split("\n  publish:\n")[0] ?? "";
  assert.match(sealSection, /permissions:\n      contents: read\n      actions: read/);
  assert.doesNotMatch(sealSection, /contents: write/);
  assert.match(publishSection, /permissions:\n      contents: write\n      actions: read/);
  assert.doesNotMatch(publishSection, /pull-requests: write|issues: write/);
});

test("PUBLISH rerun은 current SEAL artifact를 우선하고 없으면 가장 최근 prior attempt를 재사용한다", () => {
  assert.match(publishSection, /name: current 또는 이전 SEAL artifact 선택/);
  assert.match(publishSection, /listWorkflowRunArtifacts/);
  assert.match(publishSection, /attempt === trustedRunAttempt/);
  assert.match(publishSection, /attempt < trustedRunAttempt/);
  assert.match(publishSection, /right\.attempt - left\.attempt/);
  assert.match(publishSection, /PUBLISH attempt \$\{trustedRunAttempt\} reuses SEAL artifact from attempt \$\{latestAttempt\}/);
  assert.match(publishSection, /name: \$\{\{ steps\.sealed_artifact\.outputs\.name \}\}/);
  assert.match(publishSection, /SEALED_ARTIFACT_NAME: \$\{\{ steps\.sealed_artifact\.outputs\.name \}\}/);
});

test("PUBLISH는 sealed artifact를 다시 검증하고 exact base worktree에 patch를 적용한다", () => {
  assert.match(publishSection, /publish-handler\.ts prepare/);
  assert.match(publishSection, /git worktree add --detach "\$PUBLISH_WORKTREE" "\$BASE_SHA"/);
  assert.match(publishSection, /apply \\\n            --index --binary --whitespace=nowarn "\$SEALED_PATCH"/);
  assert.match(publishSection, /write-tree/);
});

test("publish branch는 force overwrite 없이 idempotent 또는 fast-forward만 허용한다", () => {
  assert.match(publishSection, /ai-publish\/issue-/);
  assert.match(publishSection, /refusing non-fast-forward overwrite/);
  assert.doesNotMatch(
    publishSection,
    /git(?:\s+-C\s+"\$PUBLISH_WORKTREE")?\s+push[^\n]*(?:--force|\s-f(?:\s|$))/,
  );
  assert.match(publishSection, /PUBLISH_MODE="reused"/);
});

test("push 뒤 remote SHA를 다시 조회하고 publish.json provenance를 남긴다", () => {
  assert.match(publishSection, /REMOTE_AFTER_SHA/);
  assert.match(publishSection, /REMOTE_AFTER_SHA" != "\$PUBLISHED_HEAD_SHA/);
  assert.match(publishSection, /publish-handler\.ts finalize/);
  assert.match(publishSection, /PUBLISHED_HEAD_SHA: \$\{\{ steps\.publish\.outputs\.published_head_sha \}\}/);
  assert.match(publishSection, /publish-provenance-issue-/);
});

test("PUBLISH는 main이나 auto merge를 직접 수행하지 않는다", () => {
  assert.doesNotMatch(publishSection, /refs\/heads\/main|gh pr merge|auto-merge|AUTO_MERGE/);
});
