import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createTrustedLearnSourceArtifacts, type TrustedLearnSourceFacts } from "./learn-source.js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} 환경변수가 필요합니다`);
  return value;
}

function parseJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeOutput(name: string, value: string | number): void {
  appendFileSync(requiredEnv("GITHUB_OUTPUT"), `${name}=${String(value)}\n`, "utf8");
}

const facts = parseJson(requiredEnv("LEARN_SOURCE_FACTS_JSON")) as TrustedLearnSourceFacts;
const orchestration = parseJson(requiredEnv("ORCHESTRATION_JSON"));
const outputDir = requiredEnv("LEARN_SOURCE_OUTPUT_DIR");
const result = createTrustedLearnSourceArtifacts(facts, orchestration);

const completedDir = `${outputDir}/completed-cycle`;
const inputDir = `${outputDir}/learn-input`;
mkdirSync(completedDir, { recursive: true });
mkdirSync(inputDir, { recursive: true });

writeFileSync(
  `${completedDir}/completed-cycle.json`,
  `${JSON.stringify(result.completedCycle, null, 2)}\n`,
  "utf8",
);
writeFileSync(
  `${inputDir}/learn-input-pack.json`,
  `${JSON.stringify(result.learnInputPack, null, 2)}\n`,
  "utf8",
);

writeOutput("issue_number", result.completedCycle.requirement.issueNumber);
writeOutput("human_merge_pr", result.completedCycle.humanMerge.pullRequestNumber);
writeOutput("completed_cycle_artifact_name", result.completedCycleArtifactName);
writeOutput("learn_input_artifact_name", result.learnInputArtifactName);
writeOutput("record_digest", result.completedCycle.recordDigest);
writeOutput("pack_digest", result.learnInputPack.packDigest);
