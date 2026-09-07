import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import {
  createSemanticReviewPrompt,
  createSemanticReviewProvenance,
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

if (command === "source") {
  const validatedVerify = validateVerifyProvenanceForReview({
    verify,
    verifyArtifactName,
    repository,
  });
  const sourceAuthorization =
    validatedVerify.sourcePublish.sourceSeal.sourceAuthorization;
  const authorizationArtifactName =
    `authorize-approval-${sourceAuthorization.approvalCommentId}-attempt-${sourceAuthorization.runAttempt}`;

  writeOutput("issue_number", validatedVerify.issueNumber);
  writeOutput("verified_branch", validatedVerify.verifiedBranch);
  writeOutput("verified_head_sha", validatedVerify.verifiedHeadSha);
  writeOutput("base_sha", validatedVerify.sourcePublish.baseSha);
  writeOutput("authorization_run_id", sourceAuthorization.runId);
  writeOutput("authorization_run_attempt", sourceAuthorization.runAttempt);
  writeOutput("authorization_artifact_name", authorizationArtifactName);
  writeOutput("requirements_digest", sourceAuthorization.requirementsDigest);
  process.exit(0);
}

const authorizationJsonPath = requiredEnv("AUTHORIZE_JSON");
const authorizationArtifactName = requiredEnv("AUTHORIZE_ARTIFACT_NAME");
const authorization: unknown = parseJson(authorizationJsonPath);
const validated = validateVerifiedCandidateForReview({
  verify,
  verifyArtifactName,
  authorization,
  authorizationArtifactName,
  repository,
});

if (command === "prepare") {
  const runtimeDir = requiredEnv("REVIEW_RUNTIME_DIR");
  mkdirSync(runtimeDir, { recursive: true });

  const prompt = createSemanticReviewPrompt({
    repository,
    issueNumber: validated.verify.issueNumber,
    baseSha: validated.verify.sourcePublish.baseSha,
    verifiedHeadSha: validated.verify.verifiedHeadSha,
    requirements: validated.authorization.requirements,
  });
  const reviewInput = Object.freeze({
    repository,
    issueNumber: validated.verify.issueNumber,
    baseSha: validated.verify.sourcePublish.baseSha,
    verifiedBranch: validated.verify.verifiedBranch,
    verifiedHeadSha: validated.verify.verifiedHeadSha,
    requirements: validated.authorization.requirements,
    sourceVerifyArtifactName: verifyArtifactName,
    sourceAuthorizationArtifactName: authorizationArtifactName,
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
  writeOutput("authorization_artifact_name", authorizationArtifactName);
  writeOutput(
    "review_input_artifact_name",
    `review-input-issue-${validated.verify.issueNumber}-${runId}-attempt-${runAttempt}`,
  );
  process.exit(0);
}

const rawReviewerOutput = readFileSync(requiredEnv("REVIEWER_OUTPUT_JSON"));
const reviewerOutput: unknown = JSON.parse(rawReviewerOutput.toString("utf8"));
const provenance = createSemanticReviewProvenance({
  verify: validated.verify,
  verifyArtifactName,
  authorization: validated.authorization,
  authorizationArtifactName,
  repository,
  reviewerOutput,
  rawReviewerOutput,
  reviewerOutputArtifactName: requiredEnv("REVIEWER_OUTPUT_ARTIFACT_NAME"),
  reviewerProvider: requiredEnv("REVIEWER_PROVIDER"),
  reviewRun: {
    runId: positiveIntegerEnv("REVIEW_RUN_ID"),
    runAttempt: positiveIntegerEnv("REVIEW_RUN_ATTEMPT"),
    trustedCodeSha: requiredEnv("REVIEW_TRUSTED_CODE_SHA").toLowerCase(),
  },
});

writeFileSync(
  requiredEnv("REVIEW_JSON"),
  `${JSON.stringify(provenance, null, 2)}\n`,
  "utf8",
);
writeOutput("decision", provenance.decision);
writeOutput("issue_number", provenance.issueNumber);
writeOutput("reviewed_head_sha", provenance.reviewedHeadSha);
