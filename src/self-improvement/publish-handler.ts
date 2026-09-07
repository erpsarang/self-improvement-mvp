import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import {
  createPublishProvenance,
  publishBranchName,
  validateSealedCandidateForPublish,
} from "./publish.js";

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
  throw new Error("publish-handler command는 prepare 또는 finalize여야 합니다");
}

const sealJsonPath = requiredEnv("SEAL_JSON");
const sealedPatchPath = requiredEnv("SEALED_PATCH");
const sealedArtifactName = requiredEnv("SEALED_ARTIFACT_NAME");
const repository = requiredEnv("PUBLISH_REPOSITORY");
const seal: unknown = JSON.parse(readFileSync(sealJsonPath, "utf8"));
const sealedPatch = readFileSync(sealedPatchPath);

const validatedSeal = validateSealedCandidateForPublish({
  seal,
  sealedPatch,
  sealedArtifactName,
  repository,
});

if (command === "prepare") {
  writeOutput("base_sha", validatedSeal.baseSha);
  writeOutput("issue_number", validatedSeal.issueNumber);
  writeOutput("publish_branch", publishBranchName(validatedSeal.issueNumber));
  writeOutput("sealed_patch_digest", validatedSeal.sealedPatchDigest);
  process.exit(0);
}

const provenance = createPublishProvenance({
  seal: validatedSeal,
  sealedPatch,
  sealedArtifactName,
  repository,
  publishRun: {
    runId: positiveIntegerEnv("PUBLISH_RUN_ID"),
    runAttempt: positiveIntegerEnv("PUBLISH_RUN_ATTEMPT"),
    trustedCodeSha: requiredEnv("PUBLISH_TRUSTED_CODE_SHA").toLowerCase(),
  },
  publishedHeadSha: requiredEnv("PUBLISHED_HEAD_SHA"),
});

writeFileSync(
  requiredEnv("PUBLISH_JSON"),
  `${JSON.stringify(provenance, null, 2)}\n`,
  "utf8",
);
