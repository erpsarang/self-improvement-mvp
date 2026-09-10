import { readFileSync, writeFileSync } from "node:fs";
import {
  sealFixCandidate,
  sealImplementCandidate,
  type CandidateSourceRun,
} from "./seal.js";

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

const candidateKind = requiredEnv("CANDIDATE_KIND");
if (candidateKind !== "IMPLEMENT" && candidateKind !== "FIX") {
  throw new Error("CANDIDATE_KIND는 IMPLEMENT 또는 FIX여야 합니다");
}

const provenancePath = requiredEnv("CANDIDATE_PROVENANCE_JSON");
const candidatePatchPath = requiredEnv("CANDIDATE_PATCH");
const sealedPatchPath = requiredEnv("SEALED_PATCH");
const sealJsonPath = requiredEnv("SEAL_JSON");
const candidate: unknown = JSON.parse(readFileSync(provenancePath, "utf8"));
const candidatePatch = readFileSync(candidatePatchPath);

const sourceRun: CandidateSourceRun = {
  id: positiveIntegerEnv("SOURCE_RUN_ID"),
  runAttempt: positiveIntegerEnv("SOURCE_RUN_ATTEMPT"),
  controlPlaneSha: requiredEnv("SOURCE_CONTROL_PLANE_SHA").toLowerCase(),
  repository: requiredEnv("SOURCE_REPOSITORY"),
  conclusion: requiredEnv("SOURCE_CONCLUSION"),
  workflowPath: requiredEnv("SOURCE_WORKFLOW_PATH"),
};

const common = {
  candidatePatch,
  sourceRun,
  sealRun: {
    runId: positiveIntegerEnv("SEAL_RUN_ID"),
    runAttempt: positiveIntegerEnv("SEAL_RUN_ATTEMPT"),
    trustedCodeSha: requiredEnv("SEAL_TRUSTED_CODE_SHA").toLowerCase(),
  },
  candidateArtifactName: requiredEnv("CANDIDATE_ARTIFACT_NAME"),
};

const sealed = candidateKind === "IMPLEMENT"
  ? sealImplementCandidate({ ...common, implement: candidate })
  : sealFixCandidate({ ...common, fix: candidate });

writeFileSync(sealedPatchPath, sealed.sealedPatch);
writeFileSync(sealJsonPath, `${JSON.stringify(sealed.provenance, null, 2)}\n`, "utf8");
