import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/plan-implement-handoff.yml", "utf8");
const handler = readFileSync("src/self-improvement/plan-implement-handoff-handler.ts", "utf8");

test("handoff는 Trusted PLAN_AUTHORIZE만 source로 사용한다", () => {
  assert.match(workflow, /workflows:\s*\["Trusted PLAN_AUTHORIZE"\]/);
  assert.match(workflow, /run\.path !== '\.github\/workflows\/plan-authorize\.yml'/);
  assert.match(workflow, /workflow_run\.event == 'issue_comment'/);
  assert.doesNotMatch(workflow, /workflows:\s*\["Trusted AUTHORIZE"\]/);
  assert.doesNotMatch(workflow, /SI-승인/);
});

test("handoff workflow는 read-only 권한(+STOPPED 댓글용 issues write)이고 Worker나 Merge를 실행하지 않는다", () => {
  assert.match(workflow, /permissions:\s*\{\}/);
  assert.match(workflow, /permissions:\n\s+contents: read\n\s+actions: read\n\s+issues: write/);
  assert.doesNotMatch(workflow, /contents: write/);
  assert.doesNotMatch(workflow, /pull-requests: write/);
  assert.doesNotMatch(workflow, /openai\/codex-action/);
  assert.doesNotMatch(workflow, /git push/);
  assert.doesNotMatch(workflow, /pulls\.create/);
  // issues write는 fail-closed STOPPED 댓글 한 곳에서만 쓴다: createComment 1회, 다른 issues API 없음.
  assert.equal(workflow.match(/issues: write/g)?.length, 1);
  assert.equal(workflow.match(/github\.rest\.issues\.createComment/g)?.length, 1);
  assert.doesNotMatch(workflow, /issues\.update|issues\.create\(|issues\.addLabels|issues\.lock/);
});

test("handoff fail-closed는 Requirement Issue에 STOPPED 댓글 하나를 idempotent하게 남긴다", () => {
  // prepare와 context 두 step 모두 rejected output을 낼 수 있고, 둘 중 하나라도 실패하면 댓글을 남긴다.
  assert.match(workflow, /id: prepare/);
  assert.match(workflow, /id: context/);
  assert.match(workflow, /failure\(\) &&\n\s+steps\.source\.outputs\.should_run == 'true' &&\n\s+steps\.prepare\.outputs\.issue_number != '' &&\n\s+\(steps\.prepare\.outputs\.rejected == 'true' \|\| steps\.context\.outputs\.rejected == 'true'\)/);
  assert.match(workflow, /self-improvement:PLAN_IMPLEMENT_HANDOFF_REJECTED source-artifact=/);
  assert.match(workflow, /handoff rejection already recorded/);
  assert.match(workflow, /## IMPLEMENT Handoff가 fail-closed로 중단됨/);
  assert.match(workflow, /### HumanStatus: STOPPED/);
  assert.match(workflow, /IMPLEMENT Worker는 시작되지 않았고/);
  // handler는 어떤 예외든 rejected/rejection_reason output으로 남기고 다시 던진다 (fail-closed 유지).
  assert.match(handler, /output\("issue_number", String\(authorization\.requirement\.issueNumber\)\)/);
  assert.match(handler, /function recordRejection\(error: unknown\)/);
  assert.match(handler, /output\("rejected", "true"\)/);
  assert.match(handler, /recordRejection\(error\);\n\s+throw error;/);
});

test("handoff는 승인된 PLAN이 실제로 본 evidence를 같은 artifact에서 읽어 IMPLEMENT Context 발췌 근거로 넘긴다", () => {
  assert.match(handler, /readArtifactJsonFiles\(authorization\.plan\.artifact\.id, \["PLAN\.json", "PLAN-context\.json"\]\)/);
  assert.match(handler, /verifyApprovedPlanContext\(planJson, planFiles\.get\("PLAN-context\.json"\), authorization\)/);
  assert.match(handler, /approvedPlanEvidence: approvedPlanEvidenceFrom\(planContext\)/);
  assert.match(handler, /representation: "plan-excerpt"/);
  assert.match(handler, /contextMaterialization,/);
});

test("rerun replay는 duplicate handoff 대신 no-op을 명시한다", () => {
  assert.match(workflow, /prior\.length === 1 && matches\.length === 1/);
  assert.match(workflow, /handoff is a no-op/);
  assert.match(workflow, /authorizeJobs\[0\]\.conclusion === 'skipped'/);
});

test("production artifact에는 Contract, Context, Worker input과 provenance manifest가 함께 저장된다", () => {
  for (const file of ["contract.json", "context.json", "prompt.md", "schema.json", "handoff.json", "source.json"]) {
    assert.match(workflow, new RegExp(file.replace(".", "\\.")));
  }
  assert.match(workflow, /exact approved base SHA checkout/);
  assert.match(workflow, /OBSERVED_BASE_SHA/);
});


test("handoff는 수동 PLAN과 자동 issues PLAN만 승인 PLAN identity로 허용한다", () => {
  assert.match(handler, /\["workflow_dispatch", "issues"\]\.includes\(planRun\.event\)/);
  assert.match(handler, /planRun\.name !== "Read-only AI PLAN"/);
  assert.match(handler, /planRun\.path !== PLAN_WORKFLOW_PATH/);
  assert.match(handler, /planRun\.conclusion !== "success"/);
  assert.doesNotMatch(handler, /\["workflow_dispatch", "issues", "schedule"/);
});
