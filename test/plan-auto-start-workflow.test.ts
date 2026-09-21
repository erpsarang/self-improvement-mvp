import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(".github/workflows/plan.yml", "utf8");

test("업무 요구 Issue opened/reopened는 PLAN을 자동 시작한다", () => {
  assert.match(workflow, /issues:\s*\n\s*types: \[opened, reopened\]/);
  assert.match(workflow, /github\.event_name == 'issues'/);
  assert.match(workflow, /startsWith\(github\.event\.issue\.title, '\[업무 요구\]'\)/);
  assert.match(
    workflow,
    /ISSUE_NUMBER: \$\{\{ github\.event_name == 'issues' && github\.event\.issue\.number \|\| inputs\.issue_number \}\}/,
  );
});

test("기존 수동 workflow_dispatch와 Human PLAN 승인 경계는 유지한다", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /issue_number:/);
  assert.match(workflow, /required: true/);
  assert.match(workflow, /Leave human-readable PLAN pointer on requirement Issue/);
  assert.match(workflow, /AI가 계획을 제안했습니다\. 아직 구현 승인이 아닙니다\./);
});

test("일반 Issue는 제목 prefix 조건을 통과할 수 없다", () => {
  const planJob = workflow.split("\n  plan:\n")[1]?.split("\n  provenance:\n", 1)[0] ?? "";
  assert.match(planJob, /startsWith\(github\.event\.issue\.title, '\[업무 요구\]'\)/);
  assert.doesNotMatch(planJob, /\[Framework Start\]|\[Cost Ledger\]|\[사용자 피드백\]/);
});

test("자동 PLAN은 repository OWNER/MEMBER/COLLABORATOR가 연 Issue에서만 AI를 시작한다", () => {
  const planJob = workflow.split("\n  plan:\n")[1]?.split("\n  provenance:\n", 1)[0] ?? "";
  const condition = planJob.split("\n    outputs:\n", 1)[0] ?? "";
  assert.match(
    condition,
    /github\.event_name == 'issues' &&\s+startsWith\(github\.event\.issue\.title, '\[업무 요구\]'\) &&\s+contains\(fromJSON\('\["OWNER","MEMBER","COLLABORATOR"\]'\), github\.event\.issue\.author_association\)\)/,
  );
  assert.doesNotMatch(condition, /CONTRIBUTOR|FIRST_TIME|NONE/);
  // issues 조건은 하나뿐이고, author gate 없이 통과하는 issues 분기가 없다.
  assert.equal((condition.match(/github\.event_name == 'issues'/g) ?? []).length, 1);
});

test("동일 PLAN run의 AI 호출은 최대 2 attempts로 제한하고 Framework 전용 key만 사용한다", () => {
  const guardIndex = workflow.indexOf("PLAN AI rerun 비용 상한 확인");
  const plannerIndex = workflow.indexOf("Read-only bounded AI Planner");
  assert.ok(guardIndex >= 0 && plannerIndex > guardIndex);
  assert.match(workflow, /\[ "\$GITHUB_RUN_ATTEMPT" -gt 2 \]/);
  assert.match(workflow, /openai-api-key: \$\{\{ secrets\[github\.repository == 'erpsarang\/self-improvement-mvp' && 'FRAMEWORK_CODEX_API_KEY' \|\| 'APP_CODEX_API_KEY'\] \}\}/);
  assert.doesNotMatch(workflow, /secrets\.[A-Za-z0-9_]+/);
});
