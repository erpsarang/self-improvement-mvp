import {
  publishBranchName,
  type PublishProvenance,
} from "./publish.js";
import { TRUSTED_RAIL_WORKFLOW_PATH } from "./seal.js";

export interface VerifyRunIdentity {
  readonly runId: number;
  readonly runAttempt: number;
  readonly trustedCodeSha: string;
}

export interface VerifyProvenance {
  readonly type: "VERIFY";
  readonly repository: string;
  readonly issueNumber: number;
  readonly sourcePublishArtifactName: string;
  readonly sourcePublish: PublishProvenance;
  readonly verifyWorkflow: {
    readonly workflowPath: typeof TRUSTED_RAIL_WORKFLOW_PATH;
    readonly runId: number;
    readonly runAttempt: number;
    readonly trustedCodeSha: string;
  };
  readonly verifiedBranch: string;
  readonly verifiedHeadSha: string;
  readonly result: "PASS";
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

function validPublishProvenance(value: unknown): value is PublishProvenance {
  if (!record(value)) return false;
  const sourceSeal = value.sourceSeal;
  const publishWorkflow = value.publishWorkflow;
  if (!record(sourceSeal) || !record(publishWorkflow)) return false;

  const sourceAuthorization = sourceSeal.sourceAuthorization;
  const sourceImplement = sourceSeal.sourceImplement;
  const sealWorkflow = sourceSeal.sealWorkflow;
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
    value.type === "PUBLISH" &&
    validRepository(value.repository) &&
    positiveInteger(value.issueNumber) &&
    validSha(value.baseSha) &&
    typeof value.sourceSealArtifactName === "string" &&
    sourceSeal.type === "SEAL" &&
    sourceSeal.repository === value.repository &&
    sourceSeal.issueNumber === value.issueNumber &&
    sourceSeal.baseSha === value.baseSha &&
    positiveInteger(sourceAuthorization.runId) &&
    positiveInteger(sourceAuthorization.runAttempt) &&
    positiveInteger(sourceAuthorization.approvalCommentId) &&
    validDigest(sourceAuthorization.policySnapshot) &&
    validDigest(sourceAuthorization.requirementsDigest) &&
    validSha(sourceAuthorization.authorizedBaseSha) &&
    sourceAuthorization.authorizedBaseSha === value.baseSha &&
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
    validDigest(sourceSeal.sealedPatchDigest) &&
    sourceImplement.candidatePatchDigest === sourceSeal.sealedPatchDigest &&
    publishWorkflow.workflowPath === TRUSTED_RAIL_WORKFLOW_PATH &&
    positiveInteger(publishWorkflow.runId) &&
    positiveInteger(publishWorkflow.runAttempt) &&
    validSha(publishWorkflow.trustedCodeSha) &&
    sealWorkflow.runId === publishWorkflow.runId &&
    sealWorkflow.runAttempt <= publishWorkflow.runAttempt &&
    value.publishedBranch === publishBranchName(value.issueNumber) &&
    validSha(value.publishedHeadSha)
  );
}

function validatePublishArtifactName(
  artifactName: string,
  publish: PublishProvenance,
): void {
  const match = /^publish-provenance-issue-(\d+)-(\d+)-attempt-(\d+)$/.exec(
    artifactName,
  );
  if (!match) throw new Error("PUBLISH provenance artifact 이름이 올바르지 않습니다");

  const issueNumber = Number(match[1]);
  const runId = Number(match[2]);
  const runAttempt = Number(match[3]);
  if (
    issueNumber !== publish.issueNumber ||
    runId !== publish.publishWorkflow.runId ||
    runAttempt !== publish.publishWorkflow.runAttempt
  ) {
    throw new Error("PUBLISH provenance artifact identity가 provenance와 일치하지 않습니다");
  }
}

export function validatePublishedCandidateForVerify(input: {
  readonly publish: unknown;
  readonly publishArtifactName: string;
  readonly repository: string;
}): PublishProvenance {
  if (!validPublishProvenance(input.publish)) {
    throw new Error("PUBLISH provenance가 올바르지 않습니다");
  }
  const publish = input.publish;
  if (publish.repository !== input.repository) {
    throw new Error("PUBLISH repository가 현재 repository와 일치하지 않습니다");
  }
  validatePublishArtifactName(input.publishArtifactName, publish);
  return publish;
}

export function createVerifyProvenance(input: {
  readonly publish: unknown;
  readonly publishArtifactName: string;
  readonly repository: string;
  readonly verifyRun: VerifyRunIdentity;
  readonly verifiedHeadSha: string;
}): VerifyProvenance {
  const publish = validatePublishedCandidateForVerify(input);
  if (!positiveInteger(input.verifyRun.runId) || !positiveInteger(input.verifyRun.runAttempt)) {
    throw new Error("VERIFY workflow identity가 올바르지 않습니다");
  }
  if (!validSha(input.verifyRun.trustedCodeSha)) {
    throw new Error("VERIFY trusted control-plane SHA가 올바르지 않습니다");
  }
  if (input.verifyRun.runId !== publish.publishWorkflow.runId) {
    throw new Error("VERIFY run이 PUBLISH와 같은 Trusted Rail run이 아닙니다");
  }
  if (input.verifyRun.runAttempt < publish.publishWorkflow.runAttempt) {
    throw new Error("VERIFY attempt가 source PUBLISH attempt보다 이전입니다");
  }

  const verifiedHeadSha = input.verifiedHeadSha.toLowerCase();
  if (!validSha(verifiedHeadSha)) {
    throw new Error("verified SHA는 40자리 Git SHA여야 합니다");
  }
  if (verifiedHeadSha !== publish.publishedHeadSha) {
    throw new Error("검증 대상 SHA가 publishedHeadSha와 일치하지 않습니다");
  }

  return Object.freeze({
    type: "VERIFY" as const,
    repository: publish.repository,
    issueNumber: publish.issueNumber,
    sourcePublishArtifactName: input.publishArtifactName,
    sourcePublish: publish,
    verifyWorkflow: {
      workflowPath: TRUSTED_RAIL_WORKFLOW_PATH,
      runId: input.verifyRun.runId,
      runAttempt: input.verifyRun.runAttempt,
      trustedCodeSha: input.verifyRun.trustedCodeSha,
    },
    verifiedBranch: publish.publishedBranch,
    verifiedHeadSha,
    result: "PASS" as const,
  });
}
