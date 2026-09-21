import { createHash } from "node:crypto";
import {
  requirementDigest,
  type PlanAuthorizeArtifact,
} from "./plan-authorization.js";
import {
  planImplementHandoffArtifactName,
  verifyPlanAuthorizeArtifact,
  type PlanAuthorizeArtifactMetadata,
} from "./plan-implement-handoff.js";
import {
  workerCandidateArtifactName,
  type HandoffArtifactMetadata,
  type PlanImplementWorkerBundle,
  type PlanImplementWorkerSourceRun,
  type WorkerCandidateProvenance,
} from "./plan-implement-worker.js";
import {
  verifyCandidateChangeSet,
  type CandidateChangeSet,
} from "./single-pass-worker.js";
import {
  verifyDeterministicValidationResult,
  type DeterministicValidationResult,
} from "./deterministic-ci.js";

export const PLAN_IMPLEMENT_WORKER_WORKFLOW_NAME = "PLAN Bounded IMPLEMENT Worker" as const;
export const PLAN_IMPLEMENT_WORKER_WORKFLOW_PATH = ".github/workflows/plan-implement-worker.yml" as const;
export const PLAN_CANDIDATE_BRIDGE_WORKFLOW_PATH = ".github/workflows/plan-candidate-bridge.yml" as const;

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40,64}$/;

export interface ArtifactMetadata {
  readonly name: string;
  readonly id: number;
  readonly digest: string;
}

