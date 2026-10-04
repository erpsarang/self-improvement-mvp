import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { freeze } from "./plan-provenance.test.js";

// Requirement가 어디에서 왔는지는 provenance이고, 승인된 Requirement가 어떻게 개발되는지는 하나의 lifecycle이다.
// 이 테스트는 PLAN identity가 source를 "기록"만 하고, 어떤 source도 다른 lifecycle로 보내지 않음을 고정한다.

const workflow = readFileSync(".github/workflows/plan.yml", "utf8");
const marker = `<!-- ai-dev-framework:PRODUCT_IMPROVEMENT cycle-issue=203 cycle-pr=204 snapshot=${"0".repeat(64)} -->`;

test("사람이 만든 Issue는 issues 이벤트로 들어오며 source=HUMAN, trust=author association으로 기록된다", async () => {
  const identity = await freeze("[업무 요구] 사람이 쓴 요구", "본문", { event: "issues", association: "OWNER" });
  assert.deepEqual(identity.source, {
    kind: "HUMAN",
    ingress: "issues",
    trust: { level: "VERIFIED", by: "issue-author-association", association: "OWNER" },
    author: { login: "member", id: 8370921, type: "User", association: "OWNER" },
  });
});

test("Product Evaluation이 만든 Issue는 trusted dispatch로 들어오며 source=PRODUCT_EVALUATION과 cycle provenance가 기록된다", async () => {
  const identity = await freeze("[Self-Improvement] 후보", `${marker}\n\n## 어떤 업무가 불편한가요?\n\n본문`, {
    event: "workflow_dispatch", actor: "github-actions[bot]",
    user: { login: "github-actions[bot]", id: 41898282, type: "Bot" }, association: "CONTRIBUTOR",
  });
  assert.equal(identity.source.kind, "PRODUCT_EVALUATION");
  assert.equal(identity.source.ingress, "workflow_dispatch");
  assert.deepEqual(identity.source.trust, { level: "VERIFIED", by: "workflow-dispatch-authority", dispatchedBy: "github-actions[bot]" });
  assert.deepEqual(identity.source.productImprovement, { cycleIssue: 203, cyclePullRequest: 204, snapshotDigest: "0".repeat(64) });
});

test("사람 Issue를 trusted dispatch(재PLAN/수동)로 다시 시작해도 Requirement source는 HUMAN으로 남고 ingress만 달라진다", async () => {
  const identity = await freeze("[업무 요구] 사람이 쓴 요구", "본문", { event: "workflow_dispatch", actor: "member" });
  assert.equal(identity.source.kind, "HUMAN");
  assert.equal(identity.source.ingress, "workflow_dispatch");
  assert.equal(identity.source.trust.by, "workflow-dispatch-authority");
});

test("marker 없는 bot Issue는 OTHER_TRUSTED_SOURCE로 기록되며 trusted dispatch로만 도달한다", async () => {
  const identity = await freeze("[업무 요구] 외부 자동화 요구", "본문", {
    event: "workflow_dispatch", actor: "member", user: { login: "some-bot[bot]", id: 1, type: "Bot" }, association: "NONE",
  });
  assert.equal(identity.source.kind, "OTHER_TRUSTED_SOURCE");
});

test("지원하지 않는 ingress 이벤트는 fail-closed한다", async () => {
  await assert.rejects(freeze("[업무 요구] 요구", "본문", { event: "issue_comment" }), /Unsupported PLAN ingress event/);
});

