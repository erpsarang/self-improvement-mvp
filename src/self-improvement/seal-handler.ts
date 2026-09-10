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

// Trusted Rail의 기존 generic envelope 이름 `implement.json`을 유지한다.
// 내부 provenance type이 IMPLEMENT인지 FIX인지 trusted code가 결정한다.
const provenancePath = optionalEnv("CANDIDATE_PROVENANCE_JSON") ?? requiredEnv("IMPLEMENT_JSON");
const candidatePatchPath = requiredEnv("CANDIDATE_PATCH");
const sealedPatchPath = requiredEnv("SEALED_PATCH");
const sealJsonPath = requiredEnv("SEAL_JSON");
const candidate = JSON.parse(readFileSync(provenancePath, "utf8")) as { readonly type?: unknown };
const candidatePatch = readFileSync(candidatePatchPath);

const candidateKind = optionalEnv("CANDIDATE_KIND") ?? candidate.type;
if (candidateKind !== "IMPLEMENT" && candidateKind !== "FIX") {
  throw new Error("candidate provenance type은 IMPLEMENT 또는 FIX여야 합니다");
}
if (candidate.type !== candidateKind) {
  throw new Error("CANDIDATE_KIND와 candidate provenance type이 일치하지 않습니다");
}

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
