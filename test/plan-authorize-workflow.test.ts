import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/plan-authorize.yml", "utf8");
const handler = readFileSync("src/self-improvement/plan-authorize-handler.ts", "utf8");

test("PLAN_AUTHORIZE는 exact Human PLAN-승인 Issue comment에서만 시작한다", () => {
  assert.match(workflow, /issue_comment:/);
  assert.match(workflow, /types: \[created\]/);
  assert.match(workflow, /github\.event\.issue\.pull_request == null/);
  assert.match(workflow, /github\.event\.comment\.body == 'PLAN-승인'/);
});

test("PLAN_AUTHORIZE는 trusted read\/actions + Issue pointer 권한만 사용한다", () => {
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /actions: read/);
  assert.match(workflow, /issues: write/);
  assert.match(workflow, /persist-credentials: false/);
});

test("PLAN_AUTHORIZE 단계는 AI IMPLEMENT를 호출하거나 자동 Merge하지 않는다", () => {
  assert.doesNotMatch(workflow, /openai\/codex-action/);
  assert.doesNotMatch(workflow, /implement\.yml/);
  assert.doesNotMatch(workflow, /repository_dispatch/);
  assert.doesNotMatch(workflow, /merge/i);
  assert.match(workflow, /이 단계에서는 IMPLEMENT를 시작하지 않습니다/);
});

test("PLAN_AUTHORIZE artifact와 human-readable pointer를 남긴다", () => {
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /plan-authorize\.json/);
  assert.match(workflow, /self-improvement:PLAN_AUTHORIZE/);
  assert.match(workflow, /approval-comment=/);
});


test("PLAN_AUTHORIZE는 승인 불가능한 PLAN(ready=false / blocking question)을 artifact 생성 전에 fail-closed 한다", () => {
  const readiness = handler.indexOf("assertApprovablePlanArtifact(planJson");
  const authorize = handler.indexOf("createPlanAuthorizeArtifact({");
  assert.ok(readiness !== -1 && authorize !== -1 && readiness < authorize);
  assert.match(handler, /readArtifactJson\(selected\.plan\.artifact\.id, "PLAN\.json"/);
  // 거부 댓글에 남길 질문은 검증이 던지기 전에 읽는다.
  const questions = handler.indexOf("observedQuestions = planArtifactQuestions(planJson)");
  assert.ok(questions !== -1 && questions < readiness);
  // Handoff와 같은 validator를 재사용한다 (plan-decision-packet → plan-implement-handoff.validateApprovedPlanDocument).
  const packetModule = readFileSync("src/self-improvement/plan-decision-packet.ts", "utf8");
  assert.match(packetModule, /import \{ validateApprovedPlanDocument[^}]*\} from "\.\/plan-implement-handoff\.js"/);
  assert.match(packetModule, /return validateApprovedPlanDocument\(value\.plan\)/);
});

test("PLAN_AUTHORIZE 거부 사유는 GITHUB_OUTPUT을 거쳐 Issue에 HumanStatus: STOPPED로 남는다", () => {
  assert.match(handler, /recordRejection\(error\);\s*throw error;/);
  for (const name of ["rejected", "rejection_reason", "rejection_next_action", "rejection_detail", "rejection_questions"]) {
    assert.match(handler, new RegExp(`writeGithubOutput\\(outputPath, "${name}"`));
    assert.match(workflow, new RegExp(`steps\\.authorize\\.outputs\\.${name}`));
  }
  assert.match(workflow, /if: failure\(\) && steps\.authorize\.outputs\.rejected == 'true'/);
  assert.match(workflow, /self-improvement:PLAN_AUTHORIZE_REJECTED approval-comment=/);
  assert.match(workflow, /### HumanStatus: STOPPED/);
  assert.match(workflow, /PLAN_AUTHORIZE artifact는 생성되지 않았고 IMPLEMENT는 시작되지 않습니다/);
  // 거부 댓글 단계도 merge·AI 호출 권한을 갖지 않는다.
  assert.doesNotMatch(workflow, /pull-requests: write|contents: write/);
});

test("PLAN_AUTHORIZE는 수동 PLAN과 자동 issues PLAN만 provenance 후보로 허용한다", () => {
  assert.match(handler, /\["workflow_dispatch", "issues"\]\.includes\(run\.event\)/);
  assert.match(handler, /run\.name !== "Read-only AI PLAN"/);
  assert.match(handler, /run\.conclusion !== "success"/);
  assert.doesNotMatch(handler, /\["workflow_dispatch", "issues", "schedule"/);
});
