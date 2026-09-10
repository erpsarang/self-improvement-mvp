import { sha256 } from "./implement.js";
import type { ReviewProvenance, SemanticReviewFinding } from "./review.js";

// FIX는 IMPLEMENT와 같은 trust class이지만 explicit dispatch 재진입을 위해 전용 Worker workflow를 사용한다.
export const FIX_WORKFLOW_PATH = ".github/workflows/fix-worker.yml" as const;
export const FIX_REQUEST_WORKFLOW_PATH = ".github/workflows/fix-request.yml" as const;
export type FixAttempt = 1 | 2;

export interface FixRunIdentity {
  readonly runId: number;
  readonly runAttempt: number;
}

export interface FixRequestRunIdentity {
  readonly runId: number;
  readonly runAttempt: number;
  readonly trustedCodeSha: string;
}

export interface FixReviewBinding {
  readonly artifactName: string;
  readonly runId: number;
  readonly runAttempt: number;
  readonly reviewedBranch: string;
  readonly reviewedHeadSha: string;
  readonly requirementsDigest: string;
  readonly findingsDigest: string;
}

export interface FixRequestProvenance {
  readonly type: "FIX_REQUEST";
  readonly repository: string;
  readonly issueNumber: number;
  readonly fixAttempt: FixAttempt;
  readonly sourceReview: FixReviewBinding;
  readonly requestWorkflow: {
    readonly workflowPath: typeof FIX_REQUEST_WORKFLOW_PATH;
    readonly runId: number;
    readonly runAttempt: number;
    readonly trustedCodeSha: string;
  };
}

