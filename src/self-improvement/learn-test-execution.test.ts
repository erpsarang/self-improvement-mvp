import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createImplementContextPack } from "./context-pack.js";
import type { DeterministicValidationResult } from "./deterministic-ci.js";
import { createImplementContract } from "./implement-contract.js";
import {
  createPlanImplementHandoffManifest,
  planImplementHandoffArtifactName,
} from "./plan-implement-handoff.js";
import {
  createPlanAuthorizeArtifact,
  planAuthorizeArtifactName,
  requirementDigest,
} from "./plan-authorization.js";
import {
  createWorkerCandidateProvenance,
  verifyPlanImplementWorkerBundle,
  workerCandidateArtifactName,
  type PlanImplementWorkerSourceRun,
} from "./plan-implement-worker.js";
import {
  createCandidateChangeSet,
  createSinglePassPrompt,
  WORKER_OUTPUT_SCHEMA,
} from "./single-pass-worker.js";
import {
  createPlanCandidateBridgeProvenance,
  freezePlanRequirement,
  planCandidateBridgeArtifactName,
  validateBridgePatch,
  validatePlanCandidateWorkerSource,
  validateWorkerCandidateAgainstHandoff,
  verifyPlanCandidateBridgeProvenance,
  verifyWorkerCandidateProvenanceShape,
  type PlanCandidateWorkerSourceRun,
} from "./plan-candidate-bridge.js";

const targetSha = "b".repeat(40);
const title = "사람이 이해하기 쉬운 상태 표시";
const body = "PLAN, VERIFY, MERGE_READY 상태를 한국어로 표시한다.";
const reqDigest = requirementDigest(title, body);

function fixture() {
  const authorization = createPlanAuthorizeArtifact({
    normalizedPlan: {
      requirement: { issueNumber: 83, digest: reqDigest },
      repository: "erpsarang/self-improvement-mvp",
      targetSha,
      plan: {
        runId: 34754507865,
        runAttempt: 1,
        artifact: {
          name: "plan-issue-83-34754507865-attempt-1",
          id: 10317140417,
          digest: "c".repeat(64),
        },
        provenanceArtifact: { name: "", id: 0, digest: "" },
      },
    },
    provenanceArtifact: {
      name: "plan-issue-83-34754507865-attempt-1-provenance",
      id: 10316054273,
      digest: "d".repeat(64),
    },
    currentRequirementDigest: reqDigest,
    currentTargetSha: targetSha,
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
    allowedPaths: ["README.md"],
    requiredChanges: ["상태 설명 추가"],
    forbiddenChanges: ["README 외 변경 금지"],
    validationCommands: ["npm test"],
    maxFilesChanged: 1,
    maxContextBytes: 50_000,
    maxPatchBytes: 50_000,
  });
  const root = mkdtempSync(join(tmpdir(), "plan-bridge-test-"));
  writeFileSync(join(root, "README.md"), "# Framework\n");
  const context = createImplementContextPack(contract, root, targetSha);
  rmSync(root, { recursive: true, force: true });

  const sourcePlanAuthorizeArtifact = {
    name: planAuthorizeArtifactName(authorization),
    id: 10317195598,
    digest: "e".repeat(64),
  };
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
  assert.equal(file.state, "present");
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
    headSha: targetSha,
    currentDefaultSha: targetSha,
  };
  const handoffArtifact = {
    name: planImplementHandoffArtifactName(authorization),
    id: 10317530204,
    digest: "f".repeat(64),
  };
  const workerSource: PlanCandidateWorkerSourceRun = {
    id: 34755287141,
    runAttempt: 1,
    repository: authorization.repository,
    workflowName: "PLAN Bounded IMPLEMENT Worker",
    workflowPath: ".github/workflows/plan-implement-worker.yml",
    event: "workflow_run",
    conclusion: "success",
    headBranch: "main",
    defaultBranch: "main",
    headSha: targetSha,
    currentDefaultSha: targetSha,
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
  const requirement = freezePlanRequirement(authorization, title, body);
  const payload = {
    schemaVersion: 1 as const,
    kind: "deterministic-validation-result" as const,
    contractDigest: contract.contractDigest,
    contextDigest: context.contextDigest,
    candidateDigest: candidate.candidateDigest,
    baseSha: targetSha,
    appliedPaths: ["README.md"],
    status: "PASS" as const,
    commands: [{
      raw: "npm test",
      executable: "npm",
      args: ["test"],
      status: "PASS" as const,
      exitCode: 0,
      signal: null,
      stdout: "ok",
      stderr: "",
    }],
  };
  const validation: DeterministicValidationResult = {
    ...payload,
    digestAlgorithm: "sha256",
    evidenceDigest: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
  };
  return {
    authorization, bundle, candidate, handoffSource, handoffArtifact,
    workerSource, workerProvenance, workerArtifact, requirement, validation,
  };
}


