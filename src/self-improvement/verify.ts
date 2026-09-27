import {
  validatePublishProvenance,
  type PublishBranchPolicy,
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

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function validatePublishArtifactName(
  artifactName: string,
  publish: PublishProvenance,
): void {
  const match = /^publish-provenance-issue-(\d+)-(\d+)-attempt-(\d+)$/.exec(
    artifactName,
  );
  if (!match) throw new Error("PUBLISH provenance artifact 이름이 올바르지 않습니다");

  if (
    Number(match[1]) !== publish.issueNumber ||
    Number(match[2]) !== publish.publishWorkflow.runId ||
    Number(match[3]) !== publish.publishWorkflow.runAttempt
  ) {
    throw new Error("PUBLISH provenance artifact identity가 provenance와 일치하지 않습니다");
  }
}

export function validatePublishedCandidateForVerify(input: {
  readonly publish: unknown;
  readonly publishArtifactName: string;
  readonly repository: string;
  /** 이전 run의 provenance를 읽을 때만 "historical"을 준다. 기본은 이번 run의 trusted SEAL branch만 허용한다. */
  readonly publishBranchPolicy?: PublishBranchPolicy;
}): PublishProvenance {
  // branch는 validatePublishProvenance가 trusted SEAL(baseSha + sealedPatchDigest)에서 다시 계산해 검증한다.
  const publish = validatePublishProvenance(input.publish, input.publishBranchPolicy ?? "current");
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
