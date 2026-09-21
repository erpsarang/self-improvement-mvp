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


test("PLAN_AUTHORIZE는 수동 PLAN과 자동 issues PLAN만 provenance 후보로 허용한다", () => {
  assert.match(handler, /\["workflow_dispatch", "issues"\]\.includes\(run\.event\)/);
  assert.match(handler, /run\.name !== "Read-only AI PLAN"/);
  assert.match(handler, /run\.conclusion !== "success"/);
  assert.doesNotMatch(handler, /\["workflow_dispatch", "issues", "schedule"/);
});
