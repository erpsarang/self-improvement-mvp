import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import {
  createSemanticReviewPrompt,
  createSemanticReviewProvenance,
  resolveApprovedPlanScope,
  SEMANTIC_REVIEW_OUTPUT_SCHEMA,
  validateVerifiedCandidateForReview,
  validateVerifyProvenanceForReview,
} from "./review.js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} 환경변수가 필요합니다`);
  return value;
}

function positiveIntegerEnv(name: string): number {
  const value = Number(requiredEnv(name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name}은 양의 정수여야 합니다`);
  }
  return value;
}

function writeOutput(name: string, value: string | number): void {
  appendFileSync(requiredEnv("GITHUB_OUTPUT"), `${name}=${String(value)}\n`, "utf8");
}

function parseJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

const command = process.argv[2];
if (command !== "source" && command !== "prepare" && command !== "finalize") {
  throw new Error("review-handler command는 source, prepare 또는 finalize여야 합니다");
}

const verifyJsonPath = requiredEnv("VERIFY_JSON");
const verifyArtifactName = requiredEnv("VERIFY_ARTIFACT_NAME");
const repository = requiredEnv("REVIEW_REPOSITORY");
const verify: unknown = parseJson(verifyJsonPath);
const validatedVerify = validateVerifyProvenanceForReview({
  verify,
  verifyArtifactName,
  repository,
});
const sourcePlanBridge = validatedVerify.sourcePublish.sourceSeal.sourcePlanBridge;

if (command === "source") {
  writeOutput("issue_number", validatedVerify.issueNumber);
  writeOutput("verified_branch", validatedVerify.verifiedBranch);
  writeOutput("verified_head_sha", validatedVerify.verifiedHeadSha);
  writeOutput("base_sha", validatedVerify.sourcePublish.baseSha);

  if (sourcePlanBridge) {
    const sourcePlanAuthorize = sourcePlanBridge.bridge.sourcePlanAuthorize;
    writeOutput("authority_kind", "PLAN_AUTHORIZE");
    writeOutput("plan_authorize_run_id", sourcePlanAuthorize.authorization.authorization.runId);
    writeOutput("plan_authorize_run_attempt", sourcePlanAuthorize.authorization.authorization.runAttempt);
    writeOutput("plan_authorize_artifact_name", sourcePlanAuthorize.artifact.name);
    // 승인된 PLAN artifact(PLAN.json)는 PLAN 계보 REVIEW의 심사 기준이다. workflow가 exact run/name으로 내려받는다.
    writeOutput("plan_run_id", sourcePlanAuthorize.authorization.plan.runId);
    writeOutput("plan_artifact_name", sourcePlanAuthorize.authorization.plan.artifact.name);
    writeOutput("requirements_digest", sourcePlanBridge.bridge.requirement.digest);
  } else {
    const sourceAuthorization = validatedVerify.sourcePublish.sourceSeal.sourceAuthorization;
    if (!sourceAuthorization) {
      throw new Error("VERIFY chain에 AUTHORIZE 또는 PLAN_AUTHORIZE authority가 없습니다");
    }
    const authorizationArtifactName =
      `authorize-approval-${sourceAuthorization.approvalCommentId}-attempt-${sourceAuthorization.runAttempt}`;
    writeOutput("authority_kind", "AUTHORIZE");
    writeOutput("authorization_run_id", sourceAuthorization.runId);
    writeOutput("authorization_run_attempt", sourceAuthorization.runAttempt);
    writeOutput("authorization_artifact_name", authorizationArtifactName);
    writeOutput("requirements_digest", sourceAuthorization.requirementsDigest);
  }
  process.exit(0);
}

const reviewContext = sourcePlanBridge
  ? (() => {
      const planAuthorization = parseJson(requiredEnv("PLAN_AUTHORIZE_JSON"));
      const planAuthorizationArtifactName = requiredEnv("PLAN_AUTHORIZE_ARTIFACT_NAME");
      const validated = validateVerifiedCandidateForReview({
        verify,
        verifyArtifactName,
        planAuthorization,
        planAuthorizationArtifactName,
        repository,
      });
      return {
        authorityKind: "PLAN_AUTHORIZE" as const,
        planAuthorization,
        planAuthorizationArtifactName,
        validated,
      };
    })()
  : (() => {
      const authorization = parseJson(requiredEnv("AUTHORIZE_JSON"));
      const authorizationArtifactName = requiredEnv("AUTHORIZE_ARTIFACT_NAME");
      const validated = validateVerifiedCandidateForReview({
        verify,
        verifyArtifactName,
        authorization,
        authorizationArtifactName,
        repository,
      });
      return {
        authorityKind: "AUTHORIZE" as const,
        authorization,
        authorizationArtifactName,
        validated,
      };
    })();

const validated = reviewContext.validated;
// PLAN 계보: 승인된 PLAN.json이 없으면 prepare/finalize 모두 fail-closed. Issue 본문만으로 심사하지 않는다.
const approvedPlan: unknown = reviewContext.authorityKind === "PLAN_AUTHORIZE"
  ? parseJson(requiredEnv("PLAN_JSON"))
  : undefined;
const approvedPlanScope = resolveApprovedPlanScope(validated, approvedPlan);

if (command === "prepare") {
  const runtimeDir = requiredEnv("REVIEW_RUNTIME_DIR");
  mkdirSync(runtimeDir, { recursive: true });

  const prompt = createSemanticReviewPrompt({
    repository,
    issueNumber: validated.verify.issueNumber,
    baseSha: validated.verify.sourcePublish.baseSha,
    verifiedHeadSha: validated.verify.verifiedHeadSha,
    requirements: validated.requirements,
    ...(approvedPlanScope ? { approvedPlan: approvedPlanScope } : {}),
  });
  const reviewInput = Object.freeze({
    repository,
    issueNumber: validated.verify.issueNumber,
    baseSha: validated.verify.sourcePublish.baseSha,
    verifiedBranch: validated.verify.verifiedBranch,
    verifiedHeadSha: validated.verify.verifiedHeadSha,
    requirements: validated.requirements,
    sourceVerifyArtifactName: verifyArtifactName,
    ...(reviewContext.authorityKind === "PLAN_AUTHORIZE"
      ? {
          sourcePlanAuthorizeArtifactName: reviewContext.planAuthorizationArtifactName,
          approvedPlanScope,
        }
      : { sourceAuthorizationArtifactName: reviewContext.authorizationArtifactName }),
  });

  writeFileSync(`${runtimeDir}/review-input.json`, `${JSON.stringify(reviewInput, null, 2)}\n`, "utf8");
  writeFileSync(`${runtimeDir}/review-prompt.md`, prompt, "utf8");
  writeFileSync(
    `${runtimeDir}/review-output.schema.json`,
    `${JSON.stringify(SEMANTIC_REVIEW_OUTPUT_SCHEMA, null, 2)}\n`,
    "utf8",
  );

  const runId = positiveIntegerEnv("REVIEW_RUN_ID");
  const runAttempt = positiveIntegerEnv("REVIEW_RUN_ATTEMPT");
  writeOutput("issue_number", validated.verify.issueNumber);
  writeOutput("verified_head_sha", validated.verify.verifiedHeadSha);
  writeOutput("verify_artifact_name", verifyArtifactName);
  writeOutput("authority_kind", reviewContext.authorityKind);
  if (reviewContext.authorityKind === "PLAN_AUTHORIZE") {
    writeOutput("plan_authorize_artifact_name", reviewContext.planAuthorizationArtifactName);
  } else {
    writeOutput("authorization_artifact_name", reviewContext.authorizationArtifactName);
  }
  writeOutput(
    "review_input_artifact_name",
    `review-input-issue-${validated.verify.issueNumber}-${runId}-attempt-${runAttempt}`,
  );
  process.exit(0);
}

const rawReviewerOutput = readFileSync(requiredEnv("REVIEWER_OUTPUT_JSON"));
const reviewerOutput: unknown = JSON.parse(rawReviewerOutput.toString("utf8"));
const reviewRun = {
  runId: positiveIntegerEnv("REVIEW_RUN_ID"),
  runAttempt: positiveIntegerEnv("REVIEW_RUN_ATTEMPT"),
  trustedCodeSha: requiredEnv("REVIEW_TRUSTED_CODE_SHA").toLowerCase(),
};
const provenance = reviewContext.authorityKind === "PLAN_AUTHORIZE"
  ? createSemanticReviewProvenance({
      verify: reviewContext.validated.verify,
      verifyArtifactName,
      planAuthorization: reviewContext.planAuthorization,
      planAuthorizationArtifactName: reviewContext.planAuthorizationArtifactName,
      approvedPlan,
      repository,
      reviewerOutput,
      rawReviewerOutput,
      reviewerOutputArtifactName: requiredEnv("REVIEWER_OUTPUT_ARTIFACT_NAME"),
      reviewerProvider: requiredEnv("REVIEWER_PROVIDER"),
      reviewRun,
    })
  : createSemanticReviewProvenance({
      verify: reviewContext.validated.verify,
      verifyArtifactName,
      authorization: reviewContext.authorization,
      authorizationArtifactName: reviewContext.authorizationArtifactName,
      repository,
      reviewerOutput,
      rawReviewerOutput,
      reviewerOutputArtifactName: requiredEnv("REVIEWER_OUTPUT_ARTIFACT_NAME"),
      reviewerProvider: requiredEnv("REVIEWER_PROVIDER"),
      reviewRun,
    });

writeFileSync(
  requiredEnv("REVIEW_JSON"),
  `${JSON.stringify(provenance, null, 2)}\n`,
  "utf8",
);
writeOutput("decision", provenance.decision);
writeOutput("issue_number", provenance.issueNumber);
writeOutput("reviewed_head_sha", provenance.reviewedHeadSha);
