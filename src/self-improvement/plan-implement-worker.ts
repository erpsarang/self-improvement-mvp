import { createHash } from "node:crypto";
import {
  verifyImplementContextPack,
  type ImplementContextPack,
} from "./context-pack.js";
import {
  verifyImplementContract,
  type ImplementContract,
} from "./implement-contract.js";
import {
  createPlanImplementHandoffManifest,
  planImplementHandoffArtifactName,
  verifyPlanAuthorizeArtifact,
  type PlanAuthorizeArtifactMetadata,
  type PlanImplementHandoffManifest,
} from "./plan-implement-handoff.js";
import type { PlanAuthorizeArtifact } from "./plan-authorization.js";
import {
  createSinglePassPrompt,
  verifyCandidateChangeSet,
  WORKER_OUTPUT_SCHEMA,
  type CandidateChangeSet,
} from "./single-pass-worker.js";

export const PLAN_IMPLEMENT_HANDOFF_WORKFLOW_NAME = "Trusted PLAN IMPLEMENT Handoff" as const;
export const PLAN_IMPLEMENT_HANDOFF_WORKFLOW_PATH = ".github/workflows/plan-implement-handoff.yml" as const;

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40,64}$/;

export interface HandoffArtifactMetadata {
  readonly name: string;
  readonly id: number;
  readonly digest: string;
}

export interface PlanImplementWorkerSourceRun {
  readonly id: number;
  readonly runAttempt: number;
  readonly repository: string;
  readonly workflowName: string;
  readonly workflowPath: string;
  readonly event: string;
  readonly conclusion: string;
  readonly headBranch: string;
  readonly defaultBranch: string;
  readonly headSha: string;
  readonly currentDefaultSha: string;
}

export interface PlanImplementWorkerRecoveryGuard {
  readonly kind: "trusted-recovery-compare-v1";
  readonly baseSha: string;
  readonly currentDefaultSha: string;
}

export interface PlanImplementWorkerBundle {
  readonly contract: ImplementContract;
  readonly context: ImplementContextPack;
  readonly handoff: PlanImplementHandoffManifest;
  readonly authorization: PlanAuthorizeArtifact;
  readonly sourcePlanAuthorizeArtifact: PlanAuthorizeArtifactMetadata;
  readonly prompt: string;
}

export interface WorkerCandidateProvenancePayload {
  readonly schemaVersion: 1;
  readonly kind: "trusted-bounded-worker-candidate-provenance";
  readonly repository: string;
  readonly issueNumber: number;
  readonly baseSha: string;
  readonly sourceHandoff: {
    readonly runId: number;
    readonly runAttempt: number;
    readonly artifact: HandoffArtifactMetadata;
  };
  readonly approvedPlan: {
    readonly runId: number;
    readonly runAttempt: number;
  };
  readonly approvalCommentId: number;
  readonly worker: {
    readonly runId: number;
    readonly runAttempt: number;
  };
  readonly contractDigest: string;
  readonly contextDigest: string;
  readonly handoffDigest: string;
  readonly candidateDigest: string;
}

