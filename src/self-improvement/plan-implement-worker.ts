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
  FULL_CONTEXT_MATERIALIZATION,
  createPlanImplementHandoffManifest,
  planImplementHandoffArtifactName,
  verifyPlanAuthorizeArtifact,
  type PlanAuthorizeArtifactMetadata,
  type PlanImplementHandoffManifest,
} from "./plan-implement-handoff.js";
import type { PlanAuthorizeArtifact } from "./plan-authorization.js";
import {
  createSinglePassPrompt,
  materializeWorkerEdits,
  PLAN_WORKER_OUTPUT_SCHEMA,
  verifyCandidateChangeSet,
  type CandidateChangeSet,
  type WorkerProposal,
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

  // Context 표현은 Handoff가 만든 pack에서 다시 도출한다: 발췌 경로는 pack의 excerpt 파일과 정확히 같아야 하고,
  // 근거가 된 승인 PLAN Context digest는 manifest가 들고 온 값을 검증해 그대로 묶는다 (#244 Worker run 35997858096).
  if (!record(input.handoff)) throw new Error("handoff manifest mismatch");
  const excerptPaths = context.files.filter((file) => file.state === "excerpt").map((file) => file.path);
  const presented = record(input.handoff.contextMaterialization) ? input.handoff.contextMaterialization : {};
  const approvedPlanContextDigest = excerptPaths.length > 0 ? presented.approvedPlanContextDigest : null;
  if (excerptPaths.length > 0 && typeof approvedPlanContextDigest !== "string") {
    throw new Error("handoff manifest mismatch: excerpt context without approved PLAN context digest");
  }
  const expectedHandoff = createPlanImplementHandoffManifest({
    authorization: source.authorization,
    sourceArtifact: source.sourceArtifact,
    contract,
    contextDigest: context.contextDigest,
    contextMaterialization: excerptPaths.length === 0
      ? FULL_CONTEXT_MATERIALIZATION
      : { representation: "plan-excerpt", excerptPaths, approvedPlanContextDigest: approvedPlanContextDigest as string },
  });
  if (JSON.stringify(input.handoff) !== JSON.stringify(expectedHandoff)) {
    throw new Error("handoff manifest mismatch");
  }

  const expectedPrompt = createSinglePassPrompt(contract, context, { requireCompletion: true });
  if (typeof input.prompt !== "string" || input.prompt !== expectedPrompt) {
    throw new Error("handoff prompt mismatch");
  }
  if (JSON.stringify(input.schema) !== JSON.stringify(PLAN_WORKER_OUTPUT_SCHEMA)) {
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

/**
 * PLAN Worker 출력에서 complete=true인 변경안만 받는다. 미완료 선언이나 누락은 fail-closed로 거부해
 * 불완전한 candidate가 Rail/REVIEW/FIX로 넘어가 AI 호출을 더 쓰지 않게 한다 (App issue 266).
 */
export function acceptPlanWorkerOutput(value: unknown, contextPack: ImplementContextPack): WorkerProposal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("PLAN Worker output must be an object");
  const output = value as { readonly summary?: unknown; readonly changes?: unknown; readonly complete?: unknown };
  if (output.complete !== true) {
    const summary = typeof output.summary === "string" ? output.summary : "";
    throw new Error(`PLAN Worker가 승인 범위를 모두 담지 못했다고 반환했습니다 (complete=${String(output.complete)}): ${summary}`);
  }
  if (typeof output.summary !== "string" || !output.summary.trim()) throw new Error("PLAN Worker summary must be non-empty");
  if (!Array.isArray(output.changes) || output.changes.length === 0) throw new Error("PLAN Worker changes must be non-empty");

  const contextByPath = new Map(contextPack.files.map((file) => [file.path, file] as const));
  const changes: WorkerProposal["changes"] = output.changes.map((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`PLAN Worker change must be an object: #${index + 1}`);
    const change = raw as {
      readonly path?: unknown;
      readonly operation?: unknown;
      readonly baseContentDigest?: unknown;
      readonly content?: unknown;
      readonly edits?: unknown;
    };
    if (typeof change.path !== "string" || !change.path) throw new Error(`PLAN Worker change path missing: #${index + 1}`);
    const context = contextByPath.get(change.path);
    if (!context || context.state === "excerpt") throw new Error(`PLAN Worker change path is not writable context: ${change.path}`);

    if (change.operation === "modify") {
      if (context.state !== "present") throw new Error(`PLAN Worker modify path is not present: ${change.path}`);
      if (change.baseContentDigest !== context.contentDigest) throw new Error(`PLAN Worker base digest mismatch: ${change.path}`);
      if (change.content !== undefined) throw new Error(`PLAN Worker modify must return edits, not full content: ${change.path}`);
      if (!Array.isArray(change.edits) || change.edits.length === 0) throw new Error(`PLAN Worker modify edits missing: ${change.path}`);
      const edits = change.edits.map((edit, editIndex) => {
        if (typeof edit !== "object" || edit === null || Array.isArray(edit)) throw new Error(`PLAN Worker edit must be an object: ${change.path}#${editIndex + 1}`);
        const record = edit as { readonly oldText?: unknown; readonly newText?: unknown };
        if (typeof record.oldText !== "string" || record.oldText.length === 0) throw new Error(`PLAN Worker edit oldText missing: ${change.path}#${editIndex + 1}`);
        if (typeof record.newText !== "string") throw new Error(`PLAN Worker edit newText missing: ${change.path}#${editIndex + 1}`);
        return { oldText: record.oldText, newText: record.newText };
      });
      return {
        path: change.path,
        operation: "modify",
        baseContentDigest: context.contentDigest,
        content: materializeWorkerEdits(context.content, edits, change.path),
        edits,
      };
    }

    if (change.operation === "create") {
      if (context.state !== "missing") throw new Error(`PLAN Worker create path is not missing: ${change.path}`);
      if (change.baseContentDigest !== null) throw new Error(`PLAN Worker create baseContentDigest must be null: ${change.path}`);
      if (typeof change.content !== "string") throw new Error(`PLAN Worker create content missing: ${change.path}`);
      if (change.edits !== undefined) throw new Error(`PLAN Worker create must not contain edits: ${change.path}`);
      return { path: change.path, operation: "create", baseContentDigest: null, content: change.content };
    }

    throw new Error(`PLAN Worker operation invalid: ${change.path}`);
  });

  return { summary: output.summary, changes };
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
