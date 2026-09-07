import { readFileSync, writeFileSync } from "node:fs";
import { sealImplementCandidate, type ImplementSourceRun } from "./seal.js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} 환경변수가 필요합니다`);
  return value;
}

function positiveIntegerEnv(name: string): number {
  const value = Number(requiredEnv(name));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name}은 양의 정수여야 합니다`);
  }
  return value;
}

const implementJsonPath = requiredEnv("IMPLEMENT_JSON");
const candidatePatchPath = requiredEnv("CANDIDATE_PATCH");
const sealedPatchPath = requiredEnv("SEALED_PATCH");
const sealJsonPath = requiredEnv("SEAL_JSON");

const implement: unknown = JSON.parse(readFileSync(implementJsonPath, "utf8"));
const candidatePatch = readFileSync(candidatePatchPath);

const sourceRun: ImplementSourceRun = {
  id: positiveIntegerEnv("SOURCE_RUN_ID"),
  runAttempt: positiveIntegerEnv("SOURCE_RUN_ATTEMPT"),
  headSha: requiredEnv("SOURCE_HEAD_SHA").toLowerCase(),
  repository: requiredEnv("SOURCE_REPOSITORY"),
  conclusion: requiredEnv("SOURCE_CONCLUSION"),
  workflowPath: requiredEnv("SOURCE_WORKFLOW_PATH"),
};

const sealed = sealImplementCandidate({
  implement,
  candidatePatch,
  sourceRun,
  sealRun: {
    runId: positiveIntegerEnv("SEAL_RUN_ID"),
    runAttempt: positiveIntegerEnv("SEAL_RUN_ATTEMPT"),
  },
  candidateArtifactName: requiredEnv("CANDIDATE_ARTIFACT_NAME"),
});

writeFileSync(sealedPatchPath, sealed.sealedPatch);
writeFileSync(sealJsonPath, `${JSON.stringify(sealed.provenance, null, 2)}\n`, "utf8");