export interface WorkerCandidateProvenance extends WorkerCandidateProvenancePayload {
  readonly digestAlgorithm: "sha256";
  readonly provenanceDigest: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(name: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function assertDigest(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 digest`);
  }
}

function parsePlanAuthorizeArtifactMetadata(value: unknown): PlanAuthorizeArtifactMetadata {
  if (!record(value)) throw new Error("source PLAN_AUTHORIZE artifact metadata missing");
  const expectedKeys = ["digest", "id", "name"];
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error("source PLAN_AUTHORIZE artifact metadata shape is invalid");
  }
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error("source PLAN_AUTHORIZE artifact name missing");
  positiveInteger("source PLAN_AUTHORIZE artifact id", value.id);
  assertDigest("source PLAN_AUTHORIZE artifact digest", value.digest);
  return { name: value.name, id: value.id, digest: value.digest };
}

function verifySourceRecord(value: unknown): {
  authorization: PlanAuthorizeArtifact;
  sourceArtifact: PlanAuthorizeArtifactMetadata;
} {
  if (!record(value)) throw new Error("handoff source record must be an object");
  const expectedKeys = ["authorization", "sourceArtifact"];
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error("handoff source record shape is invalid");
  }
  return {
    authorization: verifyPlanAuthorizeArtifact(value.authorization),
    sourceArtifact: parsePlanAuthorizeArtifactMetadata(value.sourceArtifact),
  };
}

export function verifyPlanImplementWorkerBundle(input: {
  readonly contract: unknown;
  readonly context: unknown;
  readonly handoff: unknown;
  readonly source: unknown;
  readonly prompt: unknown;
  readonly schema: unknown;
}): PlanImplementWorkerBundle {
  const contract = input.contract as ImplementContract;
  verifyImplementContract(contract);
  const context = input.context as ImplementContextPack;
  verifyImplementContextPack(context, contract);

  const source = verifySourceRecord(input.source);
  if (source.authorization.repository !== contract.repository || source.authorization.targetSha !== contract.baseSha) {
    throw new Error("handoff source authorization is not bound to contract identity");
  }

  const expectedHandoff = createPlanImplementHandoffManifest({
    authorization: source.authorization,
    sourceArtifact: source.sourceArtifact,
    contract,
    contextDigest: context.contextDigest,
  });
  if (!record(input.handoff) || JSON.stringify(input.handoff) !== JSON.stringify(expectedHandoff)) {
    throw new Error("handoff manifest mismatch");
  }

  const expectedPrompt = createSinglePassPrompt(contract, context);
  if (typeof input.prompt !== "string" || input.prompt !== expectedPrompt) {
    throw new Error("handoff prompt mismatch");
  }
  if (JSON.stringify(input.schema) !== JSON.stringify(WORKER_OUTPUT_SCHEMA)) {
    throw new Error("handoff worker schema mismatch");
  }

  return {
    contract,
    context,
    handoff: expectedHandoff,
    authorization: source.authorization,
    sourcePlanAuthorizeArtifact: source.sourceArtifact,
    prompt: expectedPrompt,
  };
}

export function validatePlanImplementWorkerSource(
  bundle: PlanImplementWorkerBundle,
  source: PlanImplementWorkerSourceRun,
  sourceArtifact: HandoffArtifactMetadata,
  recoveryGuard?: PlanImplementWorkerRecoveryGuard,
): void {
  positiveInteger("source handoff run id", source.id);
  positiveInteger("source handoff run attempt", source.runAttempt);
  positiveInteger("source handoff artifact id", sourceArtifact.id);
  assertDigest("source handoff artifact digest", sourceArtifact.digest);
  if (source.repository !== bundle.contract.repository) throw new Error("source handoff repository mismatch");
  if (source.workflowName !== PLAN_IMPLEMENT_HANDOFF_WORKFLOW_NAME || source.workflowPath !== PLAN_IMPLEMENT_HANDOFF_WORKFLOW_PATH) {
    throw new Error("unexpected source handoff workflow");
  }
  if (source.event !== "workflow_run" || source.conclusion !== "success") {
    throw new Error("source handoff run is not a successful workflow_run");
  }
  if (source.headBranch !== source.defaultBranch) throw new Error("source handoff is not on the default branch");
  if (!GIT_SHA.test(source.headSha) || !GIT_SHA.test(source.currentDefaultSha)) throw new Error("invalid source handoff SHA");
  if (source.headSha !== bundle.contract.baseSha) throw new Error("source handoff SHA mismatch");
  if (source.currentDefaultSha !== bundle.contract.baseSha) {
    if (
      recoveryGuard?.kind !== "trusted-recovery-compare-v1" ||
      recoveryGuard.baseSha !== bundle.contract.baseSha ||
      recoveryGuard.currentDefaultSha !== source.currentDefaultSha
    ) {
      throw new Error("default branch moved after handoff; re-plan required");
    }
  }
  if (sourceArtifact.name !== planImplementHandoffArtifactName(bundle.authorization)) {
    throw new Error("source handoff artifact name mismatch");
  }
}

export function workerCandidateArtifactName(input: {
  readonly bundle: PlanImplementWorkerBundle;
  readonly sourceRunId: number;
  readonly sourceRunAttempt: number;
  readonly workerRunId: number;
  readonly workerRunAttempt: number;
}): string {
  positiveInteger("source handoff run id", input.sourceRunId);
  positiveInteger("source handoff run attempt", input.sourceRunAttempt);
  positiveInteger("worker run id", input.workerRunId);
  positiveInteger("worker run attempt", input.workerRunAttempt);
  const auth = input.bundle.authorization;
  return [
    "bounded-worker-candidate",
    `issue-${auth.requirement.issueNumber}`,
    `plan-${auth.plan.runId}`,
    `approval-${auth.approval.commentId}`,
    `handoff-${input.sourceRunId}-attempt-${input.sourceRunAttempt}`,
    `worker-${input.workerRunId}-attempt-${input.workerRunAttempt}`,
  ].join("-");
}

export function createWorkerCandidateProvenance(input: {
  readonly bundle: PlanImplementWorkerBundle;
  readonly source: PlanImplementWorkerSourceRun;
  readonly sourceArtifact: HandoffArtifactMetadata;
  readonly recoveryGuard?: PlanImplementWorkerRecoveryGuard;
  readonly workerRunId: number;
  readonly workerRunAttempt: number;
  readonly candidate: CandidateChangeSet;
}): WorkerCandidateProvenance {
  validatePlanImplementWorkerSource(input.bundle, input.source, input.sourceArtifact, input.recoveryGuard);
  positiveInteger("worker run id", input.workerRunId);
  positiveInteger("worker run attempt", input.workerRunAttempt);
  verifyCandidateChangeSet(input.candidate, input.bundle.contract, input.bundle.context);

  const payload: WorkerCandidateProvenancePayload = {
    schemaVersion: 1,
    kind: "trusted-bounded-worker-candidate-provenance",
    repository: input.bundle.contract.repository,
    issueNumber: input.bundle.authorization.requirement.issueNumber,
    baseSha: input.bundle.contract.baseSha,
    sourceHandoff: {
      runId: input.source.id,
      runAttempt: input.source.runAttempt,
      artifact: { ...input.sourceArtifact },
    },
    approvedPlan: {
      runId: input.bundle.authorization.plan.runId,
      runAttempt: input.bundle.authorization.plan.runAttempt,
    },
    approvalCommentId: input.bundle.authorization.approval.commentId,
    worker: { runId: input.workerRunId, runAttempt: input.workerRunAttempt },
    contractDigest: input.bundle.contract.contractDigest,
    contextDigest: input.bundle.context.contextDigest,
    handoffDigest: input.bundle.handoff.handoffDigest,
    candidateDigest: input.candidate.candidateDigest,
  };
  const provenanceDigest = createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
  return { ...payload, digestAlgorithm: "sha256", provenanceDigest };
}