export interface FixProvenance {
  readonly type: "FIX";
  readonly repository: string;
  readonly issueNumber: number;
  readonly baseSha: string;
  readonly fixAttempt: FixAttempt;
  readonly sourceAuthorization: {
    readonly runId: number;
    readonly runAttempt: number;
    readonly approvalCommentId: number;
    readonly policySnapshot: string;
    readonly requirementsDigest: string;
    readonly authorizedBaseSha: string;
  };
  readonly sourceReview: FixReviewBinding;
  readonly sourceRequest: {
    readonly workflowPath: typeof FIX_REQUEST_WORKFLOW_PATH;
    readonly runId: number;
    readonly runAttempt: number;
    readonly artifactName: string;
    readonly trustedCodeSha: string;
  };
  readonly fixWorkflow: {
    readonly workflowPath: typeof FIX_WORKFLOW_PATH;
    readonly runId: number;
    readonly runAttempt: number;
  };
  readonly candidatePatchDigest: string;
  readonly aiExecution: {
    readonly provider: "openai-codex-action";
    readonly resultId: string;
  };
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

function localBlockers(review: ReviewProvenance): readonly SemanticReviewFinding[] {
  return review.findings.filter(
    (finding) => finding.severity === "BLOCKER" && finding.scope === "LOCAL",
  );
}

export function localFixFindingsDigest(review: ReviewProvenance): string {
  if (review.decision !== "LOCAL_FIX") {
    throw new Error("LOCAL_FIX REVIEW만 FIX findings digest를 만들 수 있습니다");
  }
  const blockers = localBlockers(review);
  if (blockers.length === 0) {
    throw new Error("LOCAL_FIX REVIEW에는 LOCAL BLOCKER가 필요합니다");
  }
  return sha256(`${JSON.stringify(blockers)}\n`);
}

export function completedFixCount(review: ReviewProvenance): 0 | 1 | 2 {
  const sourceFix = review.sourceVerify.sourcePublish.sourceSeal.sourceFix;
  if (!sourceFix) return 0;
  if (sourceFix.fixAttempt === 1 || sourceFix.fixAttempt === 2) {
    return sourceFix.fixAttempt;
  }
  throw new Error("source FIX attempt가 올바르지 않습니다");
}

export function nextFixAttempt(review: ReviewProvenance): FixAttempt | null {
  if (review.decision !== "LOCAL_FIX") return null;
  const completed = completedFixCount(review);
  if (completed >= 2) return null;
  return (completed + 1) as FixAttempt;
}

function reviewBinding(review: ReviewProvenance, artifactName: string): FixReviewBinding {
  return Object.freeze({
    artifactName,
    runId: review.reviewWorkflow.runId,
    runAttempt: review.reviewWorkflow.runAttempt,
    reviewedBranch: review.reviewedBranch,
    reviewedHeadSha: review.reviewedHeadSha,
    requirementsDigest: review.requirementsDigest,
    findingsDigest: localFixFindingsDigest(review),
  });
}

export function fixRequestArtifactName(request: FixRequestProvenance): string {
  return `fix-request-${request.sourceReview.runId}-fix-${request.fixAttempt}-${request.requestWorkflow.runId}-attempt-${request.requestWorkflow.runAttempt}`;
}

export function createFixRequestProvenance(input: {
  readonly review: ReviewProvenance;
  readonly reviewArtifactName: string;
  readonly requestRun: FixRequestRunIdentity;
}): FixRequestProvenance {
  const fixAttempt = nextFixAttempt(input.review);
  if (fixAttempt === null) {
    throw new Error("이 REVIEW에서는 FIX request를 만들 수 없습니다");
  }
  if (
    !positiveInteger(input.requestRun.runId) ||
    !positiveInteger(input.requestRun.runAttempt) ||
    !validSha(input.requestRun.trustedCodeSha)
  ) {
    throw new Error("FIX request workflow identity가 올바르지 않습니다");
  }
  return Object.freeze({
    type: "FIX_REQUEST" as const,
    repository: input.review.repository,
    issueNumber: input.review.issueNumber,
    fixAttempt,
    sourceReview: reviewBinding(input.review, input.reviewArtifactName),
    requestWorkflow: {
      workflowPath: FIX_REQUEST_WORKFLOW_PATH,
      runId: input.requestRun.runId,
      runAttempt: input.requestRun.runAttempt,
      trustedCodeSha: input.requestRun.trustedCodeSha,
    },
  });
}

export function validateFixRequestProvenance(value: unknown): FixRequestProvenance {
  if (!record(value) || !record(value.sourceReview) || !record(value.requestWorkflow)) {
    throw new Error("FIX request provenance가 올바르지 않습니다");
  }
  if (
    value.type !== "FIX_REQUEST" ||
    !validRepository(value.repository) ||
    !positiveInteger(value.issueNumber) ||
    !(value.fixAttempt === 1 || value.fixAttempt === 2) ||
    typeof value.sourceReview.artifactName !== "string" ||
    !positiveInteger(value.sourceReview.runId) ||
    !positiveInteger(value.sourceReview.runAttempt) ||
    value.sourceReview.reviewedBranch !== `ai-publish/issue-${String(value.issueNumber)}` ||
    !validSha(value.sourceReview.reviewedHeadSha) ||
    !validDigest(value.sourceReview.requirementsDigest) ||
    !validDigest(value.sourceReview.findingsDigest) ||
    value.requestWorkflow.workflowPath !== FIX_REQUEST_WORKFLOW_PATH ||
    !positiveInteger(value.requestWorkflow.runId) ||
    !positiveInteger(value.requestWorkflow.runAttempt) ||
    !validSha(value.requestWorkflow.trustedCodeSha)
  ) {
    throw new Error("FIX request provenance가 올바르지 않습니다");
  }
  const request = value as unknown as FixRequestProvenance;
  if (!new RegExp(
    `^review-provenance-issue-${request.issueNumber}-${request.sourceReview.runId}-attempt-${request.sourceReview.runAttempt}$`,
  ).test(request.sourceReview.artifactName)) {
    throw new Error("FIX request source REVIEW artifact identity가 올바르지 않습니다");
  }
  return request;
}

export function validateFixRequestAgainstReview(
  requestValue: unknown,
  review: ReviewProvenance,
  reviewArtifactName: string,
): FixRequestProvenance {
  const request = validateFixRequestProvenance(requestValue);
  const expectedAttempt = nextFixAttempt(review);
  if (expectedAttempt === null) throw new Error("source REVIEW는 추가 FIX를 허용하지 않습니다");
  const expectedBinding = reviewBinding(review, reviewArtifactName);
  if (
    request.repository !== review.repository ||
    request.issueNumber !== review.issueNumber ||
    request.fixAttempt !== expectedAttempt ||
    request.sourceReview.artifactName !== expectedBinding.artifactName ||
    request.sourceReview.runId !== expectedBinding.runId ||
    request.sourceReview.runAttempt !== expectedBinding.runAttempt ||
    request.sourceReview.reviewedBranch !== expectedBinding.reviewedBranch ||
    request.sourceReview.reviewedHeadSha !== expectedBinding.reviewedHeadSha ||
    request.sourceReview.requirementsDigest !== expectedBinding.requirementsDigest ||
    request.sourceReview.findingsDigest !== expectedBinding.findingsDigest
  ) {
    throw new Error("FIX request가 exact source REVIEW와 일치하지 않습니다");
  }
  return request;
}

export function createFixProvenance(input: {
  readonly review: ReviewProvenance;
  readonly reviewArtifactName: string;
  readonly request: FixRequestProvenance;
  readonly fixRun: FixRunIdentity;
  readonly candidatePatch: string | Buffer;
  readonly aiResultId: string;
}): FixProvenance {
  const review = input.review;
  const request = validateFixRequestAgainstReview(
    input.request,
    review,
    input.reviewArtifactName,
  );
  if (!input.aiResultId.trim()) throw new Error("AI 실행 결과 식별자가 필요합니다");
  if (!positiveInteger(input.fixRun.runId) || !positiveInteger(input.fixRun.runAttempt)) {
    throw new Error("FIX workflow identity가 올바르지 않습니다");
  }
  const patchSize =
    typeof input.candidatePatch === "string"
      ? Buffer.byteLength(input.candidatePatch)
      : input.candidatePatch.length;
  if (patchSize === 0) throw new Error("FIX candidate patch가 비어 있습니다");

  const compactAuthorization = review.sourceVerify.sourcePublish.sourceSeal.sourceAuthorization;
  if (compactAuthorization.requirementsDigest !== review.requirementsDigest) {
    throw new Error("FIX source REVIEW와 authorization requirements digest가 일치하지 않습니다");
  }

  return Object.freeze({
    type: "FIX" as const,
    repository: review.repository,
    issueNumber: review.issueNumber,
    baseSha: review.reviewedHeadSha,
    fixAttempt: request.fixAttempt,
    sourceAuthorization: { ...compactAuthorization },
    sourceReview: { ...request.sourceReview },
    sourceRequest: {
      workflowPath: FIX_REQUEST_WORKFLOW_PATH,
      runId: request.requestWorkflow.runId,
      runAttempt: request.requestWorkflow.runAttempt,
      artifactName: fixRequestArtifactName(request),
      trustedCodeSha: request.requestWorkflow.trustedCodeSha,
    },
    fixWorkflow: {
      workflowPath: FIX_WORKFLOW_PATH,
      runId: input.fixRun.runId,
      runAttempt: input.fixRun.runAttempt,
    },
    candidatePatchDigest: sha256(input.candidatePatch),
    aiExecution: {
      provider: "openai-codex-action" as const,
      resultId: input.aiResultId,
    },
  });
}
