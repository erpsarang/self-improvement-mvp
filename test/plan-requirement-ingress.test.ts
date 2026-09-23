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
