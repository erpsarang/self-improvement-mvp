import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  ".github/workflows/plan-worker-recovery-preflight.yml",
  "utf8",
);

test("Recovery Preflight는 명시적 Issue 하나만 입력받고 AI를 호출하지 않는다", () => {
  assert.match(workflow, /workflow_dispatch:\n    inputs:\n      issue_number:/);
  assert.match(workflow, /permissions: \{\}/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /actions: read/);
  assert.match(workflow, /issues: read/);
  assert.doesNotMatch(workflow, /openai\/codex-action|CODEX_API_KEY/);
  assert.doesNotMatch(workflow, /createWorkflowDispatch|pulls\.merge|git\s+push/);
});

test("Recovery Preflight는 STALLED_WORKER와 failed Worker/Handoff exact identity를 검증한다", () => {
  assert.match(workflow, /ai-dev-framework:STALLED_WORKER issue=/);
  assert.match(workflow, /expected at least one STALLED_WORKER marker/);
  assert.match(workflow, /expected exactly one STALLED Handoff cycle/);
  assert.match(workflow, /createdAt: comment\.created_at/);
  assert.match(workflow, /selected latest STALLED_WORKER marker/);
  assert.match(workflow, /PLAN Bounded IMPLEMENT Worker/);
  assert.match(workflow, /worker\.conclusion !== 'failure'/);
  assert.match(workflow, /baseToWorker/);
  assert.match(workflow, /workerToCurrent/);
  assert.match(workflow, /outside approved-base ancestry/);
  assert.match(workflow, /not an ancestor of current default/);
  assert.doesNotMatch(workflow, /worker\.head_sha !== source\.baseSha/);
  assert.match(workflow, /Trusted PLAN IMPLEMENT Handoff/);
  assert.match(workflow, /handoff\.conclusion !== 'success'/);
  assert.match(workflow, /expected one exact Handoff artifact/);
  assert.match(workflow, /artifact\.name === source\.handoffArtifactName/);
  assert.match(workflow, /artifact\.digest/);
});

test("Recovery Preflight는 approved base 이후 명시된 Framework recovery 파일 drift만 허용한다", () => {
  assert.match(workflow, /compareCommitsWithBasehead/);
  assert.match(workflow, /comparison\.merge_base_commit\.sha !== source\.baseSha/);
  assert.match(workflow, /files\.length > 12/);
  assert.match(workflow, /'\.github\/workflows\/plan-implement-worker\.yml'/);
  assert.match(workflow, /'\.github\/workflows\/plan-candidate-bridge\.yml'/);
  assert.match(workflow, /'test\/plan-implement-worker-workflow\.test\.ts'/);
  assert.match(workflow, /'test\/plan-candidate-bridge-workflow\.test\.ts'/);
  assert.match(workflow, /'test\/plan-candidate-bridge\.test\.ts'/);
  assert.match(workflow, /'\.github\/workflows\/plan-worker-recovery-preflight\.yml'/);
  assert.match(workflow, /'src\/self-improvement\/plan-implement-worker-handler\.ts'/);
  assert.match(workflow, /'src\/self-improvement\/plan-implement-worker\.ts'/);
  assert.match(workflow, /'src\/self-improvement\/plan-candidate-bridge-handler\.ts'/);
  assert.match(workflow, /'src\/self-improvement\/plan-candidate-bridge\.ts'/);
  assert.match(workflow, /'test\/plan-implement-worker\.test\.ts'/);
  assert.match(workflow, /'test\/plan-worker-recovery-preflight-workflow\.test\.ts'/);
  assert.match(workflow, /!\['added', 'modified'\]\.includes\(file\.status\)/);
  assert.match(workflow, /recovery requires fresh PLAN; non-approved drift/);
});

test("검증 성공 시 provenance가 포함된 RECOVERY_READY artifact만 만든다", () => {
  assert.match(workflow, /kind: 'trusted-worker-recovery-ready'/);
  assert.match(workflow, /sourceMarkerCommentId/);
  assert.match(workflow, /approvedBaseSha/);
  assert.match(workflow, /currentDefaultSha/);
  assert.match(workflow, /sourceHandoff:/);
  assert.match(workflow, /failedWorker:/);
  assert.match(workflow, /trustedCodeSha: context\.sha/);
  assert.match(workflow, /worker-recovery-ready-issue-/);
  assert.match(workflow, /RECOVERY_READY artifact 저장/);
});