export interface PlanCandidateWorkerSourceRun {
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

export interface TrustedRecoveryCompareGuard {
  readonly kind: "trusted-recovery-compare-v1";
  readonly baseSha: string;
  readonly workerHeadSha?: string;
  readonly currentDefaultSha: string;
}

export interface FrozenPlanRequirement {
  readonly issueNumber: number;
  readonly title: string;
  readonly body: string | null;
  readonly digestAlgorithm: "sha256";
  readonly digestEncoding: "UTF-8 JSON.stringify([title, body])";
  readonly digest: string;
}

export interface BridgeRunIdentity {
  readonly runId: number;
  readonly runAttempt: number;
  readonly trustedCodeSha: string;
}

export interface PlanCandidateBridgePayload {
  readonly schemaVersion: 1;
  readonly kind: "trusted-plan-candidate-bridge";
  readonly repository: string;
  readonly issueNumber: number;
  readonly baseSha: string;
  readonly requirement: FrozenPlanRequirement;
  readonly sourcePlanAuthorize: {
    readonly artifact: PlanAuthorizeArtifactMetadata;
    readonly authorization: PlanAuthorizeArtifact;
  };
  readonly sourceHandoff: {
    readonly runId: number;
    readonly runAttempt: number;
    readonly artifact: HandoffArtifactMetadata;
  };
  readonly sourceWorker: {
    readonly runId: number;
    readonly runAttempt: number;
    readonly artifact: ArtifactMetadata;
    readonly provenance: WorkerCandidateProvenance;
  };
  readonly contractDigest: string;
  readonly contextDigest: string;
  readonly handoffDigest: string;
  readonly candidateDigest: string;
  readonly deterministicValidation: DeterministicValidationResult;
  readonly candidatePatchDigest: string;
  readonly recoveryGuard?: TrustedRecoveryCompareGuard;
  readonly bridgeWorkflow: {
    readonly workflowPath: typeof PLAN_CANDIDATE_BRIDGE_WORKFLOW_PATH;
    readonly runId: number;
    readonly runAttempt: number;
    readonly trustedCodeSha: string;
  };
}

export interface PlanCandidateBridgeProvenance extends PlanCandidateBridgePayload {
  readonly digestAlgorithm: "sha256";
  readonly bridgeDigest: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
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

function assertSha(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !GIT_SHA.test(value)) throw new Error(`${name} must be a Git SHA`);
}

function normalizeArtifact(value: ArtifactMetadata, label: string): ArtifactMetadata {
  if (!value || typeof value.name !== "string" || !value.name.trim()) throw new Error(`${label} name missing`);
  positiveInteger(`${label} id`, value.id);
  assertDigest(`${label} digest`, value.digest);
  return { name: value.name, id: value.id, digest: value.digest };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Prefixed(value: string | Buffer): string {
  return `sha256:${sha256(value)}`;
}

export function validateBridgeTrustedCodeIdentity(input: {
  readonly baseSha: string;
  readonly trustedCodeSha: string;
  readonly recoveryGuard?: TrustedRecoveryCompareGuard;
}): void {
  assertSha("bridge base SHA", input.baseSha);
  assertSha("bridge trusted code SHA", input.trustedCodeSha);
  if (!input.recoveryGuard) {
    if (input.trustedCodeSha !== input.baseSha) {
      throw new Error("bridge trusted code SHA must equal exact candidate base SHA");
    }
    return;
  }

  if (input.recoveryGuard.kind !== "trusted-recovery-compare-v1") {
    throw new Error("bridge recovery guard kind mismatch");
  }
  assertSha("bridge recovery base SHA", input.recoveryGuard.baseSha);
  if (input.recoveryGuard.workerHeadSha !== undefined) {
    assertSha("bridge recovery Worker head SHA", input.recoveryGuard.workerHeadSha);
  }
  assertSha("bridge recovery current default SHA", input.recoveryGuard.currentDefaultSha);
  if (
    input.recoveryGuard.baseSha !== input.baseSha ||
    input.recoveryGuard.currentDefaultSha !== input.trustedCodeSha
  ) {
    throw new Error("bridge recovery guard does not bind candidate base and trusted code SHA");
  }
}

function workerPayload(value: WorkerCandidateProvenance): Omit<WorkerCandidateProvenance, "digestAlgorithm" | "provenanceDigest"> {
  return {
    schemaVersion: 1,
    kind: "trusted-bounded-worker-candidate-provenance",
    repository: value.repository,
    issueNumber: value.issueNumber,
    baseSha: value.baseSha,
    sourceHandoff: {
      runId: value.sourceHandoff.runId,
      runAttempt: value.sourceHandoff.runAttempt,
      artifact: { ...value.sourceHandoff.artifact },
    },
    approvedPlan: { ...value.approvedPlan },
    approvalCommentId: value.approvalCommentId,
    worker: { ...value.worker },
    contractDigest: value.contractDigest,
    contextDigest: value.contextDigest,
    handoffDigest: value.handoffDigest,
    candidateDigest: value.candidateDigest,
  };
}

export function verifyWorkerCandidateProvenanceShape(value: unknown): WorkerCandidateProvenance {
  if (!record(value) || !exactKeys(value, [
    "schemaVersion", "kind", "repository", "issueNumber", "baseSha", "sourceHandoff",
    "approvedPlan", "approvalCommentId", "worker", "contractDigest", "contextDigest",
    "handoffDigest", "candidateDigest", "digestAlgorithm", "provenanceDigest",
  ])) {
    throw new Error("Worker candidate provenance shape is invalid");
  }
  if (value.schemaVersion !== 1 || value.kind !== "trusted-bounded-worker-candidate-provenance" || value.digestAlgorithm !== "sha256") {
    throw new Error("unsupported Worker candidate provenance schema");
  }
  if (typeof value.repository !== "string" || !/^[^/]+\/[^/]+$/.test(value.repository)) {
    throw new Error("Worker candidate repository is invalid");
  }
  positiveInteger("Worker candidate issueNumber", value.issueNumber);
  assertSha("Worker candidate baseSha", value.baseSha);
  if (!record(value.sourceHandoff) || !record(value.sourceHandoff.artifact) ||
      !record(value.approvedPlan) || !record(value.worker)) {
    throw new Error("Worker candidate provenance identity is incomplete");
  }
  positiveInteger("Worker source Handoff runId", value.sourceHandoff.runId);
  positiveInteger("Worker source Handoff runAttempt", value.sourceHandoff.runAttempt);
  normalizeArtifact(value.sourceHandoff.artifact as unknown as ArtifactMetadata, "Worker source Handoff artifact");
  positiveInteger("Worker approved PLAN runId", value.approvedPlan.runId);
  positiveInteger("Worker approved PLAN runAttempt", value.approvedPlan.runAttempt);
  positiveInteger("Worker approval comment id", value.approvalCommentId);
  positiveInteger("Worker runId", value.worker.runId);
  positiveInteger("Worker runAttempt", value.worker.runAttempt);
  assertDigest("Worker contractDigest", value.contractDigest);
  assertDigest("Worker contextDigest", value.contextDigest);
  assertDigest("Worker handoffDigest", value.handoffDigest);
  assertDigest("Worker candidateDigest", value.candidateDigest);
  assertDigest("Worker provenanceDigest", value.provenanceDigest);

  const provenance = value as unknown as WorkerCandidateProvenance;
  if (sha256(JSON.stringify(workerPayload(provenance))) !== provenance.provenanceDigest) {
    throw new Error("Worker candidate provenance digest mismatch");
  }
  return provenance;
}

export function validatePlanCandidateWorkerSource(
  provenance: WorkerCandidateProvenance,
  source: PlanCandidateWorkerSourceRun,
  sourceArtifact: ArtifactMetadata,
  recoveryGuard?: TrustedRecoveryCompareGuard,
): void {
  positiveInteger("Worker source run id", source.id);
  positiveInteger("Worker source run attempt", source.runAttempt);
  const artifact = normalizeArtifact(sourceArtifact, "Worker candidate artifact");
  if (source.repository !== provenance.repository) throw new Error("Worker source repository mismatch");
  if (source.workflowName !== PLAN_IMPLEMENT_WORKER_WORKFLOW_NAME || source.workflowPath !== PLAN_IMPLEMENT_WORKER_WORKFLOW_PATH) {
    throw new Error("unexpected Worker source workflow");
  }
  if (source.event !== "workflow_run" || source.conclusion !== "success") {
    throw new Error("Worker source is not a successful workflow_run");
  }
  if (source.headBranch !== source.defaultBranch) throw new Error("Worker source is not on the default branch");
  assertSha("Worker source head SHA", source.headSha);
  assertSha("current default SHA", source.currentDefaultSha);
  if (source.id !== provenance.worker.runId || source.runAttempt !== provenance.worker.runAttempt) {
    throw new Error("Worker source run identity mismatch");
  }
  const recoveryGuardMatches =
    recoveryGuard?.kind === "trusted-recovery-compare-v1" &&
    recoveryGuard.baseSha === provenance.baseSha &&
    recoveryGuard.currentDefaultSha === source.currentDefaultSha &&
    (
      recoveryGuard.workerHeadSha === source.headSha ||
      (recoveryGuard.workerHeadSha === undefined && source.headSha === provenance.baseSha)
    );
  if (source.headSha !== provenance.baseSha && !recoveryGuardMatches) {
    throw new Error("Worker source head SHA mismatch");
  }
  if (source.currentDefaultSha !== provenance.baseSha && !recoveryGuardMatches) {
    throw new Error("default branch moved after Worker; re-plan required");
  }

  const pattern = new RegExp(
    `^bounded-worker-candidate-issue-${provenance.issueNumber}-plan-${provenance.approvedPlan.runId}-approval-${provenance.approvalCommentId}` +
      `-handoff-${provenance.sourceHandoff.runId}-attempt-${provenance.sourceHandoff.runAttempt}` +
      `-worker-${provenance.worker.runId}-attempt-${provenance.worker.runAttempt}$`,
  );
  if (!pattern.test(artifact.name)) throw new Error("Worker candidate artifact name mismatch");
}

export function validateWorkerCandidateAgainstHandoff(input: {
  readonly candidate: CandidateChangeSet;
  readonly provenance: WorkerCandidateProvenance;
  readonly bundle: PlanImplementWorkerBundle;
  readonly handoffSource: PlanImplementWorkerSourceRun;
  readonly handoffArtifact: HandoffArtifactMetadata;
  readonly workerSource: PlanCandidateWorkerSourceRun;
  readonly workerArtifact: ArtifactMetadata;
  readonly recoveryGuard?: TrustedRecoveryCompareGuard;
}): void {
  const provenance = verifyWorkerCandidateProvenanceShape(input.provenance);
  verifyCandidateChangeSet(input.candidate, input.bundle.contract, input.bundle.context);
  validatePlanCandidateWorkerSource(provenance, input.workerSource, input.workerArtifact, input.recoveryGuard);

  if (input.handoffSource.id !== provenance.sourceHandoff.runId || input.handoffSource.runAttempt !== provenance.sourceHandoff.runAttempt) {
    throw new Error("Worker provenance source Handoff run mismatch");
  }
  const expectedHandoffArtifact = normalizeArtifact(provenance.sourceHandoff.artifact, "Worker provenance Handoff artifact");
  if (
    input.handoffArtifact.name !== expectedHandoffArtifact.name ||
    input.handoffArtifact.id !== expectedHandoffArtifact.id ||
    input.handoffArtifact.digest !== expectedHandoffArtifact.digest
  ) {
    throw new Error("Worker provenance source Handoff artifact mismatch");
  }

  const authorization = input.bundle.authorization;
  if (
    provenance.repository !== input.bundle.contract.repository ||
    provenance.issueNumber !== authorization.requirement.issueNumber ||
    provenance.baseSha !== input.bundle.contract.baseSha ||
    provenance.approvedPlan.runId !== authorization.plan.runId ||
    provenance.approvedPlan.runAttempt !== authorization.plan.runAttempt ||
    provenance.approvalCommentId !== authorization.approval.commentId ||
    provenance.contractDigest !== input.bundle.contract.contractDigest ||
    provenance.contextDigest !== input.bundle.context.contextDigest ||
    provenance.handoffDigest !== input.bundle.handoff.handoffDigest ||
    provenance.candidateDigest !== input.candidate.candidateDigest
  ) {
    throw new Error("Worker candidate identity does not match trusted Handoff bundle");
  }

  const expectedName = workerCandidateArtifactName({
    bundle: input.bundle,
    sourceRunId: input.handoffSource.id,
    sourceRunAttempt: input.handoffSource.runAttempt,
    workerRunId: input.workerSource.id,
    workerRunAttempt: input.workerSource.runAttempt,
  });
  if (input.workerArtifact.name !== expectedName) throw new Error("Worker candidate artifact canonical name mismatch");
}

export function freezePlanRequirement(
  authorization: PlanAuthorizeArtifact,
  title: string,
  body: string | null,
): FrozenPlanRequirement {
  const trusted = verifyPlanAuthorizeArtifact(authorization);
  if (typeof title !== "string") throw new Error("requirement title is invalid");
  if (!(body === null || typeof body === "string")) throw new Error("requirement body is invalid");
  const digest = requirementDigest(title, body);
  if (digest !== trusted.requirement.digest) throw new Error("requirement title/body changed after PLAN approval; re-plan required");
  return {
    issueNumber: trusted.requirement.issueNumber,
    title,
    body,
    digestAlgorithm: "sha256",
    digestEncoding: "UTF-8 JSON.stringify([title, body])",
    digest,
  };
}

function bridgePayload(value: PlanCandidateBridgeProvenance): PlanCandidateBridgePayload {
  return {
    schemaVersion: 1,
    kind: "trusted-plan-candidate-bridge",
    repository: value.repository,
    issueNumber: value.issueNumber,
    baseSha: value.baseSha,
    requirement: { ...value.requirement },
    sourcePlanAuthorize: {
      artifact: { ...value.sourcePlanAuthorize.artifact },
      authorization: value.sourcePlanAuthorize.authorization,
    },
    sourceHandoff: {
      runId: value.sourceHandoff.runId,
      runAttempt: value.sourceHandoff.runAttempt,
      artifact: { ...value.sourceHandoff.artifact },
    },
    sourceWorker: {
      runId: value.sourceWorker.runId,
      runAttempt: value.sourceWorker.runAttempt,
      artifact: { ...value.sourceWorker.artifact },
      provenance: value.sourceWorker.provenance,
    },
    contractDigest: value.contractDigest,
    contextDigest: value.contextDigest,
    handoffDigest: value.handoffDigest,
    candidateDigest: value.candidateDigest,
    deterministicValidation: value.deterministicValidation,
    candidatePatchDigest: value.candidatePatchDigest,
    ...(value.recoveryGuard ? { recoveryGuard: { ...value.recoveryGuard } } : {}),
    bridgeWorkflow: { ...value.bridgeWorkflow },
  };
}

export function planCandidateBridgeArtifactName(input: {
  readonly issueNumber: number;
  readonly workerRunId: number;
  readonly workerRunAttempt: number;
  readonly bridgeRunId: number;
  readonly bridgeRunAttempt: number;
}): string {
  positiveInteger("bridge issue number", input.issueNumber);
  positiveInteger("bridge Worker run id", input.workerRunId);
  positiveInteger("bridge Worker run attempt", input.workerRunAttempt);
  positiveInteger("bridge run id", input.bridgeRunId);
  positiveInteger("bridge run attempt", input.bridgeRunAttempt);
  return `plan-bridge-candidate-issue-${input.issueNumber}-worker-${input.workerRunId}-attempt-${input.workerRunAttempt}` +
    `-bridge-${input.bridgeRunId}-attempt-${input.bridgeRunAttempt}`;
}

export function createPlanCandidateBridgeProvenance(input: {
  readonly bundle: PlanImplementWorkerBundle;
  readonly requirement: FrozenPlanRequirement;
  readonly candidate: CandidateChangeSet;
  readonly workerProvenance: WorkerCandidateProvenance;
  readonly handoffSource: PlanImplementWorkerSourceRun;
  readonly handoffArtifact: HandoffArtifactMetadata;
  readonly workerSource: PlanCandidateWorkerSourceRun;
  readonly workerArtifact: ArtifactMetadata;
  readonly recoveryGuard?: TrustedRecoveryCompareGuard;
  readonly deterministicValidation: DeterministicValidationResult;
  readonly candidatePatch: string | Buffer;
  readonly bridgeRun: BridgeRunIdentity;
}): PlanCandidateBridgeProvenance {
  validateWorkerCandidateAgainstHandoff({
    candidate: input.candidate,
    provenance: input.workerProvenance,
    bundle: input.bundle,
    handoffSource: input.handoffSource,
    handoffArtifact: input.handoffArtifact,
    workerSource: input.workerSource,
    workerArtifact: input.workerArtifact,
    ...(input.recoveryGuard ? { recoveryGuard: input.recoveryGuard } : {}),
  });
  verifyDeterministicValidationResult(input.deterministicValidation);
  if (input.deterministicValidation.status !== "PASS") throw new Error("deterministic validation did not PASS");
  if (
    input.deterministicValidation.contractDigest !== input.bundle.contract.contractDigest ||
    input.deterministicValidation.contextDigest !== input.bundle.context.contextDigest ||
    input.deterministicValidation.candidateDigest !== input.candidate.candidateDigest ||
    input.deterministicValidation.baseSha !== input.bundle.contract.baseSha
  ) {
    throw new Error("deterministic validation identity mismatch");
  }
  if (
    input.requirement.issueNumber !== input.bundle.authorization.requirement.issueNumber ||
    input.requirement.digest !== input.bundle.authorization.requirement.digest
  ) {
    throw new Error("frozen requirement identity mismatch");
  }
  positiveInteger("bridge run id", input.bridgeRun.runId);
  positiveInteger("bridge run attempt", input.bridgeRun.runAttempt);
  validateBridgeTrustedCodeIdentity({
    baseSha: input.bundle.contract.baseSha,
    trustedCodeSha: input.bridgeRun.trustedCodeSha,
    ...(input.recoveryGuard ? { recoveryGuard: input.recoveryGuard } : {}),
  });
  const patchSize = typeof input.candidatePatch === "string" ? Buffer.byteLength(input.candidatePatch) : input.candidatePatch.length;
  if (patchSize < 1) throw new Error("candidate patch must be non-empty");

  const payload: PlanCandidateBridgePayload = {
    schemaVersion: 1,
    kind: "trusted-plan-candidate-bridge",
    repository: input.bundle.contract.repository,
    issueNumber: input.bundle.authorization.requirement.issueNumber,
    baseSha: input.bundle.contract.baseSha,
    requirement: { ...input.requirement },
    sourcePlanAuthorize: {
      artifact: { ...input.bundle.sourcePlanAuthorizeArtifact },
      authorization: input.bundle.authorization,
    },
    sourceHandoff: {
      runId: input.handoffSource.id,
      runAttempt: input.handoffSource.runAttempt,
      artifact: { ...input.handoffArtifact },
    },
    sourceWorker: {
      runId: input.workerSource.id,
      runAttempt: input.workerSource.runAttempt,
      artifact: { ...input.workerArtifact },
      provenance: input.workerProvenance,
    },
    contractDigest: input.bundle.contract.contractDigest,
    contextDigest: input.bundle.context.contextDigest,
    handoffDigest: input.bundle.handoff.handoffDigest,
    candidateDigest: input.candidate.candidateDigest,
    deterministicValidation: input.deterministicValidation,
    candidatePatchDigest: sha256Prefixed(input.candidatePatch),
    ...(input.recoveryGuard ? { recoveryGuard: { ...input.recoveryGuard } } : {}),
    bridgeWorkflow: {
      workflowPath: PLAN_CANDIDATE_BRIDGE_WORKFLOW_PATH,
      runId: input.bridgeRun.runId,
      runAttempt: input.bridgeRun.runAttempt,
      trustedCodeSha: input.bridgeRun.trustedCodeSha,
    },
  };
  const bridgeDigest = sha256(JSON.stringify(payload));
  return { ...payload, digestAlgorithm: "sha256", bridgeDigest };
}

export function verifyPlanCandidateBridgeProvenance(value: unknown): PlanCandidateBridgeProvenance {
  if (!record(value) || value.schemaVersion !== 1 || value.kind !== "trusted-plan-candidate-bridge" || value.digestAlgorithm !== "sha256") {
    throw new Error("unsupported PLAN candidate bridge provenance schema");
  }
  if (!record(value.requirement) || !record(value.sourcePlanAuthorize) || !record(value.sourceHandoff) ||
      !record(value.sourceWorker) || !record(value.bridgeWorkflow)) {
    throw new Error("PLAN candidate bridge provenance identity is incomplete");
  }
  if (value.recoveryGuard !== undefined && !record(value.recoveryGuard)) {
    throw new Error("PLAN candidate bridge recovery guard shape is invalid");
  }
  if (typeof value.repository !== "string" || !/^[^/]+\/[^/]+$/.test(value.repository)) throw new Error("bridge repository invalid");
  positiveInteger("bridge issueNumber", value.issueNumber);
  assertSha("bridge baseSha", value.baseSha);
  assertDigest("bridge contractDigest", value.contractDigest);
  assertDigest("bridge contextDigest", value.contextDigest);
  assertDigest("bridge handoffDigest", value.handoffDigest);
  assertDigest("bridge candidateDigest", value.candidateDigest);
  if (typeof value.candidatePatchDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.candidatePatchDigest)) {
    throw new Error("bridge candidatePatchDigest invalid");
  }
  assertDigest("bridgeDigest", value.bridgeDigest);

  const provenance = value as unknown as PlanCandidateBridgeProvenance;
  const authorization = verifyPlanAuthorizeArtifact(provenance.sourcePlanAuthorize.authorization);
  const authArtifact = normalizeArtifact(provenance.sourcePlanAuthorize.artifact, "bridge PLAN_AUTHORIZE artifact");
  const expectedAuthName = `plan-authorize-issue-${authorization.requirement.issueNumber}-plan-${authorization.plan.runId}` +
    `-attempt-${authorization.plan.runAttempt}-approval-${authorization.approval.commentId}` +
    `-run-${authorization.authorization.runId}-attempt-${authorization.authorization.runAttempt}`;
  if (authArtifact.name !== expectedAuthName) throw new Error("bridge PLAN_AUTHORIZE artifact name mismatch");

  if (
    provenance.repository !== authorization.repository ||
    provenance.issueNumber !== authorization.requirement.issueNumber ||
    provenance.baseSha !== authorization.targetSha ||
    provenance.requirement.issueNumber !== authorization.requirement.issueNumber ||
    provenance.requirement.digest !== authorization.requirement.digest ||
    requirementDigest(provenance.requirement.title, provenance.requirement.body) !== provenance.requirement.digest ||
    provenance.requirement.digestAlgorithm !== "sha256" ||
    provenance.requirement.digestEncoding !== "UTF-8 JSON.stringify([title, body])"
  ) {
    throw new Error("bridge requirement/PLAN_AUTHORIZE identity mismatch");
  }

  positiveInteger("bridge Handoff runId", provenance.sourceHandoff.runId);
  positiveInteger("bridge Handoff runAttempt", provenance.sourceHandoff.runAttempt);
  const handoffArtifact = normalizeArtifact(provenance.sourceHandoff.artifact, "bridge Handoff artifact");
  if (handoffArtifact.name !== planImplementHandoffArtifactName(authorization)) {
    throw new Error("bridge Handoff artifact name mismatch");
  }
  positiveInteger("bridge Worker runId", provenance.sourceWorker.runId);
  positiveInteger("bridge Worker runAttempt", provenance.sourceWorker.runAttempt);
  normalizeArtifact(provenance.sourceWorker.artifact, "bridge Worker artifact");
  const worker = verifyWorkerCandidateProvenanceShape(provenance.sourceWorker.provenance);
  if (
    worker.worker.runId !== provenance.sourceWorker.runId ||
    worker.worker.runAttempt !== provenance.sourceWorker.runAttempt ||
    worker.sourceHandoff.runId !== provenance.sourceHandoff.runId ||
    worker.sourceHandoff.runAttempt !== provenance.sourceHandoff.runAttempt ||
    worker.sourceHandoff.artifact.name !== handoffArtifact.name ||
    worker.sourceHandoff.artifact.id !== handoffArtifact.id ||
    worker.sourceHandoff.artifact.digest !== handoffArtifact.digest ||
    worker.contractDigest !== provenance.contractDigest ||
    worker.contextDigest !== provenance.contextDigest ||
    worker.handoffDigest !== provenance.handoffDigest ||
    worker.candidateDigest !== provenance.candidateDigest
  ) {
    throw new Error("bridge Worker provenance chain mismatch");
  }

  verifyDeterministicValidationResult(provenance.deterministicValidation);
  if (
    provenance.deterministicValidation.status !== "PASS" ||
    provenance.deterministicValidation.contractDigest !== provenance.contractDigest ||
    provenance.deterministicValidation.contextDigest !== provenance.contextDigest ||
    provenance.deterministicValidation.candidateDigest !== provenance.candidateDigest ||
    provenance.deterministicValidation.baseSha !== provenance.baseSha
  ) {
    throw new Error("bridge deterministic validation mismatch");
  }

  if (provenance.bridgeWorkflow.workflowPath !== PLAN_CANDIDATE_BRIDGE_WORKFLOW_PATH) {
    throw new Error("bridge workflow identity mismatch");
  }
  positiveInteger("bridge workflow runId", provenance.bridgeWorkflow.runId);
  positiveInteger("bridge workflow runAttempt", provenance.bridgeWorkflow.runAttempt);
  validateBridgeTrustedCodeIdentity({
    baseSha: provenance.baseSha,
    trustedCodeSha: provenance.bridgeWorkflow.trustedCodeSha,
    ...(provenance.recoveryGuard ? { recoveryGuard: provenance.recoveryGuard } : {}),
  });

  if (sha256(JSON.stringify(bridgePayload(provenance))) !== provenance.bridgeDigest) {
    throw new Error("bridge provenance digest mismatch");
  }
  return provenance;
}

export function validateBridgePatch(provenance: PlanCandidateBridgeProvenance, patch: string | Buffer): void {
  verifyPlanCandidateBridgeProvenance(provenance);
  const size = typeof patch === "string" ? Buffer.byteLength(patch) : patch.length;
  if (size < 1) throw new Error("bridge patch must be non-empty");
  if (sha256Prefixed(patch) !== provenance.candidatePatchDigest) {
    throw new Error("bridge patch digest mismatch");
  }
}
