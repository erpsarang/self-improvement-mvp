import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import {
  createVerifyProvenance,
  validatePublishedCandidateForVerify,
} from "./verify.js";

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

const command = process.argv[2];
if (command !== "prepare" && command !== "finalize") {
  throw new Error("verify-handler command는 prepare 또는 finalize여야 합니다");
}

const publishJsonPath = requiredEnv("PUBLISH_JSON");
const publishArtifactName = requiredEnv("PUBLISH_ARTIFACT_NAME");
const repository = requiredEnv("VERIFY_REPOSITORY");
const publish: unknown = JSON.parse(readFileSync(publishJsonPath, "utf8"));

const validatedPublish = validatePublishedCandidateForVerify({
  publish,
  publishArtifactName,
  repository,
});

if (command === "prepare") {
  writeOutput("issue_number", validatedPublish.issueNumber);
  writeOutput("published_branch", validatedPublish.publishedBranch);
  writeOutput("published_head_sha", validatedPublish.publishedHeadSha);
  writeOutput("publish_run_attempt", validatedPublish.publishWorkflow.runAttempt);
  process.exit(0);
}

const provenance = createVerifyProvenance({
  publish: validatedPublish,
  publishArtifactName,
  repository,
  verifyRun: {
    runId: positiveIntegerEnv("VERIFY_RUN_ID"),
    runAttempt: positiveIntegerEnv("VERIFY_RUN_ATTEMPT"),
    trustedCodeSha: requiredEnv("VERIFY_TRUSTED_CODE_SHA").toLowerCase(),
  },
  verifiedHeadSha: requiredEnv("VERIFIED_HEAD_SHA"),
});

writeFileSync(
  requiredEnv("VERIFY_JSON"),
  `${JSON.stringify(provenance, null, 2)}\n`,
  "utf8",
);