test("source는 identity/provenance/pointer 댓글에만 기록되고 PLAN 이후 lifecycle은 source로 분기하지 않는다", () => {
  // plan.yml 자체에서 source로 다른 step/job을 고르는 조건이 없어야 한다.
  assert.doesNotMatch(workflow, /if: .*source\./);
  assert.match(workflow, /Requirement source: \$\{identity\.source\.kind\}/);
  // 다운스트림 trusted workflow는 Issue 제목 prefix나 source로 분기하지 않는다.
  for (const path of [
    ".github/workflows/plan-authorize.yml",
    ".github/workflows/plan-implement-handoff.yml",
    ".github/workflows/plan-implement-worker.yml",
    ".github/workflows/plan-candidate-bridge.yml",
    ".github/workflows/trusted-rail.yml",
    ".github/workflows/orchestrator.yml",
  ]) {
    const text = readFileSync(path, "utf8");
    assert.doesNotMatch(text, /\[업무 요구\]|\[Self-Improvement\]|source\.kind|PRODUCT_IMPROVEMENT/, path);
  }
});

// PLAN 기본 모델은 sonnet이다 (#344). 사람이 템플릿의 "복잡한 요구" 체크박스를 체크한 요구만 opus를 쓴다.
// 별도 AI 라우터 없이 freeze step이 본문만 보고 결정한다. PLAN당 호출 수는 그대로다.
async function plannerModel(title: string, body: string, options: Parameters<typeof freeze>[2] & object) {
  const outputs: Record<string, string> = {};
  await freeze(title, body, { ...options, outputs });
  assert.ok("planner_model" in outputs, "Freeze step must always set planner_model");
  return outputs.planner_model;
}

const productEvaluationDispatch = {
  event: "workflow_dispatch", actor: "github-actions[bot]",
  user: { login: "github-actions[bot]", id: 41898282, type: "Bot" }, association: "CONTRIBUTOR",
} as const;
const complexChecked = "## 복잡한 요구인가요? (선택)\n\n- [x] 복잡한 요구입니다\n";
const complexUnchecked = "## 복잡한 요구인가요? (선택)\n\n- [ ] 복잡한 요구입니다\n";

test("Product Evaluation이 만든 [Self-Improvement] 후보의 자동 PLAN은 sonnet을 쓴다", async () => {
  assert.equal(await plannerModel("[Self-Improvement] 후보", `${marker}\n\n본문`, productEvaluationDispatch), "sonnet");
});

test("Product Discovery가 만든 Issue도 source=PRODUCT_EVALUATION이고 Discovery provenance가 기록된다", async () => {
  const discoveryMarker = `<!-- ai-dev-framework:PRODUCT_IMPROVEMENT discovery-issue=40 discovery-run=36121809205 snapshot=${"1".repeat(64)} -->`;
  const identity = await freeze("[Self-Improvement] 후보", `${discoveryMarker}\n\n## 어떤 업무가 불편한가요?\n\n본문`, productEvaluationDispatch);
  assert.equal(identity.source.kind, "PRODUCT_EVALUATION");
  assert.deepEqual(identity.source.productImprovement, { discoveryIssue: 40, discoveryRun: 36121809205, snapshotDigest: "1".repeat(64) });
  assert.equal(await plannerModel("[Self-Improvement] 후보", `${discoveryMarker}\n\n본문`, productEvaluationDispatch), "sonnet");
});

test("사람이 만든 [업무 요구] PLAN의 기본 모델은 sonnet이다", async () => {
  assert.equal(await plannerModel("[업무 요구] 사람이 쓴 요구", "본문", { event: "issues", association: "OWNER" }), "sonnet");
  assert.equal(await plannerModel("[업무 요구] 사람이 쓴 요구", "본문", { event: "workflow_dispatch", actor: "member" }), "sonnet");
  // 템플릿 그대로 체크하지 않은 체크박스는 sonnet이다.
  assert.equal(await plannerModel("[업무 요구] 요구", `본문\n\n${complexUnchecked}`, { event: "issues", association: "OWNER" }), "sonnet");
  // 체크박스 문구를 문장 안에서 언급만 한 경우도 sonnet이다.
  assert.equal(await plannerModel("[업무 요구] 요구", "본문에서 [x] 복잡한 요구입니다 라고 썼다", { event: "issues", association: "OWNER" }), "sonnet");
});

