/**
 * 테스트 전용: PLAN 계보 candidate가 Bridge → SEAL → PUBLISH → VERIFY까지 통과한 exact provenance chain과
 * 사람이 승인한 PLAN artifact(PLAN.json)를 함께 만든다. Semantic REVIEW / FIX / Orchestrator가
 * 승인된 PLAN slice를 authority로 삼는지 고정하는 회귀 테스트가 공유한다.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createImplementContextPack } from "../../src/self-improvement/context-pack.js";
import type { DeterministicValidationResult } from "../../src/self-improvement/deterministic-ci.js";
import { createImplementContract } from "../../src/self-improvement/implement-contract.js";
import {
  createPlanAuthorizeArtifact,
  planAuthorizeArtifactName,
  requirementDigest,
} from "../../src/self-improvement/plan-authorization.js";
import {
  createPlanCandidateBridgeProvenance,
  freezePlanRequirement,
  PLAN_CANDIDATE_BRIDGE_WORKFLOW_PATH,
  planCandidateBridgeArtifactName,
  type PlanCandidateWorkerSourceRun,
} from "../../src/self-improvement/plan-candidate-bridge.js";
import {
  createPlanImplementHandoffManifest,
  planImplementHandoffArtifactName,
} from "../../src/self-improvement/plan-implement-handoff.js";
import {
  createWorkerCandidateProvenance,
  verifyPlanImplementWorkerBundle,
  workerCandidateArtifactName,
  type PlanImplementWorkerSourceRun,
} from "../../src/self-improvement/plan-implement-worker.js";
import { createPublishProvenance } from "../../src/self-improvement/publish.js";
import { sealPlanBridgeCandidate } from "../../src/self-improvement/seal.js";
import {
  createCandidateChangeSet,
  createSinglePassPrompt,
  WORKER_OUTPUT_SCHEMA,
} from "../../src/self-improvement/single-pass-worker.js";
import { createVerifyProvenance } from "../../src/self-improvement/verify.js";

export const PLAN_REVIEW_CHAIN = Object.freeze({
  repository: "erpsarang/self-improvement-mvp",
  issueNumber: 83,
  targetSha: "b".repeat(40),
  publishedHeadSha: "e".repeat(40),
  trustedCodeSha: "c".repeat(40),
  title: "[업무 요구] 사람이 이해하기 쉬운 상태 표시와 알림, 그리고 대시보드",
  // Issue 본문은 slice보다 넓다: 대시보드/알림은 승인된 slice 밖(후속 범위)이다.
  body: "PLAN, VERIFY, MERGE_READY 상태를 한국어로 표시한다. 상태 변경 시 Slack 알림을 보내고 대시보드에서 전체 cycle을 본다.",
  railRunId: 500,
  bridgeRunId: 34760000000,
  workerRunId: 34755287141,
  // 승인된 첫 bounded slice
  allowedPaths: ["README.md"],
  requiredChanges: ["README에 상태 설명을 추가한다"],
  forbiddenChanges: ["README 외 파일 변경", "Slack 알림·대시보드 구현", "workflow 변경"],
  acceptanceCriteria: ["README가 PLAN, VERIFY, MERGE_READY 상태를 한국어로 설명한다"],
  approach: ["첫 slice로 README 상태 설명만 추가한다", "후속 범위: Slack 알림과 대시보드는 별도 PLAN에서 다룬다"],
});

export function createPlanReviewChain() {
  const c = PLAN_REVIEW_CHAIN;
  const reqDigest = requirementDigest(c.title, c.body);
  const authorization = createPlanAuthorizeArtifact({
    normalizedPlan: {
      requirement: { issueNumber: c.issueNumber, digest: reqDigest },
      repository: c.repository,
      targetSha: c.targetSha,
      plan: {
        runId: 34754507865,
        runAttempt: 1,
        artifact: { name: "plan-issue-83-34754507865-attempt-1", id: 10317140417, digest: "c".repeat(64) },
        provenanceArtifact: { name: "", id: 0, digest: "" },
      },
    },
    provenanceArtifact: { name: "plan-issue-83-34754507865-attempt-1-provenance", id: 10316054273, digest: "d".repeat(64) },
    currentRequirementDigest: reqDigest,
    currentTargetSha: c.targetSha,
    approvalCommentId: 5653054555,
    approverUserId: 8370921,
    authorizationRunId: 34755257734,
    authorizationRunAttempt: 1,
  });
  const contract = createImplementContract({
    requirement: authorization.requirement,
    repository: authorization.repository,
    targetSha: authorization.targetSha,
    plan: authorization.plan,
    approval: authorization.approval,
  }, {
    allowedPaths: [...c.allowedPaths],
    requiredChanges: [...c.requiredChanges],
    forbiddenChanges: [...c.forbiddenChanges],
    validationCommands: ["npm test"],
    maxFilesChanged: 1,
    maxContextBytes: 50_000,
    maxPatchBytes: 50_000,
  });
  const root = mkdtempSync(join(tmpdir(), "plan-review-chain-"));
  writeFileSync(join(root, "README.md"), "# Framework\n");
  const context = createImplementContextPack(contract, root, c.targetSha);
  rmSync(root, { recursive: true, force: true });

  const sourcePlanAuthorizeArtifact = { name: planAuthorizeArtifactName(authorization), id: 10317195598, digest: "e".repeat(64) };
  const handoff = createPlanImplementHandoffManifest({
    authorization,
    sourceArtifact: sourcePlanAuthorizeArtifact,
    contract,
    contextDigest: context.contextDigest,
  });
  const bundle = verifyPlanImplementWorkerBundle({
    contract,
    context,
    handoff,
    source: { authorization, sourceArtifact: sourcePlanAuthorizeArtifact },
    prompt: createSinglePassPrompt(contract, context),
    schema: WORKER_OUTPUT_SCHEMA,
  });
  const file = context.files[0]!;
  if (file.state !== "present") throw new Error("fixture README must be present");
  const candidate = createCandidateChangeSet(contract, context, {
    summary: "README 상태 설명 추가",
    changes: [{
      path: "README.md",
      operation: "modify",
      baseContentDigest: file.contentDigest,
      content: "# Framework\n\n현재 상태: PLAN\n",
    }],
  });
  const handoffSource: PlanImplementWorkerSourceRun = {
    id: 34755268934,
    runAttempt: 1,
    repository: authorization.repository,
    workflowName: "Trusted PLAN IMPLEMENT Handoff",
    workflowPath: ".github/workflows/plan-implement-handoff.yml",
    event: "workflow_run",
    conclusion: "success",
    headBranch: "main",
    defaultBranch: "main",
    headSha: c.targetSha,
    currentDefaultSha: c.targetSha,
  };
  const handoffArtifact = { name: planImplementHandoffArtifactName(authorization), id: 10317530204, digest: "f".repeat(64) };
  const workerSource: PlanCandidateWorkerSourceRun = {
    id: c.workerRunId,
    runAttempt: 1,
    repository: authorization.repository,
    workflowName: "PLAN Bounded IMPLEMENT Worker",
    workflowPath: ".github/workflows/plan-implement-worker.yml",
    event: "workflow_run",
    conclusion: "success",
    headBranch: "main",
    defaultBranch: "main",
    headSha: c.targetSha,
    currentDefaultSha: c.targetSha,
  };
  const workerProvenance = createWorkerCandidateProvenance({
    bundle,
    source: handoffSource,
    sourceArtifact: handoffArtifact,
    workerRunId: workerSource.id,
    workerRunAttempt: workerSource.runAttempt,
    candidate,
  });
  const workerArtifact = {
    name: workerCandidateArtifactName({
      bundle,
      sourceRunId: handoffSource.id,
      sourceRunAttempt: handoffSource.runAttempt,
      workerRunId: workerSource.id,
      workerRunAttempt: workerSource.runAttempt,
    }),
    id: 10317985117,
    digest: "1".repeat(64),
  };
  const requirement = freezePlanRequirement(authorization, c.title, c.body);
  const validationPayload = {
    schemaVersion: 1 as const,
    kind: "deterministic-validation-result" as const,
    contractDigest: contract.contractDigest,
    contextDigest: context.contextDigest,
    candidateDigest: candidate.candidateDigest,
    baseSha: c.targetSha,
    appliedPaths: ["README.md"],
    status: "PASS" as const,
    commands: [{ raw: "npm test", executable: "npm", args: ["test"], status: "PASS" as const, exitCode: 0, signal: null, stdout: "ok", stderr: "" }],
  };
  const validation: DeterministicValidationResult = {
    ...validationPayload,
    digestAlgorithm: "sha256",
    evidenceDigest: createHash("sha256").update(JSON.stringify(validationPayload)).digest("hex"),
  };
  const candidatePatch = "diff --git a/README.md b/README.md\n";
  const bridge = createPlanCandidateBridgeProvenance({
    bundle,
    requirement,
    candidate,
    workerProvenance,
    handoffSource,
    handoffArtifact,
    workerSource,
    workerArtifact,
    deterministicValidation: validation,
    candidatePatch,
    bridgeRun: { runId: c.bridgeRunId, runAttempt: 1, trustedCodeSha: c.targetSha },
  });
  const bridgeArtifactName = planCandidateBridgeArtifactName({
    issueNumber: c.issueNumber,
    workerRunId: c.workerRunId,
    workerRunAttempt: 1,
    bridgeRunId: c.bridgeRunId,
    bridgeRunAttempt: 1,
  });
  const railRun = { runId: c.railRunId, runAttempt: 1, trustedCodeSha: c.trustedCodeSha };
  const sealed = sealPlanBridgeCandidate({
    bridge,
    candidatePatch,
    sourceRun: {
      id: c.bridgeRunId,
      runAttempt: 1,
      controlPlaneSha: c.targetSha,
      repository: c.repository,
      conclusion: "success",
      workflowPath: PLAN_CANDIDATE_BRIDGE_WORKFLOW_PATH,
    },
    sealRun: railRun,
    candidateArtifactName: bridgeArtifactName,
  });
  const publish = createPublishProvenance({
    seal: sealed.provenance,
    sealedPatch: sealed.sealedPatch,
    sealedArtifactName: `sealed-candidate-${c.bridgeRunId}-attempt-1-${c.railRunId}-attempt-1`,
    repository: c.repository,
    publishRun: railRun,
    publishedHeadSha: c.publishedHeadSha,
  });
  const verify = createVerifyProvenance({
    publish,
    publishArtifactName: `publish-provenance-issue-${c.issueNumber}-${c.railRunId}-attempt-1`,
    repository: c.repository,
    verifyRun: railRun,
    verifiedHeadSha: c.publishedHeadSha,
  });

  // 승인 당시 PLAN artifact의 PLAN.json (untrusted-plan wrapper + plan 문서). Handoff/PLAN_AUTHORIZE와 같은 validator를 통과한다.
  const planJson = {
    kind: "untrusted-plan",
    repository: c.repository,
    sha: c.targetSha,
    requirement: `${c.title}\n\n${c.body}`,
    context: { digest: "0".repeat(64), digestAlgorithm: "sha256", evidence: [], totalBytes: 0 },
    plan: {
      summary: "첫 slice로 README 상태 설명만 추가한다.",
      analysis: [{ evidenceId: "E1", finding: "README에 상태 설명이 없다." }],
      approach: [...c.approach],
      changeCandidates: ["README.md"],
      acceptanceCriteria: [...c.acceptanceCriteria],
      testStrategy: ["npm test"],
      questions: [],
      implementationScope: {
        ready: true,
        allowedPaths: [...c.allowedPaths],
        contextPaths: [],
        requiredChanges: [...c.requiredChanges],
        forbiddenChanges: [...c.forbiddenChanges],
        validationCommands: ["npm test"],
      },
    },
  };

  return {
    authorization,
    planAuthorizationArtifactName: sourcePlanAuthorizeArtifact.name,
    bridge,
    verify,
    verifyArtifactName: `verify-provenance-issue-${c.issueNumber}-${c.railRunId}-attempt-1`,
    railRun,
    planJson,
  };
}