import { createTrustedLearnSourceArtifacts, type TrustedLearnSourceFacts } from "./learn-source.js";
import { verifyLearnInputPack } from "./learn-input-pack.js";

function executionFixture() {
  const f = fixture();
  const bridge = createPlanCandidateBridgeProvenance({
    bundle: f.bundle, requirement: f.requirement, candidate: f.candidate,
    workerProvenance: f.workerProvenance, handoffSource: f.handoffSource,
    handoffArtifact: f.handoffArtifact, workerSource: f.workerSource, workerArtifact: f.workerArtifact,
    deterministicValidation: f.validation, candidatePatch: "diff --git a/README.md b/README.md\n",
    bridgeRun: { runId: 34760000000, runAttempt: 1, trustedCodeSha: targetSha },
  });
  const workflow = { workflowPath: ".github/workflows/trusted-rail.yml", runId: 500, runAttempt: 1, trustedCodeSha: targetSha };
  const repository = f.authorization.repository;
  const headSha = "a".repeat(40);
  const seal = {
    type: "SEAL", repository, issueNumber: 83, baseSha: targetSha,
    sourcePlanBridge: {
      workflowPath: bridge.bridgeWorkflow.workflowPath, runId: 34760000000, runAttempt: 1,
      controlPlaneSha: targetSha, bridge,
      candidateArtifactName: planCandidateBridgeArtifactName({ issueNumber: 83, workerRunId: f.workerSource.id,
        workerRunAttempt: 1, bridgeRunId: 34760000000, bridgeRunAttempt: 1 }),
    },
    sealWorkflow: workflow, sealedPatchDigest: bridge.candidatePatchDigest,
  };
  const publish = {
    type: "PUBLISH", repository, issueNumber: 83, baseSha: targetSha,
    sourceSealArtifactName: "sealed-candidate-34760000000-attempt-1-500-attempt-1",
    sourceSeal: seal, publishWorkflow: workflow,
    publishedBranch: "ai-publish/issue-83", publishedHeadSha: headSha,
  };
  const verify = {
    type: "VERIFY", repository, issueNumber: 83,
    sourcePublishArtifactName: "publish-provenance-issue-83-500-attempt-1", sourcePublish: publish,
    verifyWorkflow: workflow, verifiedBranch: publish.publishedBranch, verifiedHeadSha: headSha, result: "PASS",
  };
  const orchestration = {
    type: "ORCHESTRATION", repository, issueNumber: 83, decision: "PASS", nextState: "MERGE_READY",
    reviewedHeadSha: headSha, requirementsDigest: reqDigest,
    orchestratorWorkflow: { ...workflow, workflowPath: ".github/workflows/orchestrator.yml" },
    sourceReview: { decision: "PASS", reviewedHeadSha: headSha, requirementsDigest: reqDigest,
      reviewWorkflow: workflow, sourceVerifyArtifactName: "verify-provenance-issue-83-500-attempt-1", sourceVerify: verify },
    mergeBoundary: { type: "HUMAN_PULL_REQUEST", number: 24, headSha, baseBranch: "main" },
  };
  const facts: TrustedLearnSourceFacts = {
    repository, defaultBranch: "main", requirement: { issueNumber: 83, title, body, digest: reqDigest },
    humanMerge: { pullRequestNumber: 24, merged: true, headSha, mergeCommitSha: "c".repeat(40), mergedAt: "2026-09-15T12:27:59Z", baseBranch: "main" },
    trustedRail: { ...workflow, status: "completed", conclusion: "success", headBranch: "main", headSha: targetSha },
    orchestrationArtifact: { name: "orchestration-provenance-issue-83-500-attempt-1", id: 100, digest: "d".repeat(64) },
    frameworkSourceSha: targetSha,
  };
  return { facts, orchestration, bridge, seal, publish, verify };
}

