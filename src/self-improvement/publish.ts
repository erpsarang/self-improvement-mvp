import { sha256 } from "./implement.js";
import {
  TRUSTED_RAIL_WORKFLOW_PATH,
  type SealProvenance,
} from "./seal.js";

export interface PublishRunIdentity {
  readonly runId: number;
  readonly runAttempt: number;
  readonly trustedCodeSha: string;
}

export interface PublishProvenance {
  readonly type: "PUBLISH";
  readonly repository: string;
  readonly issueNumber: number;
  readonly baseSha: string;
  readonly sourceSealArtifactName: string;
  readonly sourceSeal: SealProvenance;
  readonly publishWorkflow: {
    readonly workflowPath: typeof TRUSTED_RAIL_WORKFLOW_PATH;
    readonly runId: number;
    readonly runAttempt: number;
    readonly trustedCodeSha: string;
  };
  readonly publishedBranch: string;
  readonly publishedHeadSha: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validRepository(value: unknown): value is string {
  return typeof value === "string" && /^[^/]+\/[^/]+$/.test(value);
}

function validSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function validSealProvenance(value: unknown): value is SealProvenance {
  if (!record(value)) return false;
  const sourceAuthorization = value.sourceAuthorization;
  const sourceImplement = value.sourceImplement;
  const sealWorkflow = value.sealWorkflow;
  if (
    !record(sourceAuthorization) ||
    !record(sourceImplement) ||
    !record(sealWorkflow)
  ) {
    return false;
  }
  const aiExecution = sourceImplement.aiExecution;
  if (!record(aiExecution)) return false;

  return (
    value.type === "SEAL" &&
    validRepository(value.repository) &&
    positiveInteger(value.issueNumber) &&
    validSha(value.baseSha) &&
    positiveInteger(sourceAuthorization.runId) &&
    positiveInteger(sourceAuthorization.runAttempt) &&
    positiveInteger(sourceAuthorization.approvalCommentId) &&
    validDigest(sourceAuthorization.policySnapshot) &&
    validDigest(sourceAuthorization.requirementsDigest) &&
    validSha(sourceAuthorization.authorizedBaseSha) &&
    sourceImplement.workflowPath === ".github/workflows/implement.yml" &&
    positiveInteger(sourceImplement.runId) &&
    positiveInteger(sourceImplement.runAttempt) &&
    validSha(sourceImplement.controlPlaneSha) &&
    typeof sourceImplement.candidateArtifactName === "string" &&
    validDigest(sourceImplement.candidatePatchDigest) &&
    aiExecution.provider === "openai-codex-action" &&
    typeof aiExecution.resultId === "string" &&
    aiExecution.resultId.trim().length > 0 &&
    sealWorkflow.workflowPath === TRUSTED_RAIL_WORKFLOW_PATH &&
    positiveInteger(sealWorkflow.runId) &&
    positiveInteger(sealWorkflow.runAttempt) &&
    validSha(sealWorkflow.trustedCodeSha) &&
    validDigest(value.sealedPatchDigest)
  );
}

function validateSealedArtifactName(
  artifactName: string,
  seal: SealProvenance,
): void {
  const match = /^sealed-candidate-(\d+)-attempt-(\d+)-(\d+)-attempt-(\d+)$/.exec(
    artifactName,
  );
  if (!match) throw new Error("sealed artifact 이름이 올바르지 않습니다");

  const implementRunId = Number(match[1]);
  const implementRunAttempt = Number(match[2]);
  const sealRunId = Number(match[3]);
  const sealRunAttempt = Number(match[4]);

  if (
    implementRunId !== seal.sourceImplement.runId ||
    implementRunAttempt !== seal.sourceImplement.runAttempt ||
    sealRunId !== seal.sealWorkflow.runId ||
    sealRunAttempt !== seal.sealWorkflow.runAttempt
  ) {
    throw new Error("sealed artifact identity가 SEAL provenance와 일치하지 않습니다");
  }
}

export function publishBranchName(issueNumber: number): string {
  if (!positiveInteger(issueNumber)) {
    throw new Error("issue number는 양의 정수여야 합니다");
  }
  return `ai-publish/issue-${issueNumber}`;
}

export function validateSealedCandidateForPublish(input: {
  readonly seal: unknown;
  readonly sealedPatch: string | Buffer;
  readonly sealedArtifactName: string;
  readonly repository: string;
}): SealProvenance {
  if (!validSealProvenance(input.seal)) {
    throw new Error("SEAL provenance가 올바르지 않습니다");
  }
  const seal = input.seal;
  if (seal.repository !== input.repository) {
    throw new Error("SEAL repository가 현재 repository와 일치하지 않습니다");
  }
  if (seal.baseSha !== seal.sourceAuthorization.authorizedBaseSha) {
    throw new Error("SEAL base SHA가 승인 SHA와 일치하지 않습니다");
  }
  if (seal.sourceImplement.candidatePatchDigest !== seal.sealedPatchDigest) {
    throw new Error("SEAL candidate digest와 sealed digest가 일치하지 않습니다");
  }
  const patchSize =
    typeof input.sealedPatch === "string"
      ? Buffer.byteLength(input.sealedPatch)
      : input.sealedPatch.length;
  if (patchSize === 0) throw new Error("sealed patch가 비어 있습니다");
  if (sha256(input.sealedPatch) !== seal.sealedPatchDigest) {
    throw new Error("sealed patch digest가 SEAL provenance와 일치하지 않습니다");
  }
  validateSealedArtifactName(input.sealedArtifactName, seal);
  return seal;
}

export function createPublishProvenance(input: {
  readonly seal: unknown;
  readonly sealedPatch: string | Buffer;
  readonly sealedArtifactName: string;
  readonly repository: string;
  readonly publishRun: PublishRunIdentity;
  readonly publishedHeadSha: string;
}): PublishProvenance {
  const seal = validateSealedCandidateForPublish(input);
  if (!positiveInteger(input.publishRun.runId) || !positiveInteger(input.publishRun.runAttempt)) {
    throw new Error("PUBLISH workflow identity가 올바르지 않습니다");
  }
  if (!validSha(input.publishRun.trustedCodeSha)) {
    throw new Error("PUBLISH trusted control-plane SHA가 올바르지 않습니다");
  }
  const publishedHeadSha = input.publishedHeadSha.toLowerCase();
  if (!validSha(publishedHeadSha)) {
    throw new Error("published_head_sha는 40자리 Git SHA여야 합니다");
  }

  return Object.freeze({
    type: "PUBLISH" as const,
    repository: seal.repository,
    issueNumber: seal.issueNumber,
    baseSha: seal.baseSha,
    sourceSealArtifactName: input.sealedArtifactName,
    sourceSeal: seal,
    publishWorkflow: {
      workflowPath: TRUSTED_RAIL_WORKFLOW_PATH,
      runId: input.publishRun.runId,
      runAttempt: input.publishRun.runAttempt,
      trustedCodeSha: input.publishRun.trustedCodeSha,
    },
    publishedBranch: publishBranchName(seal.issueNumber),
    publishedHeadSha,
  });
}
