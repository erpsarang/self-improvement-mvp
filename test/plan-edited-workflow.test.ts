import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/plan.yml", "utf8");
const handler = readFileSync("src/self-improvement/plan-edited-handler.ts", "utf8");
const triggers = workflow.split("\npermissions:", 1)[0] ?? "";
const gateJob = workflow.split("\n  edited_gate:\n")[1]?.split("\n  edited_notice:\n", 1)[0] ?? "";
const noticeJob = workflow.split("\n  edited_notice:\n")[1]?.split("\n  plan:\n", 1)[0] ?? "";
const planJob = workflow.split("\n  plan:\n")[1]?.split("\n  request:\n", 1)[0] ?? "";

test("업무 요구 Issue의 제목·본문 수정은 PLAN을 다시 시작하고, 같은 Issue의 run은 하나씩 돈다", () => {
  assert.match(triggers, /issues:\n    types: \[opened, edited, reopened\]/);
  // 진행 중인 run을 취소하지 않는다: executor에 이미 보낸 호출을 버리지 않기 위해서다. 대기 중인 run은 최신 편집 하나만 남는다.
  assert.match(workflow, /concurrency:\n  group: plan-\$\{\{ github\.event\.issue\.number \|\| inputs\.issue_number \}\}\n  cancel-in-progress: false/);
});

test("edited gate는 읽기 권한만 갖고, edited 이벤트에서만 Framework runtime으로 판정하며, 그 밖에는 바로 start=true다", () => {
  assert.ok(gateJob.length > 0, "edited_gate job이 plan job 앞에 있어야 한다");
  const permissions = gateJob.split("\n    steps:\n", 1)[0] ?? "";
  assert.match(permissions, /permissions:\s+contents: read\s+issues: read/);
  assert.doesNotMatch(permissions, /write/);
  assert.match(gateJob, /github\.event\.action != 'edited'/);
  assert.match(gateJob, /if: github\.event_name == 'issues' && github\.event\.action == 'edited'/);
  assert.match(gateJob, /plan-edited-handler\.ts/);
  assert.match(gateJob, /ISSUE_NUMBER: \$\{\{ github\.event\.issue\.number \}\}/);
  assert.doesNotMatch(gateJob, /secrets\.|AI_EXECUTOR_REPOSITORY|dispatches/);
});

test("plan job은 gate가 start=true일 때만 돌고 기존 ingress gate(제목 prefix, 저장소 구성원)는 그대로다", () => {
  const condition = planJob.split("\n    outputs:\n", 1)[0] ?? "";
  assert.match(condition, /needs: edited_gate/);
  assert.match(condition, /needs\.edited_gate\.outputs\.start == 'true'/);
  assert.match(condition, /startsWith\(github\.event\.issue\.title, '\[업무 요구\]'\)/);
  assert.match(condition, /contains\(fromJSON\('\["OWNER","MEMBER","COLLABORATOR"\]'\), github\.event\.issue\.author_association\)/);
});

test("gate handler는 trusted bot의 PLAN_REQUEST marker와 현재 digest만 보고 AI나 dispatch를 부르지 않는다", () => {
  assert.match(handler, /const TRUSTED_COMMENT_LOGIN = "github-actions\[bot\]"/);
  assert.match(handler, /requirementDigest\(issue\.title, issue\.body \?\? null\)/);
  assert.match(handler, /parsePlanRequestRecords\(trustedBodies, issueNumber\)/);
  assert.doesNotMatch(handler, /dispatches|createComment|method: "POST"/);
});

test("상한에 걸려 시작하지 않을 때만 Issue에 짧게 알리고, PLAN_FAILED 안내는 본문 수정이 PLAN을 다시 시작함을 말한다", () => {
  assert.ok(noticeJob.length > 0);
  assert.match(noticeJob, /needs\.edited_gate\.outputs\.outcome == 'CAP_REACHED'/);
  assert.match(noticeJob, /permissions:\n      issues: write/);
  assert.match(noticeJob, /HumanStatus: PLAN_FAILED/);
  assert.match(noticeJob, /self-improvement:AUTO_PLAN_CAP issue=\$\{issueNumber\} requirement=\$\{digest\}/);
  assert.match(workflow, /Issue 본문이나 제목을 고치면 PLAN이 자동으로 다시 시작됩니다/);
  assert.doesNotMatch(workflow, /본문을 고치는 것만으로는 PLAN이 다시 시작되지 않습니다/);
});