test("LEARN includes bounded exact execution evidence deterministically", () => {
  const f = executionFixture();
  const result = createTrustedLearnSourceArtifacts(f.facts, f.orchestration);
  assert.deepEqual(result, createTrustedLearnSourceArtifacts(f.facts, f.orchestration));
  verifyLearnInputPack(result.learnInputPack, result.completedCycle);
  const item = result.learnInputPack.evidence.find(e => e.kind === "test-execution")!;
  assert.equal(item.source.kind, "artifact");
  const summary = JSON.parse(item.content);
  assert.equal(summary.executionMethod, "trusted-content-chain");
  assert.equal(summary.conclusion, "success");
  assert.equal(summary.evidenceDigest, f.bridge.deterministicValidation.evidenceDigest);
  assert.equal(summary.commands[0].raw, "npm test");
  assert.equal(summary.commands[0].exitCode, 0);
  assert.equal(summary.commands[0].stdout, undefined);
  assert.equal(summary.reviewedHeadSha, f.facts.humanMerge.headSha);
  assert.ok(item.byteLength <= 8192);
});

// Recompute signed payloads so semantic checks are exercised independently of digest rejection.
function rehash(value: object, digestKey: string) {
  const record = value as Record<string, unknown>;
  const { digestAlgorithm, [digestKey]: oldDigest, ...payload } = record;
  record[digestKey] = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
for (const mutation of ["digest", "exit", "signal", "empty", "base", "candidate", "patch", "publish", "verify", "run", "artifact", "missing", "null", "budget", "control-sha", "status", "command"]) {
  test(`LEARN rejects execution mismatch: ${mutation}`, () => {
    const f = executionFixture();
    const validation = f.bridge.deterministicValidation as unknown as Record<string, any>;
    const bridge = f.bridge as unknown as Record<string, any>;
    if (mutation === "control-sha") f.verify.verifyWorkflow = { ...f.verify.verifyWorkflow, trustedCodeSha: "e".repeat(40) };
    if (mutation === "status") validation.commands[0].status = "FAIL";
    if (mutation === "command") validation.commands[0].args = ["run", "other"];
    if (mutation === "digest") validation.commands[0].stdout = "tampered";
    if (mutation === "exit") validation.commands[0].exitCode = 1;
    if (mutation === "signal") validation.commands[0].signal = "SIGTERM";
    if (mutation === "empty") validation.commands = [];
    if (mutation === "base") validation.baseSha = "e".repeat(40);
    if (mutation === "candidate") validation.candidateDigest = "e".repeat(64);
    if (mutation === "patch") f.seal.sealedPatchDigest = "sha256:" + "e".repeat(64);
    if (mutation === "publish") f.publish.publishedHeadSha = "e".repeat(40);
    if (mutation === "verify") f.verify.verifiedHeadSha = "e".repeat(40);
    if (mutation === "run") f.seal.sourcePlanBridge.runId++;
    if (mutation === "artifact") f.seal.sourcePlanBridge.candidateArtifactName += "-wrong";
    if (mutation === "budget") validation.commands = Array.from({length: 100}, () => validation.commands[0]);
    if (mutation !== "digest") rehash(validation, "evidenceDigest");
    if (mutation === "missing") delete bridge.deterministicValidation;
    if (mutation === "null") bridge.deterministicValidation = null;
    rehash(bridge, "bridgeDigest");
    assert.throws(() => createTrustedLearnSourceArtifacts(f.facts, f.orchestration));
  });
}

test("LEARN does not invent execution evidence when provenance is absent", () => {
  const f = executionFixture();
  delete (f.orchestration.sourceReview as Partial<typeof f.orchestration.sourceReview>).sourceVerify;
  const result = createTrustedLearnSourceArtifacts(f.facts, f.orchestration);
  assert.equal(result.learnInputPack.evidence.some(e => e.kind === "test-execution"), false);
});
