import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createImplementContextPack } from "../src/self-improvement/context-pack.js";
import type { DeterministicValidationResult } from "../src/self-improvement/deterministic-ci.js";
import { createImplementContract } from "../src/self-improvement/implement-contract.js";
import {
  createPlanImplementHandoffManifest,
  planImplementHandoffArtifactName,
} from "../src/self-improvement/plan-implement-handoff.js";
import {
  createPlanAuthorizeArtifact,
  planAuthorizeArtifactName,
  requirementDigest,
} from "../src/self-improvement/plan-authorization.js";
import {
  createWorkerCandidateProvenance,
  verifyPlanImplementWorkerBundle,
  workerCandidateArtifactName,
  type PlanImplementWorkerSourceRun,
} from "../src/self-improvement/plan-implement-worker.js";
import {
  createCandidateChangeSet,
  createSinglePassPrompt,
  WORKER_OUTPUT_SCHEMA,
} from "../src/self-improvement/single-pass-worker.js";
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
} from "../src/self-improvement/plan-candidate-bridge.js";

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

test("validated Worker candidate를 truthful PLAN bridge provenance로 승격한다", () => {
  const f = fixture();
  assert.doesNotThrow(() => validateWorkerCandidateAgainstHandoff({
    candidate: f.candidate,
    provenance: f.workerProvenance,
    bundle: f.bundle,
    handoffSource: f.handoffSource,
    handoffArtifact: f.handoffArtifact,
    workerSource: f.workerSource,
    workerArtifact: f.workerArtifact,
  }));
  const patch = "diff --git a/README.md b/README.md\n";
  const bridge = createPlanCandidateBridgeProvenance({
    bundle: f.bundle,
    requirement: f.requirement,
    candidate: f.candidate,
    workerProvenance: f.workerProvenance,
    handoffSource: f.handoffSource,
    handoffArtifact: f.handoffArtifact,
    workerSource: f.workerSource,
    workerArtifact: f.workerArtifact,
    deterministicValidation: f.validation,
    candidatePatch: patch,
    bridgeRun: { runId: 34760000000, runAttempt: 1, trustedCodeSha: targetSha },
  });
  assert.equal(bridge.requirement.title, title);
  assert.equal(bridge.sourcePlanAuthorize.authorization.approval.commentId, 5653054555);
  assert.equal(bridge.sourceWorker.runId, 34755287141);
  assert.equal(bridge.deterministicValidation.status, "PASS");
  assert.match(bridge.candidatePatchDigest, /^sha256:[0-9a-f]{64}$/);
  assert.doesNotThrow(() => verifyPlanCandidateBridgeProvenance(bridge));
  assert.doesNotThrow(() => validateBridgePatch(bridge, patch));
});

test("Worker provenance digest 또는 exact Handoff binding 위변조를 거부한다", () => {
  const f = fixture();
  assert.throws(
    () => verifyWorkerCandidateProvenanceShape({ ...f.workerProvenance, candidateDigest: "9".repeat(64) }),
    /provenance digest mismatch/,
  );
  assert.throws(() => validateWorkerCandidateAgainstHandoff({
    candidate: f.candidate,
    provenance: f.workerProvenance,
    bundle: f.bundle,
    handoffSource: { ...f.handoffSource, id: f.handoffSource.id + 1 },
    handoffArtifact: f.handoffArtifact,
    workerSource: f.workerSource,
    workerArtifact: f.workerArtifact,
  }), /source Handoff run mismatch/);
});

test("Worker workflow/path/default branch drift는 fail-closed 한다", () => {
  const f = fixture();
  assert.throws(
    () => validatePlanCandidateWorkerSource(
      f.workerProvenance,
      { ...f.workerSource, workflowPath: ".github/workflows/implement.yml" },
      f.workerArtifact,
    ),
    /unexpected Worker source workflow/,
  );
  assert.throws(
    () => validatePlanCandidateWorkerSource(
      f.workerProvenance,
      { ...f.workerSource, currentDefaultSha: "9".repeat(40) },
      f.workerArtifact,
    ),
    /re-plan required/,
  );

  const moved = { ...f.workerSource, currentDefaultSha: "9".repeat(40) };
  assert.doesNotThrow(() => validatePlanCandidateWorkerSource(
    f.workerProvenance,
    moved,
    f.workerArtifact,
    {
      kind: "trusted-recovery-compare-v1",
      baseSha: f.workerProvenance.baseSha,
      currentDefaultSha: moved.currentDefaultSha,
    },
  ));
  assert.throws(() => validatePlanCandidateWorkerSource(
    f.workerProvenance,
    moved,
    f.workerArtifact,
    {
      kind: "trusted-recovery-compare-v1",
      baseSha: "8".repeat(40),
      currentDefaultSha: moved.currentDefaultSha,
    },
  ), /re-plan required/);
});

