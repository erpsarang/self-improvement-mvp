import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { verifyCompletedCycleRecord, type CompletedCycleRecord } from "./completed-cycle.js";
import { verifyLearnInputPack, type LearnInputPack } from "./learn-input-pack.js";
import {
  createLearnReport,
  createLearnReportOutputSchema,
  createLearnReportPrompt,
  learnReportArtifactName,
} from "./learn-report.js";

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

function writeOutput(name: string, value: string | number): void {
  appendFileSync(requiredEnv("GITHUB_OUTPUT"), `${name}=${String(value)}\n`, "utf8");
}

const command = process.argv[2];
if (command !== "prepare" && command !== "finalize") {
  throw new Error("learn-handler command는 prepare 또는 finalize여야 합니다");
}

const completedCycle = parseJson<CompletedCycleRecord>(requiredEnv("COMPLETED_CYCLE_JSON"));
const pack = parseJson<LearnInputPack>(requiredEnv("LEARN_INPUT_PACK_JSON"));
verifyCompletedCycleRecord(completedCycle);
verifyLearnInputPack(pack, completedCycle);

if (command === "prepare") {
  const runtimeDir = requiredEnv("LEARN_RUNTIME_DIR");
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(`${runtimeDir}/learn-input-pack.json`, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
  writeFileSync(`${runtimeDir}/learn-prompt.md`, `${createLearnReportPrompt(pack)}\n`, "utf8");
  writeFileSync(
    `${runtimeDir}/learn-output.schema.json`,
    `${JSON.stringify(createLearnReportOutputSchema(pack), null, 2)}\n`,
    "utf8",
  );
  writeOutput("issue_number", pack.completedCycle.requirementIssueNumber);
  writeOutput("human_merge_pr", pack.completedCycle.humanMergePullRequestNumber);
  writeOutput("pack_digest", pack.packDigest);
  process.exit(0);
}

const runId = positiveIntegerEnv("LEARN_RUN_ID");
const runAttempt = positiveIntegerEnv("LEARN_RUN_ATTEMPT");
const rawLearnerOutput = JSON.parse(readFileSync(requiredEnv("LEARNER_OUTPUT_JSON"), "utf8")) as unknown;
const report = createLearnReport(pack, rawLearnerOutput, {
  sourceRun: {
    runId: positiveIntegerEnv("LEARN_SOURCE_RUN_ID"),
    runAttempt: positiveIntegerEnv("LEARN_SOURCE_RUN_ATTEMPT"),
  },
  inputPackArtifact: {
    name: requiredEnv("LEARN_INPUT_ARTIFACT_NAME"),
    id: positiveIntegerEnv("LEARN_INPUT_ARTIFACT_ID"),
    digest: requiredEnv("LEARN_INPUT_ARTIFACT_DIGEST"),
  },
  learner: {
    provider: requiredEnv("LEARNER_PROVIDER"),
    action: requiredEnv("LEARNER_ACTION"),
    model: requiredEnv("LEARNER_MODEL"),
    reasoningEffort: requiredEnv("LEARNER_REASONING_EFFORT"),
  },
});
const outputPath = requiredEnv("LEARN_REPORT_JSON");
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
writeOutput("issue_number", pack.completedCycle.requirementIssueNumber);
writeOutput("human_merge_pr", pack.completedCycle.humanMergePullRequestNumber);
writeOutput("report_digest", report.reportDigest);
writeOutput("report_artifact_name", learnReportArtifactName(pack, runId, runAttempt));
