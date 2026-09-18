import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const bootstrap = await readFile(".github/workflows/post-merge-learn.yml", "utf8");
const learnBridge = await readFile(".github/workflows/learn-auto-bridge.yml", "utf8");
const candidateBridge = await readFile(".github/workflows/candidate-auto-bridge.yml", "utf8");
const orchestrator = await readFile(".github/workflows/orchestrator.yml", "utf8");
const candidate = await readFile(".github/workflows/improvement-candidate.yml", "utf8");
const candidateSource = await readFile("src/self-improvement/improvement-candidate.ts", "utf8");

test("Human Merge completed cycle만 post-merge LEARN bootstrap 대상이다", () => {
  assert.match(bootstrap, /pull_request:\n    types: \[closed\]/);
  assert.match(bootstrap, /github\.event\.pull_request\.merged == true/);
  assert.match(bootstrap, /github\.event\.pull_request\.base\.ref == github\.event\.repository\.default_branch/);
  assert.doesNotMatch(bootstrap, /workflow_dispatch:/);
});

test("MERGE_READY PR은 exact reviewed SHA와 Trusted Rail provenance marker를 함께 가진다", () => {
  assert.match(orchestrator, /TRUSTED_RAIL_RUN_ID: \$\{\{ github\.run_id \}\}/);
  assert.match(orchestrator, /TRUSTED_RAIL_RUN_ATTEMPT: \$\{\{ github\.run_attempt \}\}/);
  assert.match(orchestrator, /ai-dev-framework:TRUSTED_RAIL run-id=/);
  assert.match(orchestrator, /orchestration-provenance-issue-/);

  assert.match(bootstrap, /ai-dev-framework:MERGE_READY issue=/);
  assert.match(bootstrap, /ai-dev-framework:TRUSTED_RAIL run-id=/);
  assert.match(bootstrap, /pr\.head\.ref !== `ai-publish\/issue-\$\{issueNumber\}`/);
  assert.match(bootstrap, /pr\.head\.sha !== reviewedSha/);
  assert.match(bootstrap, /trustedRun\.path !== '\.github\/workflows\/trusted-rail\.yml'/);
  assert.match(bootstrap, /expected one exact orchestration artifact/);
});

test("post-merge bootstrap은 exact provenance로 Trusted LEARN Source만 시작한다", () => {
  assert.match(bootstrap, /workflow_id: 'learn-source\.yml'/);
  assert.match(bootstrap, /requirement_issue_number: process\.env\.REQUIREMENT_ISSUE_NUMBER/);
  assert.match(bootstrap, /human_merge_pr_number: process\.env\.HUMAN_MERGE_PR_NUMBER/);
  assert.match(bootstrap, /trusted_rail_run_id: process\.env\.TRUSTED_RAIL_RUN_ID/);
  assert.match(bootstrap, /trusted_rail_run_attempt: process\.env\.TRUSTED_RAIL_RUN_ATTEMPT/);
  assert.match(bootstrap, /orchestration_artifact_name: process\.env\.ORCHESTRATION_ARTIFACT_NAME/);
  assert.doesNotMatch(bootstrap, /business_evidence|사용자 피드백|app-runtime|sales-order/);
});

test("LEARN Source Bridge는 source workflow의 completed-success 이후에만 LEARN을 시작한다", () => {
  assert.match(learnBridge, /workflow_run:/);
  assert.match(learnBridge, /workflows: \["Trusted LEARN Source"\]/);
  assert.match(learnBridge, /types: \[completed\]/);
  assert.match(learnBridge, /workflow_run\.conclusion == 'success'/);
  assert.match(learnBridge, /run\.path !== '\.github\/workflows\/learn-source\.yml'/);
  assert.match(learnBridge, /completed-cycle-issue-/);
  assert.match(learnBridge, /learn-input-issue-/);
  assert.match(learnBridge, /completed\.length !== 1 \|\| input\.length !== 1/);
  assert.match(learnBridge, /workflow_id: 'learn\.yml'/);
});

test("LEARN Candidate Bridge는 validated LEARN completed-success 이후 exact source identity를 전달한다", () => {
  assert.match(candidateBridge, /workflow_run:/);
  assert.match(candidateBridge, /workflows: \["Read-only AI LEARN"\]/);
  assert.match(candidateBridge, /types: \[completed\]/);
  assert.match(candidateBridge, /run\.path !== '\.github\/workflows\/learn\.yml'/);
  assert.match(candidateBridge, /learn-report-issue-/);
  assert.match(candidateBridge, /reports\.length !== 1/);
  assert.match(candidateBridge, /report\?\.source\?\.inputPack/);
  assert.match(candidateBridge, /learn-input-issue-/);
  assert.match(candidateBridge, /workflow_id: 'improvement-candidate\.yml'/);
});

test("Framework 자동 loop는 Candidate에서 멈추고 Human authority를 침범하지 않는다", () => {
  for (const workflow of [bootstrap, learnBridge, candidateBridge]) {
    assert.match(workflow, /permissions: \{\}/);
    assert.doesNotMatch(workflow, /pull-requests: write|issues: write|contents: write/);
    assert.doesNotMatch(workflow, /pulls\.create|pulls\.merge|enablePullRequestAutoMerge|git\s+push/);
  }
  assert.match(candidate, /proposal-only/);
  assert.match(candidateSource, /authority: "proposal-only"/);
  assert.match(candidateSource, /decision: "pending-human"/);
  assert.doesNotMatch(candidateBridge, /workflow_id: 'plan\.yml'|workflow_id: 'implement\.yml'/);
  assert.doesNotMatch(learnBridge, /workflow_id: 'plan\.yml'|workflow_id: 'implement\.yml'/);
  assert.doesNotMatch(bootstrap, /workflow_id: 'plan\.yml'|workflow_id: 'implement\.yml'/);
});
