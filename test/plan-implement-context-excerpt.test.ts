import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createImplementContextPack, verifyImplementContextPack } from "../src/self-improvement/context-pack.js";
import { createImplementContract, type ApprovedPlanIdentity } from "../src/self-improvement/implement-contract.js";
import { aiCallSiteCandidates } from "../src/self-improvement/plan-ai-call-site-context.js";
import { PLAN_IMPLEMENT_MAX_CONTEXT_BYTES, PLAN_IMPLEMENT_MAX_PATCH_BYTES } from "../src/self-improvement/plan-implement-handoff.js";
import { createSinglePassPrompt } from "../src/self-improvement/single-pass-worker.js";

// self-improvement-mvp #244 (run 35976744079): 승인된 첫 slice는 새 파일 3개를 allowedPaths로, Planner가 본
// lifecycle AI 호출 workflow들을 read-only contextPaths로 가졌다. Handoff는 contextPaths를 전체 파일로 넣으려다
// "Context Pack exceeds maxContextBytes"로 fail-closed 했다. 이 테스트는 실제 repo의 그 모양을 재현하고,
// 승인된 PLAN evidence 발췌 재사용으로 80KB 안에서 Worker 입력이 만들어지는지 고정한다.

const REQUIREMENT = "[업무 요구] AI 호출 비용을 서비스 품질 저하 없이 절감하고 싶다\n\n각 AI 단계의 모델과 reasoning effort를 명시적으로 선택하고 비용·품질을 비교할 수 있어야 한다.";

const identity: ApprovedPlanIdentity = {
  requirement: { issueNumber: 244, digest: "a".repeat(64) },
  repository: "erpsarang/self-improvement-mvp",
  targetSha: "b".repeat(40),
  plan: {
    runId: 35976237047,
    runAttempt: 1,
    artifact: { name: "plan-issue-244-35976237047-attempt-1", id: 10798326805, digest: "c".repeat(64) },
    provenanceArtifact: { name: "plan-issue-244-35976237047-attempt-1-provenance", id: 10798755254, digest: "d".repeat(64) },
  },
  approval: { commentId: 5810805042, approverUserId: 8370921 },
};

test("#244 모양: 새 파일 3개 + lifecycle workflow contextPaths는 승인된 PLAN evidence 발췌로 80KB 안에 들어간다", () => {
  const target = process.cwd();
  const callSites = aiCallSiteCandidates(REQUIREMENT, target).filter((file) => !/-smoke\.yml$/.test(file.path));
  assert.ok(callSites.length >= 7, `expected the lifecycle call sites, got ${callSites.map((file) => file.path).join(", ")}`);
  const packageJson = readFileSync(join(target, "package.json"), "utf8");
  const evidence = [
    ...callSites.map((file) => ({ path: file.path, startOffset: file.startOffset, content: file.content, contentDigest: file.contentDigest })),
    { path: "package.json", startOffset: 0, content: packageJson, contentDigest: createHash("sha256").update(packageJson, "utf8").digest("hex") },
  ];
  const contextPaths = evidence.map((file) => file.path).slice(0, 8);

  const contract = createImplementContract(identity, {
    allowedPaths: ["src/ai-execution-policy.ts", "test/ai-execution-policy.test.ts", "docs/ai-execution-policy.md"],
    contextPaths,
    requiredChanges: ["src/ai-execution-policy.ts에 단계별 실행 정책 검증과 비교를 구현한다"],
    forbiddenChanges: ["기존 workflow 및 실제 AI 실행 경로 변경"],
    validationCommands: ["npm test"],
    maxFilesChanged: 3,
    maxContextBytes: PLAN_IMPLEMENT_MAX_CONTEXT_BYTES,
    maxPatchBytes: PLAN_IMPLEMENT_MAX_PATCH_BYTES,
  });

  // 전체 파일로는 예산을 넘는다 (workflow 원본 합계 ≫ 80KB): 이것이 run 35976744079의 실패다.
  const fullBytes = contextPaths.reduce((sum, path) => sum + Buffer.byteLength(readFileSync(join(target, path))), 0);
  assert.ok(fullBytes > PLAN_IMPLEMENT_MAX_CONTEXT_BYTES, `full contextPaths must exceed the budget to reproduce the failure (${fullBytes}B)`);
  assert.throws(() => createImplementContextPack(contract, target, identity.targetSha), /exceeds maxContextBytes/);

  // 승인된 PLAN evidence를 넘기면 read-only contextPath는 Planner가 본 발췌가 되고 예산 안에 들어간다.
  const pack = createImplementContextPack(contract, target, identity.targetSha, { approvedPlanEvidence: evidence });
  assert.doesNotThrow(() => verifyImplementContextPack(pack, contract));
  assert.ok(pack.totalContextBytes <= PLAN_IMPLEMENT_MAX_CONTEXT_BYTES);

  for (const path of contract.scope.allowedPaths) {
    assert.equal(pack.files.find((file) => file.path === path)?.state, "missing", `${path} is a new file`);
  }
  for (const evidenceFile of evidence.filter((file) => contextPaths.includes(file.path))) {
    const file = pack.files.find((entry) => entry.path === evidenceFile.path);
    assert.ok(file && file.state !== "missing", evidenceFile.path);
    if (file.state === "excerpt") {
      // Worker는 Planner가 본 근거를 글자 그대로 본다.
      assert.equal(file.content, evidenceFile.content, evidenceFile.path);
      const frozen = readFileSync(join(target, file.path), "utf8");
      assert.equal(frozen.slice(file.startOffset, file.startOffset + file.content.length), file.content);
      assert.equal(file.sourceContentDigest, createHash("sha256").update(frozen, "utf8").digest("hex"));
    } else {
      // 예산이 허용한 작은 파일(package.json)은 전체 파일이어도 된다. 발췌보다 적게 보는 일은 없다.
      assert.ok(file.content.includes(evidenceFile.content), evidenceFile.path);
    }
  }
  const excerptPaths = pack.files.filter((file) => file.state === "excerpt").map((file) => file.path);
  assert.ok(excerptPaths.length >= 1);
  // Planner가 전체를 본 작은 파일(package.json)은 발췌가 아니라 present로 남는다.
  assert.equal(pack.files.find((file) => file.path === "package.json")?.state, "present");
  assert.ok(!excerptPaths.includes("package.json"));
  for (const path of excerptPaths) assert.ok(!contract.scope.allowedPaths.includes(path));

  // Worker prompt는 같은 pack으로 결정적으로 만들어지고 발췌 규칙을 담는다.
  const prompt = createSinglePassPrompt(contract, pack);
  assert.match(prompt, /excerpt 파일은 승인된 PLAN이 본 read-only 발췌입니다/);
  assert.equal(createSinglePassPrompt(contract, pack), prompt);
});
