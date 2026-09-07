import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import {
  createOrchestrationProvenance,
  routeReviewDecision,
  validateReviewForOrchestration,
  type HumanMergePullRequest,
  type ReviewSourceRun,
} from "./orchestrator.js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} 환경변수가 필요합니다`);
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : undefined;
}

function positiveIntegerEnv(name: string): number {
  const value = Number(requiredEnv(name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name}은 양의 정수여야 합니다`);
  }
  return value;
}

function writeOutput(name: string, value: string | number | boolean): void {
  appendFileSync(requiredEnv("GITHUB_OUTPUT"), `${name}=${String(value)}\n`, "utf8");
}

function sourceRun(): ReviewSourceRun {
  return {
    id: positiveIntegerEnv("SOURCE_REVIEW_RUN_ID"),
    runAttempt: positiveIntegerEnv("SOURCE_REVIEW_RUN_ATTEMPT"),
    repository: requiredEnv("ORCHESTRATOR_REPOSITORY"),
    conclusion: requiredEnv("SOURCE_REVIEW_CONCLUSION"),
    workflowPath: requiredEnv("SOURCE_REVIEW_WORKFLOW_PATH"),
  };
}

function mergeBoundaryOrNull(shouldCreatePr: boolean): HumanMergePullRequest | null {
  const number = optionalEnv("MERGE_PR_NUMBER");
  const url = optionalEnv("MERGE_PR_URL");
  const baseBranch = optionalEnv("MERGE_PR_BASE_BRANCH");
  const headBranch = optionalEnv("MERGE_PR_HEAD_BRANCH");
  const headSha = optionalEnv("MERGE_PR_HEAD_SHA");
  const provided = [number, url, baseBranch, headBranch, headSha].filter(
    (value) => value !== undefined,
  ).length;

  if (!shouldCreatePr) {
    if (provided !== 0) {
      throw new Error("PASS가 아닌 decision에는 Merge PR 환경값을 제공할 수 없습니다");
    }
    return null;
  }
  if (provided !== 5) {
    throw new Error("PASS decision에는 완전한 Merge PR identity가 필요합니다");
  }

  const prNumber = Number(number);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    throw new Error("MERGE_PR_NUMBER가 올바르지 않습니다");
  }
  return {
    type: "HUMAN_PULL_REQUEST",
    number: prNumber,
    url: url!,
    baseBranch: baseBranch!,
    headBranch: headBranch!,
    headSha: headSha!.toLowerCase(),
  };
}

const command = process.argv[2];
if (command !== "prepare" && command !== "finalize") {
  throw new Error("orchestrator-handler command는 prepare 또는 finalize여야 합니다");
}

const reviewJsonPath = requiredEnv("REVIEW_JSON");
const reviewArtifactName = requiredEnv("REVIEW_ARTIFACT_NAME");
const review: unknown = JSON.parse(readFileSync(reviewJsonPath, "utf8"));
const trustedSourceRun = sourceRun();
const validatedReview = validateReviewForOrchestration({
  review,
  reviewArtifactName,
  sourceRun: trustedSourceRun,
});
const route = routeReviewDecision(validatedReview);

if (command === "prepare") {
  writeOutput("issue_number", validatedReview.issueNumber);
  writeOutput("decision", validatedReview.decision);
  writeOutput("next_state", route.nextState);
  writeOutput("should_create_pr", route.shouldCreatePullRequest);
  writeOutput("reviewed_branch", validatedReview.reviewedBranch);
  writeOutput("reviewed_head_sha", validatedReview.reviewedHeadSha);
  writeOutput("requirements_digest", validatedReview.requirementsDigest);
  process.exit(0);
}

const provenance = createOrchestrationProvenance({
  review: validatedReview,
  reviewArtifactName,
  sourceRun: trustedSourceRun,
  orchestratorRun: {
    runId: positiveIntegerEnv("ORCHESTRATOR_RUN_ID"),
    runAttempt: positiveIntegerEnv("ORCHESTRATOR_RUN_ATTEMPT"),
    trustedCodeSha: requiredEnv("ORCHESTRATOR_TRUSTED_CODE_SHA").toLowerCase(),
  },
  defaultBranch: requiredEnv("DEFAULT_BRANCH"),
  mergeBoundary: mergeBoundaryOrNull(route.shouldCreatePullRequest),
});

writeFileSync(
  requiredEnv("ORCHESTRATION_JSON"),
  `${JSON.stringify(provenance, null, 2)}\n`,
  "utf8",
);