test("Recovery Worker head가 approved base와 달라도 exact recovery guard가 세 SHA를 모두 고정하면 허용한다", () => {
  const f = fixture();
  const workerHeadSha = "7".repeat(40);
  const currentDefaultSha = "9".repeat(40);
  const movedWorker = {
    ...f.workerSource,
    headSha: workerHeadSha,
    currentDefaultSha,
  };

  assert.throws(() => validatePlanCandidateWorkerSource(
    f.workerProvenance,
    movedWorker,
    f.workerArtifact,
  ), /Worker source head SHA mismatch/);

  assert.doesNotThrow(() => validatePlanCandidateWorkerSource(
    f.workerProvenance,
    movedWorker,
    f.workerArtifact,
    {
      kind: "trusted-recovery-compare-v1",
      baseSha: f.workerProvenance.baseSha,
      workerHeadSha,
      currentDefaultSha,
    },
  ));

  assert.throws(() => validatePlanCandidateWorkerSource(
    f.workerProvenance,
    movedWorker,
    f.workerArtifact,
    {
      kind: "trusted-recovery-compare-v1",
      baseSha: f.workerProvenance.baseSha,
      workerHeadSha: "8".repeat(40),
      currentDefaultSha,
    },
  ), /Worker source head SHA mismatch/);
});

test("Issue title/body가 승인 digest에서 바뀌면 frozen requirement를 만들지 않는다", () => {
  const f = fixture();
  assert.throws(() => freezePlanRequirement(f.authorization, `${title} 변경`, body), /re-plan required/);
  assert.deepEqual(freezePlanRequirement(f.authorization, title, body), f.requirement);
});

test("deterministic validation FAIL 또는 patch 위변조는 bridge로 승격하지 않는다", () => {
  const f = fixture();
  assert.throws(() => createPlanCandidateBridgeProvenance({
    bundle: f.bundle,
    requirement: f.requirement,
    candidate: f.candidate,
    workerProvenance: f.workerProvenance,
    handoffSource: f.handoffSource,
    handoffArtifact: f.handoffArtifact,
    workerSource: f.workerSource,
    workerArtifact: f.workerArtifact,
    deterministicValidation: { ...f.validation, status: "FAIL" },
    candidatePatch: "patch",
    bridgeRun: { runId: 34760000000, runAttempt: 1, trustedCodeSha: targetSha },
  }), /digest mismatch|did not PASS/);

  const patch = "patch";
  const bridge = createPlanCandidateBridgeProvenance({
    bundle: f.bundle,
    requirement: f.requirement,
    candidate: f.candidate,
    workerProvenance: f.workerProvenance,
    handoffSource: f.handoffSource,
    handoffArtifact: f.handoffArtifact,
    workerSource: f.workerSource,
    workerArtifact: f.workerArtifact,
    deterministicValidation: f.validation,
    candidatePatch: patch,
    bridgeRun: { runId: 34760000000, runAttempt: 1, trustedCodeSha: targetSha },
  });
  assert.throws(() => validateBridgePatch(bridge, `${patch}tamper`), /patch digest mismatch/);
});

test("bridge artifact 이름은 Issue/Worker/Bridge exact run attempt를 모두 고정한다", () => {
  assert.equal(
    planCandidateBridgeArtifactName({
      issueNumber: 83,
      workerRunId: 34755287141,
      workerRunAttempt: 2,
      bridgeRunId: 34760000000,
      bridgeRunAttempt: 3,
    }),
    "plan-bridge-candidate-issue-83-worker-34755287141-attempt-2-bridge-34760000000-attempt-3",
  );
});
