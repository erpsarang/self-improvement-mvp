import type { ImplementProvenance } from "./implement.js";
import { IMPLEMENT_WORKFLOW_PATH, sha256 } from "./implement.js";

export const SEAL_WORKFLOW_PATH = ".github/workflows/seal.yml" as const;

export interface ImplementSourceRun {
  readonly id: number;
  readonly runAttempt: number;
  readonly headSha: string;
  readonly repository: string;
  readonly conclusion: string;
  readonly workflowPath: string;
}

export interface SealRunIdentity {
  readonly runId: number;
  readonly runAttempt: number;
}

export interface SealProvenance {
  readonly type: "SEAL";
  readonly repository: string;
  readonly issueNumber: number;
  readonly baseSha: string;
  readonly sourceAuthorization: ImplementProvenance["sourceAuthorization"];
  readonly sourceImplement: {
    readonly workflowPath: typeof IMPLEMENT_WORKFLOW_PATH;
    readonly runId: number;
    readonly runAttempt: number;
    readonly candidateArtifactName: string;
    readonly candidatePatchDigest: string;
    readonly aiExecution: ImplementProvenance["aiExecution"];
  };
  readonly sealWorkflow: {
    readonly workflowPath: typeof SEAL_WORKFLOW_PATH;
    readonly runId: number;
    readonly runAttempt: number;
  };
  readonly sealedPatchDigest: string;
}

function positiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function validRepository(value: string): boolean {
  return /^[^/]+\/[^/]+$/.test(value);
}

function validSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

function validDigest(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}

function validImplementProvenance(value: ImplementProvenance): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      value.type === "IMPLEMENT" &&
      validRepository(value.repository) &&
      positiveInteger(value.issueNumber) &&
      validSha(value.baseSha) &&
      positiveInteger(value.sourceAuthorization?.runId) &&
      positiveInteger(value.sourceAuthorization?.runAttempt) &&
      positiveInteger(value.sourceAuthorization?.approvalCommentId) &&
      validDigest(value.sourceAuthorization?.policySnapshot) &&
      validDigest(value.sourceAuthorization?.requirementsDigest) &&
      value.implementWorkflow?.workflowPath === IMPLEMENT_WORKFLOW_PATH &&
      positiveInteger(value.implementWorkflow?.runId) &&
      positiveInteger(value.implementWorkflow?.runAttempt) &&
      validDigest(value.candidatePatchDigest) &&
      value.aiExecution?.provider === "openai-codex-action" &&
      typeof value.aiExecution?.resultId === "string" &&
      value.aiExecution.resultId.trim().length > 0,
  );
}

export function validateImplementCandidateForSeal(
  implement: ImplementProvenance,
  candidatePatch: string | Buffer,
  sourceRun: ImplementSourceRun,
): ImplementProvenance {
  if (!validImplementProvenance(implement)) {
    throw new Error("IMPLEMENT provenance가 올바르지 않습니다");
  }
  if (sourceRun.conclusion !== "success") {
    throw new Error("IMPLEMENT workflow가 성공하지 않았습니다");
  }
  if (sourceRun.workflowPath !== IMPLEMENT_WORKFLOW_PATH) {
    throw new Error("IMPLEMENT workflow path가 일치하지 않습니다");
  }
  if (!validRepository(sourceRun.repository) || !validSha(sourceRun.headSha)) {
    throw new Error("IMPLEMENT source workflow identity가 올바르지 않습니다");
  }
  if (!positiveInteger(sourceRun.id) || !positiveInteger(sourceRun.runAttempt)) {
    throw new Error("IMPLEMENT source run identity가 올바르지 않습니다");
  }
  if (implement.repository !== sourceRun.repository) {
    throw new Error("repository가 일치하지 않습니다");
  }
  if (implement.baseSha !== sourceRun.headSha) {
    throw new Error("candidate base SHA가 source IMPLEMENT head SHA와 일치하지 않습니다");
  }
  if (implement.implementWorkflow.runId !== sourceRun.id) {
    throw new Error("IMPLEMENT run ID가 일치하지 않습니다");
  }
  if (implement.implementWorkflow.runAttempt !== sourceRun.runAttempt) {
    throw new Error("IMPLEMENT run attempt가 일치하지 않습니다");
  }
  const patchSize =
    typeof candidatePatch === "string"
      ? Buffer.byteLength(candidatePatch)
      : candidatePatch.length;
  if (patchSize === 0) {
    throw new Error("candidate patch가 비어 있습니다");
  }
  if (sha256(candidatePatch) !== implement.candidatePatchDigest) {
    throw new Error("candidate patch digest가 IMPLEMENT provenance와 일치하지 않습니다");
  }
  return implement;
}

export function sealImplementCandidate(input: {
  readonly implement: ImplementProvenance;
  readonly candidatePatch: string | Buffer;
  readonly sourceRun: ImplementSourceRun;
  readonly sealRun: SealRunIdentity;
  readonly candidateArtifactName: string;
}): { readonly sealedPatch: Buffer; readonly provenance: SealProvenance } {
  const implement = validateImplementCandidateForSeal(
    input.implement,
    input.candidatePatch,
    input.sourceRun,
  );

  if (!positiveInteger(input.sealRun.runId) || !positiveInteger(input.sealRun.runAttempt)) {
    throw new Error("SEAL workflow identity가 올바르지 않습니다");
  }
  if (!input.candidateArtifactName.trim()) {
    throw new Error("candidate artifact 이름이 필요합니다");
  }

  const sealedPatch = Buffer.from(input.candidatePatch);
  const sealedPatchDigest = sha256(sealedPatch);
  if (sealedPatchDigest !== implement.candidatePatchDigest) {
    throw new Error("sealed patch digest가 candidate patch digest와 일치하지 않습니다");
  }

  const provenance: SealProvenance = Object.freeze({
    type: "SEAL" as const,
    repository: implement.repository,
    issueNumber: implement.issueNumber,
    baseSha: implement.baseSha,
    sourceAuthorization: { ...implement.sourceAuthorization },
    sourceImplement: {
      workflowPath: IMPLEMENT_WORKFLOW_PATH,
      runId: implement.implementWorkflow.runId,
      runAttempt: implement.implementWorkflow.runAttempt,
      candidateArtifactName: input.candidateArtifactName,
      candidatePatchDigest: implement.candidatePatchDigest,
      aiExecution: { ...implement.aiExecution },
    },
    sealWorkflow: {
      workflowPath: SEAL_WORKFLOW_PATH,
      runId: input.sealRun.runId,
      runAttempt: input.sealRun.runAttempt,
    },
    sealedPatchDigest,
  });

  return Object.freeze({ sealedPatch, provenance });
}
