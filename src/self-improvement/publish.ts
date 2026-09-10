import { sha256 } from "./implement.js";
import {
  TRUSTED_RAIL_WORKFLOW_PATH,
  sealSourceRunIdentity,
  validateSealProvenance,
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

function validateSealedArtifactName(artifactName: string, seal: SealProvenance): void {
  const match = /^sealed-candidate-(\d+)-attempt-(\d+)-(\d+)-attempt-(\d+)$/.exec(
    artifactName,
  );
  if (!match) throw new Error("sealed artifact 이름이 올바르지 않습니다");

  const source = sealSourceRunIdentity(seal);
  if (
    Number(match[1]) !== source.runId ||
    Number(match[2]) !== source.runAttempt ||
    Number(match[3]) !== seal.sealWorkflow.runId ||
    Number(match[4]) !== seal.sealWorkflow.runAttempt
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
  const seal = validateSealProvenance(input.seal);
  if (seal.repository !== input.repository) {
    throw new Error("SEAL repository가 현재 repository와 일치하지 않습니다");
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

export function validatePublishProvenance(value: unknown): PublishProvenance {
  if (!record(value) || !record(value.publishWorkflow)) {
    throw new Error("PUBLISH provenance가 올바르지 않습니다");
  }
  if (
    value.type !== "PUBLISH" ||
    !validRepository(value.repository) ||
    !positiveInteger(value.issueNumber) ||
    !validSha(value.baseSha) ||
    typeof value.sourceSealArtifactName !== "string" ||
    !record(value.sourceSeal) ||
    value.publishWorkflow.workflowPath !== TRUSTED_RAIL_WORKFLOW_PATH ||
    !positiveInteger(value.publishWorkflow.runId) ||
    !positiveInteger(value.publishWorkflow.runAttempt) ||
    !validSha(value.publishWorkflow.trustedCodeSha) ||
    value.publishedBranch !== publishBranchName(value.issueNumber) ||
    !validSha(value.publishedHeadSha)
  ) {
    throw new Error("PUBLISH provenance가 올바르지 않습니다");
  }

  const seal = validateSealProvenance(value.sourceSeal);
  if (
    seal.repository !== value.repository ||
    seal.issueNumber !== value.issueNumber ||
    seal.baseSha !== value.baseSha ||
    seal.sealWorkflow.runId !== value.publishWorkflow.runId ||
    seal.sealWorkflow.runAttempt > value.publishWorkflow.runAttempt
  ) {
    throw new Error("PUBLISH provenance와 source SEAL identity가 일치하지 않습니다");
  }
  validateSealedArtifactName(value.sourceSealArtifactName, seal);
  return value as unknown as PublishProvenance;
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
  if (input.publishRun.runId !== seal.sealWorkflow.runId) {
    throw new Error("PUBLISH run이 SEAL과 같은 Trusted Rail run이 아닙니다");
  }
  if (input.publishRun.runAttempt < seal.sealWorkflow.runAttempt) {
    throw new Error("PUBLISH attempt가 SEAL attempt보다 이전입니다");
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
