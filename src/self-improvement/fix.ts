import { sha256 } from "./implement.js";
import type { ReviewProvenance, SemanticReviewFinding } from "./review.js";

export const FIX_WORKFLOW_PATH = ".github/workflows/fix.yml" as const;
export type FixAttempt = 1 | 2;

export interface FixRunIdentity {
  readonly runId: number;
  readonly runAttempt: number;
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
  readonly sourceReview: {
    readonly artifactName: string;
    readonly runId: number;
    readonly runAttempt: number;
    readonly reviewedBranch: string;
    readonly reviewedHeadSha: string;
    readonly requirementsDigest: string;
    readonly findingsDigest: string;
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

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
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
  const seal = review.sourceVerify.sourcePublish.sourceSeal;
  const sourceFix = seal.sourceFix;
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

export function createFixProvenance(input: {
  readonly review: ReviewProvenance;
  readonly reviewArtifactName: string;
  readonly fixRun: FixRunIdentity;
  readonly candidatePatch: string | Buffer;
  readonly aiResultId: string;
}): FixProvenance {
  const review = input.review;
  const fixAttempt = nextFixAttempt(review);
  if (fixAttempt === null) {
    throw new Error("이 REVIEW에서는 추가 FIX를 시작할 수 없습니다");
  }
  if (!input.aiResultId.trim()) throw new Error("AI 실행 결과 식별자가 필요합니다");
  if (!positiveInteger(input.fixRun.runId) || !positiveInteger(input.fixRun.runAttempt)) {
    throw new Error("FIX workflow identity가 올바르지 않습니다");
  }
  if (!validSha(review.reviewedHeadSha)) {
    throw new Error("REVIEW exact SHA가 올바르지 않습니다");
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
    fixAttempt,
    sourceAuthorization: { ...compactAuthorization },
    sourceReview: {
      artifactName: input.reviewArtifactName,
      runId: review.reviewWorkflow.runId,
      runAttempt: review.reviewWorkflow.runAttempt,
      reviewedBranch: review.reviewedBranch,
      reviewedHeadSha: review.reviewedHeadSha,
      requirementsDigest: review.requirementsDigest,
      findingsDigest: localFixFindingsDigest(review),
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
