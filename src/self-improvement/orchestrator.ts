import {
  requirementsSnapshot,
  type ApprovedRequirements,
} from "./authorization.js";
import { completedFixCount, nextFixAttempt, type FixAttempt } from "./fix.js";
import {
  validateSemanticReviewerOutput,
  validateVerifyProvenanceForReview,
  type ReviewProvenance,
} from "./review.js";
import { TRUSTED_RAIL_WORKFLOW_PATH } from "./seal.js";

export const ORCHESTRATOR_WORKFLOW_PATH =
  ".github/workflows/orchestrator.yml" as const;

export type OrchestratorNextState = "MERGE_READY" | "FIXING" | "STOPPED";

export interface ReviewSourceRun {
  readonly id: number;
  readonly runAttempt: number;
  readonly repository: string;
  readonly conclusion: string;
  readonly workflowPath: string;
}

export interface OrchestratorRunIdentity {
  readonly runId: number;
  readonly runAttempt: number;
  readonly trustedCodeSha: string;
}

export interface HumanMergePullRequest {
  readonly type: "HUMAN_PULL_REQUEST";
  readonly number: number;
  readonly url: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly headSha: string;
}

export interface OrchestrationProvenance {
  readonly type: "ORCHESTRATION";
  readonly repository: string;
  readonly issueNumber: number;
  readonly sourceReviewArtifactName: string;
  readonly sourceReview: ReviewProvenance;
  readonly orchestratorWorkflow: {
    readonly workflowPath: typeof ORCHESTRATOR_WORKFLOW_PATH;
    readonly runId: number;
    readonly runAttempt: number;
    readonly trustedCodeSha: string;
  };
  readonly fromState: "REVIEWING";
  readonly decision: ReviewProvenance["decision"];
  readonly nextState: OrchestratorNextState;
  readonly completedFixCount: 0 | 1 | 2;
  readonly nextFixAttempt: FixAttempt | null;
  readonly reviewedBranch: string;
  readonly reviewedHeadSha: string;
  readonly requirementsDigest: string;
  readonly mergeBoundary: HumanMergePullRequest | null;
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

function validBranch(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    !value.startsWith("-") &&
    !/[~^:?*\[\\\s]/.test(value) &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.includes("//")
  );
}

function validateRequirements(value: unknown): ApprovedRequirements {
  if (
    !record(value) ||
    typeof value.title !== "string" ||
    !(value.body === null || typeof value.body === "string") ||
    !validDigest(value.digest)
  ) {
    throw new Error("REVIEW requirements snapshot이 올바르지 않습니다");
  }

  const expected = requirementsSnapshot(value.title, value.body);
  if (expected.digest !== value.digest) {
    throw new Error("REVIEW requirements digest가 snapshot과 일치하지 않습니다");
  }
  return expected;
}

function validateReviewArtifactName(
  artifactName: string,
  review: ReviewProvenance,
): void {
  const match = /^review-provenance-issue-(\d+)-(\d+)-attempt-(\d+)$/.exec(
    artifactName,
  );
  if (!match) throw new Error("REVIEW provenance artifact 이름이 올바르지 않습니다");

  if (
    Number(match[1]) !== review.issueNumber ||
    Number(match[2]) !== review.reviewWorkflow.runId ||
    Number(match[3]) !== review.reviewWorkflow.runAttempt
  ) {
    throw new Error("REVIEW provenance artifact identity가 provenance와 일치하지 않습니다");
  }
}

export function validateReviewForOrchestration(input: {
  readonly review: unknown;
  readonly reviewArtifactName: string;
  readonly sourceRun: ReviewSourceRun;
}): ReviewProvenance {
  if (!record(input.review)) throw new Error("REVIEW provenance가 올바르지 않습니다");
  const value = input.review;

  if (
    value.type !== "REVIEW" ||
    !validRepository(value.repository) ||
    !positiveInteger(value.issueNumber) ||
    typeof value.sourceVerifyArtifactName !== "string" ||
    !record(value.sourceVerify) ||
    typeof value.sourceAuthorizationArtifactName !== "string" ||
    !record(value.requirements) ||
    !record(value.reviewWorkflow) ||
    value.reviewWorkflow.workflowPath !== TRUSTED_RAIL_WORKFLOW_PATH ||
    !positiveInteger(value.reviewWorkflow.runId) ||
    !positiveInteger(value.reviewWorkflow.runAttempt) ||
    !validSha(value.reviewWorkflow.trustedCodeSha) ||
    !validBranch(value.reviewedBranch) ||
    !validSha(value.reviewedHeadSha) ||
    !validDigest(value.requirementsDigest) ||
    !record(value.reviewer) ||
    typeof value.reviewer.provider !== "string" ||
    value.reviewer.provider.trim().length === 0 ||
    !positiveInteger(value.reviewer.runId) ||
    !positiveInteger(value.reviewer.runAttempt) ||
    typeof value.reviewer.outputArtifactName !== "string" ||
    !validDigest(value.reviewer.outputDigest) ||
    typeof value.decision !== "string" ||
    typeof value.summary !== "string" ||
    !Array.isArray(value.findings)
  ) {
    throw new Error("REVIEW provenance 구조가 올바르지 않습니다");
  }

  const review = value as unknown as ReviewProvenance;
  const verify = validateVerifyProvenanceForReview({
    verify: review.sourceVerify,
    verifyArtifactName: review.sourceVerifyArtifactName,
    repository: review.repository,
  });
  const requirements = validateRequirements(review.requirements);
  const compactAuthorization = verify.sourcePublish.sourceSeal.sourceAuthorization;

  if (
    review.issueNumber !== verify.issueNumber ||
    review.reviewedBranch !== verify.verifiedBranch ||
    review.reviewedHeadSha !== verify.verifiedHeadSha ||
    review.requirementsDigest !== requirements.digest ||
    review.requirementsDigest !== compactAuthorization.requirementsDigest
  ) {
    throw new Error("REVIEW exact identity가 VERIFY/AUTHORIZE chain과 일치하지 않습니다");
  }

  const expectedAuthorizationArtifact =
    `authorize-approval-${compactAuthorization.approvalCommentId}-attempt-${compactAuthorization.runAttempt}`;
  if (review.sourceAuthorizationArtifactName !== expectedAuthorizationArtifact) {
    throw new Error("REVIEW AUTHORIZE artifact binding이 올바르지 않습니다");
  }

  if (
    input.sourceRun.conclusion !== "success" ||
    input.sourceRun.workflowPath !== TRUSTED_RAIL_WORKFLOW_PATH ||
    input.sourceRun.repository !== review.repository ||
    input.sourceRun.id !== review.reviewWorkflow.runId ||
    input.sourceRun.runAttempt !== review.reviewWorkflow.runAttempt
  ) {
    throw new Error("REVIEW source Trusted Rail run identity가 일치하지 않습니다");
  }

  if (
    review.reviewer.runId !== review.reviewWorkflow.runId ||
    review.reviewer.runAttempt < verify.verifyWorkflow.runAttempt ||
    review.reviewer.runAttempt > review.reviewWorkflow.runAttempt
  ) {
    throw new Error("REVIEW reviewer run identity가 올바르지 않습니다");
  }
  const expectedReviewerArtifact =
    `reviewer-output-issue-${review.issueNumber}-${review.reviewer.runId}-attempt-${review.reviewer.runAttempt}`;
  if (review.reviewer.outputArtifactName !== expectedReviewerArtifact) {
    throw new Error("REVIEW reviewer artifact identity가 올바르지 않습니다");
  }

  validateSemanticReviewerOutput({
    decision: review.decision,
    summary: review.summary,
    findings: review.findings,
  });
  validateReviewArtifactName(input.reviewArtifactName, review);
  return review;
}

export function routeReviewDecision(
  review: ReviewProvenance,
): {
  readonly fromState: "REVIEWING";
  readonly nextState: OrchestratorNextState;
  readonly shouldCreatePullRequest: boolean;
  readonly shouldDispatchFix: boolean;
  readonly completedFixCount: 0 | 1 | 2;
  readonly nextFixAttempt: FixAttempt | null;
} {
  const completed = completedFixCount(review);
  if (review.decision === "PASS") {
    return Object.freeze({
      fromState: "REVIEWING" as const,
      nextState: "MERGE_READY" as const,
      shouldCreatePullRequest: true,
      shouldDispatchFix: false,
      completedFixCount: completed,
      nextFixAttempt: null,
    });
  }
  if (review.decision === "STRUCTURAL_CHANGE") {
    return Object.freeze({
      fromState: "REVIEWING" as const,
      nextState: "STOPPED" as const,
      shouldCreatePullRequest: false,
      shouldDispatchFix: false,
      completedFixCount: completed,
      nextFixAttempt: null,
    });
  }
  if (review.decision === "LOCAL_FIX") {
    const next = nextFixAttempt(review);
    if (next === null) {
      return Object.freeze({
        fromState: "REVIEWING" as const,
        nextState: "STOPPED" as const,
        shouldCreatePullRequest: false,
        shouldDispatchFix: false,
        completedFixCount: completed,
        nextFixAttempt: null,
      });
    }
    return Object.freeze({
      fromState: "REVIEWING" as const,
      nextState: "FIXING" as const,
      shouldCreatePullRequest: false,
      shouldDispatchFix: true,
      completedFixCount: completed,
      nextFixAttempt: next,
    });
  }
  throw new Error(`지원하지 않는 REVIEW decision입니다: ${String(review.decision)}`);
}

function validateMergeBoundary(input: {
  readonly value: HumanMergePullRequest | null;
  readonly review: ReviewProvenance;
  readonly nextState: OrchestratorNextState;
  readonly defaultBranch: string;
}): HumanMergePullRequest | null {
  const requiresPr = input.nextState === "MERGE_READY";
  if (!requiresPr) {
    if (input.value !== null) {
      throw new Error("MERGE_READY가 아닌 상태에는 Merge PR이 있을 수 없습니다");
    }
    return null;
  }

  const pr = input.value;
  if (
    pr === null ||
    pr.type !== "HUMAN_PULL_REQUEST" ||
    !positiveInteger(pr.number) ||
    typeof pr.url !== "string" ||
    !pr.url.startsWith(`https://github.com/${input.review.repository}/pull/`) ||
    !validBranch(pr.baseBranch) ||
    !validBranch(pr.headBranch) ||
    !validSha(pr.headSha)
  ) {
    throw new Error("Human Merge PR identity가 올바르지 않습니다");
  }
  if (
    pr.baseBranch !== input.defaultBranch ||
    pr.headBranch !== input.review.reviewedBranch ||
    pr.headSha !== input.review.reviewedHeadSha
  ) {
    throw new Error("Human Merge PR이 exact reviewed SHA에 결합되지 않았습니다");
  }
  return Object.freeze({ ...pr });
}

export function createOrchestrationProvenance(input: {
  readonly review: unknown;
  readonly reviewArtifactName: string;
  readonly sourceRun: ReviewSourceRun;
  readonly orchestratorRun: OrchestratorRunIdentity;
  readonly defaultBranch: string;
  readonly mergeBoundary: HumanMergePullRequest | null;
}): OrchestrationProvenance {
  const review = validateReviewForOrchestration(input);
  const route = routeReviewDecision(review);

  if (
    !positiveInteger(input.orchestratorRun.runId) ||
    !positiveInteger(input.orchestratorRun.runAttempt) ||
    !validSha(input.orchestratorRun.trustedCodeSha)
  ) {
    throw new Error("Orchestrator workflow identity가 올바르지 않습니다");
  }
  if (!validBranch(input.defaultBranch)) {
    throw new Error("default branch가 올바르지 않습니다");
  }

  const mergeBoundary = validateMergeBoundary({
    value: input.mergeBoundary,
    review,
    nextState: route.nextState,
    defaultBranch: input.defaultBranch,
  });

  return Object.freeze({
    type: "ORCHESTRATION" as const,
    repository: review.repository,
    issueNumber: review.issueNumber,
    sourceReviewArtifactName: input.reviewArtifactName,
    sourceReview: review,
    orchestratorWorkflow: {
      workflowPath: ORCHESTRATOR_WORKFLOW_PATH,
      runId: input.orchestratorRun.runId,
      runAttempt: input.orchestratorRun.runAttempt,
      trustedCodeSha: input.orchestratorRun.trustedCodeSha,
    },
    fromState: route.fromState,
    decision: review.decision,
    nextState: route.nextState,
    completedFixCount: route.completedFixCount,
    nextFixAttempt: route.nextFixAttempt,
    reviewedBranch: review.reviewedBranch,
    reviewedHeadSha: review.reviewedHeadSha,
    requirementsDigest: review.requirementsDigest,
    mergeBoundary,
  });
}
