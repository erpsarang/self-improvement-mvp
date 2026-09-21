import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/plan-recovery.yml", "utf8");
const planWorkflow = readFileSync(".github/workflows/plan.yml", "utf8");
const handler = readFileSync("src/self-improvement/plan-recovery-handler.ts", "utf8");

test("PLAN Recovery는 default branch의 Trusted PLAN_AUTHORIZE 성공 run에서만 시작한다", () => {
  assert.match(workflow, /workflows: \["Trusted PLAN_AUTHORIZE"\]/);
  assert.match(workflow, /types: \[completed\]/);
  assert.match(workflow, /workflow_run\.conclusion == 'success'/);
  assert.match(workflow, /workflow_run\.head_branch == github\.event\.repository\.default_branch/);
  assert.match(workflow, /workflow_run\.event == 'issue_comment'/);
  assert.match(workflow, /run\.path !== '\.github\/workflows\/plan-authorize\.yml'/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(workflow, /persist-credentials: false/);
});

test("PLAN Recovery는 AI를 직접 호출하지 않고 repository 내용을 쓰지 않는다", () => {
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.match(workflow, /actions: write/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /issues: write/);
  assert.doesNotMatch(workflow, /contents: write|pull-requests: write/);
  assert.doesNotMatch(workflow, /codex-action|secrets\./);
  assert.doesNotMatch(workflow, /git push|gh pr|createPullRequest|enable_auto_merge/i);
});

test("PLAN Recovery handler는 exact PLAN_AUTHORIZE identity를 재검증하고 plan.yml만 dispatch한다", () => {
  assert.match(handler, /verifyPlanAuthorizeArtifact\(/);
  assert.match(handler, /sourceRun\.name !== "Trusted PLAN_AUTHORIZE"/);
  assert.match(handler, /sourceRun\.path !== "\.github\/workflows\/plan-authorize\.yml"/);
  assert.match(handler, /source PLAN_AUTHORIZE artifact identity mismatch/);
  assert.match(handler, /actions\/workflows\/plan\.yml\/dispatches/);
  assert.equal((handler.match(/\/dispatches/g) ?? []).length, 1);
  assert.match(handler, /recoveryCount >= MAX_AUTO_REPLAN_PER_AUTHORIZATION/);
  assert.match(handler, /Human `PLAN-승인`이 다시 필요합니다/);
});

test("bot이 dispatch한 recovery PLAN도 repository identity에 맞는 Codex key를 사용한다", () => {
  assert.equal((planWorkflow.match(/allow-bots: true/g) ?? []).length, 1);
  assert.doesNotMatch(planWorkflow, /allow-bot-users/);
  assert.match(planWorkflow, /openai-api-key: \$\{\{ secrets\[github\.repository == 'erpsarang\/self-improvement-mvp' && 'FRAMEWORK_CODEX_API_KEY' \|\| 'APP_CODEX_API_KEY'\] \}\}/);
  assert.match(planWorkflow, /permission-profile: ":read-only"/);
});
