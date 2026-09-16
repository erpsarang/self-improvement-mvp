import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import type { LearnInputPack } from "./learn-input-pack.js";
import type { LearnReport } from "./learn-report.js";
import {
  createImprovementCandidatePack,
  improvementCandidatePackArtifactName,
  verifyImprovementCandidatePack,
} from "./improvement-candidate.js";

const SHA256 = /^[0-9a-f]{64}$/;
const SHA256_WITH_PREFIX = /^sha256:([0-9a-f]{64})$/;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} 환경변수가 필요합니다`);
  return value;
}

function positiveIntegerEnv(name: string): number {
  const value = Number(requiredEnv(name));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name}은 양의 정수여야 합니다`);
  return value;
}

function parseJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function normalizeSha256(name: string, value: string): string {
  if (SHA256.test(value)) return value;
  const prefixed = SHA256_WITH_PREFIX.exec(value);
  if (prefixed?.[1]) return prefixed[1];
  throw new Error(`${name} must be a lowercase SHA-256 digest`);
}

function writeOutput(name: string, value: string | number): void {
  appendFileSync(requiredEnv("GITHUB_OUTPUT"), `${name}=${String(value)}\n`, "utf8");
}

const report = parseJson<LearnReport>(requiredEnv("LEARN_REPORT_JSON"));
const pack = parseJson<LearnInputPack>(requiredEnv("LEARN_INPUT_PACK_JSON"));

const learnRunId = positiveIntegerEnv("LEARN_RUN_ID");
const learnRunAttempt = positiveIntegerEnv("LEARN_RUN_ATTEMPT");
const reportArtifactName = requiredEnv("LEARN_REPORT_ARTIFACT_NAME");
const reportArtifactId = positiveIntegerEnv("LEARN_REPORT_ARTIFACT_ID");
const reportArtifactDigest = normalizeSha256(
  "LEARN_REPORT_ARTIFACT_DIGEST",
  requiredEnv("LEARN_REPORT_ARTIFACT_DIGEST"),
);

const sourceRunId = positiveIntegerEnv("LEARN_SOURCE_RUN_ID");
const sourceRunAttempt = positiveIntegerEnv("LEARN_SOURCE_RUN_ATTEMPT");
const inputArtifactName = requiredEnv("LEARN_INPUT_ARTIFACT_NAME");
const inputArtifactId = positiveIntegerEnv("LEARN_INPUT_ARTIFACT_ID");
const inputArtifactDigest = normalizeSha256(
  "LEARN_INPUT_ARTIFACT_DIGEST",
  requiredEnv("LEARN_INPUT_ARTIFACT_DIGEST"),
);

if (
  report.source.inputPack.sourceRun.runId !== sourceRunId ||
  report.source.inputPack.sourceRun.runAttempt !== sourceRunAttempt
) {
  throw new Error("LEARN report embedded input-pack source run identity mismatch");
}
if (
  report.source.inputPack.artifact.name !== inputArtifactName ||
  report.source.inputPack.artifact.id !== inputArtifactId ||
  report.source.inputPack.artifact.digest !== inputArtifactDigest
) {
  throw new Error("LEARN report embedded input-pack artifact identity mismatch");
}
if (report.source.inputPack.packDigest !== pack.packDigest) {
  throw new Error("LEARN report embedded input-pack digest mismatch");
}

const candidatePack = createImprovementCandidatePack(report, pack, {
  learnRun: { runId: learnRunId, runAttempt: learnRunAttempt },
  reportArtifact: {
    name: reportArtifactName,
    id: reportArtifactId,
    digest: reportArtifactDigest,
  },
});
verifyImprovementCandidatePack(candidatePack, report, pack);

writeFileSync(
  requiredEnv("IMPROVEMENT_CANDIDATE_PACK_JSON"),
  `${JSON.stringify(candidatePack, null, 2)}\n`,
  "utf8",
);
writeOutput("issue_number", candidatePack.completedCycle.requirementIssueNumber);
writeOutput("human_merge_pr", candidatePack.completedCycle.humanMergePullRequestNumber);
writeOutput("candidate_count", candidatePack.candidates.length);
writeOutput("candidate_pack_digest", candidatePack.candidatePackDigest);
writeOutput(
  "candidate_artifact_name",
  improvementCandidatePackArtifactName(report, learnRunId, learnRunAttempt),
);