test("사람이 복잡한 요구 체크박스를 체크한 PLAN만 opus를 쓴다", async () => {
  assert.equal(await plannerModel("[업무 요구] 요구", `본문\n\n${complexChecked}`, { event: "issues", association: "OWNER" }), "opus");
  assert.equal(await plannerModel("[업무 요구] 요구", `본문\n\n${complexChecked}`, { event: "workflow_dispatch", actor: "member" }), "opus");
  assert.equal(await plannerModel("[업무 요구] 요구", "본문\n\n* [X] 복잡한 요구입니다 (구조 변경)", { event: "issues", association: "OWNER" }), "opus");
  // 체크 여부는 본문이므로 requirement digest에 포함된다. 체크를 바꾸면 다른 requirement다.
  const checked = await freeze("[업무 요구] 요구", `본문\n\n${complexChecked}`, { event: "issues", association: "OWNER" });
  const unchecked = await freeze("[업무 요구] 요구", `본문\n\n${complexUnchecked}`, { event: "issues", association: "OWNER" });
  assert.notEqual(checked.requirement.digest, unchecked.requirement.digest);
});

test("사람이 쓰지 않은 본문은 체크박스가 있어도 opus로 올리지 않는다", async () => {
  // Product Evaluation 후보 본문은 AI가 쓴 것이다.
  assert.equal(await plannerModel("[Self-Improvement] 후보", `${marker}\n\n${complexChecked}`, productEvaluationDispatch), "sonnet");
  // 사람이 marker를 붙이면 source=PRODUCT_EVALUATION이 되어 체크박스를 보지 않는다.
  assert.equal(await plannerModel("[업무 요구] 요구", `${marker}\n\n${complexChecked}`, { event: "issues", association: "OWNER" }), "sonnet");
  // 그 밖의 자동화가 만든 Issue(OTHER_TRUSTED_SOURCE)도 올리지 않는다.
  assert.equal(await plannerModel("[업무 요구] 요구", `본문\n\n${complexChecked}`, { ...productEvaluationDispatch, user: { login: "other-app[bot]", id: 1, type: "Bot" } }), "sonnet");
});

test("Issue 템플릿의 체크박스 문구는 PLAN 모델 판별 문구와 같고 기본은 체크되지 않은 상태다", () => {
  const template = readFileSync(".github/ISSUE_TEMPLATE/user-requirement.md", "utf8");
  assert.match(template, /\n- \[ \] 복잡한 요구입니다\n/);
  assert.doesNotMatch(template, /\[[xX]\] 복잡한 요구입니다/);
  assert.ok(workflow.includes("[ \\t]+복잡한 요구입니다/m.test(issue.body)"));
});

test("planner model은 private subscription request marker에만 연결되고 public PLAN은 AI를 직접 호출하지 않는다", () => {
  assert.match(workflow, /PLAN_MODEL: \$\{\{ needs\.plan\.outputs\.planner_model \}\}/);
  assert.match(workflow, /model=\$\{model\} -->/);
  assert.equal((workflow.match(/uses:\s*anthropics\/claude-code-action/g) ?? []).length, 0);
  assert.equal((workflow.match(/uses:\s*openai\/codex-action/g) ?? []).length, 0);
  assert.match(workflow, /core\.setOutput\('planner_model', source\.kind === 'HUMAN' && complexRequirement \? 'opus' : 'sonnet'\);/);
});

test("PLAN result는 OWNER comment + gzip-base64 payload만 trusted validation으로 넘긴다", () => {
  assert.match(workflow, /comment\.author_association === 'OWNER'/);
  assert.match(workflow, /PLAN_RESULT_GZIP_BASE64/);
  assert.match(workflow, /gunzipSync/);
  assert.match(workflow, /Validate bounded PLAN against fresh exact SHA/);
  assert.doesNotMatch(workflow, /CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY/);
});

