import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  createProductEvaluationOutputSchema,
  createProductEvaluationPrompt,
  createProductEvaluationReport,
  createProductSnapshot,
  decideImprovementIssue,
  decideProductEvaluationNeed,
  productEvaluationReportArtifactName,
  productSnapshotArtifactName,
  verifyProductEvaluationReport,
  verifyProductSnapshot,
  type ExistingIssue,
  type ProductCycleIdentity,
  type ProductEvaluationReport,
  type ProductSnapshot,
  type RejectedCandidate,
} from "./product-evaluation.js";

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

function normalizeExistingIssues(value: unknown): ExistingIssue[] {
  if (!Array.isArray(value)) throw new Error("existing issues must be an array");
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("existing issue must be an object");
    }
    const issue = entry as Record<string, unknown>;
    if (typeof issue.number !== "number" || !Number.isSafeInteger(issue.number) || issue.number < 1) {
      throw new Error("existing issue number must be a positive safe integer");
    }
    if (typeof issue.title !== "string") throw new Error("existing issue title must be a string");
    if (issue.state !== "open" && issue.state !== "closed") {
      throw new Error("existing issue state must be open or closed");
    }
    return { number: issue.number, title: issue.title, state: issue.state };
  });
}

const command = process.argv[2];
if (command !== "prepare" && command !== "finalize" && command !== "decide") {
  throw new Error("product-evaluation-handler command는 prepare, finalize 또는 decide여야 합니다");
}

if (command === "prepare") {
  const identity = parseJson<ProductCycleIdentity>(requiredEnv("PRODUCT_CYCLE_FACTS_JSON"));
  const rejectedPath = process.env.REJECTED_CANDIDATES_JSON;
  const rejectedCandidates = rejectedPath && existsSync(rejectedPath)
    ? parseJson<readonly RejectedCandidate[]>(rejectedPath)
    : [];
  const snapshot = createProductSnapshot(identity, requiredEnv("PRODUCT_TARGET_ROOT"), rejectedCandidates);
  verifyProductSnapshot(snapshot);

  const runtimeDir = requiredEnv("PRODUCT_EVALUATION_RUNTIME_DIR");
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(`${runtimeDir}/product-snapshot.json`, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  writeFileSync(`${runtimeDir}/product-evaluation-prompt.md`, `${createProductEvaluationPrompt(snapshot)}\n`, "utf8");
  writeFileSync(
    `${runtimeDir}/product-evaluation-output.schema.json`,
    `${JSON.stringify(createProductEvaluationOutputSchema(snapshot), null, 2)}\n`,
    "utf8",
  );

  writeOutput("issue_number", snapshot.deployedCycle.requirementIssueNumber);
  writeOutput("human_merge_pr", snapshot.deployedCycle.humanMergePullRequestNumber);
  writeOutput("snapshot_digest", snapshot.snapshotDigest);
  writeOutput("snapshot_artifact_name", productSnapshotArtifactName(snapshot));
  writeOutput("file_count", snapshot.fileCount);
  writeOutput("rejected_candidate_count", snapshot.rejectedCandidates.length);

  // 제품 파일을 바꾸지 않은 cycle은 AI 평가를 생략한다. 사유는 사람이 볼 수 있게 남긴다.
  const changedPathsPath = process.env.PRODUCT_CHANGED_PATHS_JSON;
  const need = decideProductEvaluationNeed(
    changedPathsPath && existsSync(changedPathsPath) ? parseJson<unknown>(changedPathsPath) : null,
  );
  writeOutput("should_evaluate", need.needed ? "true" : "false");
  console.log(`Product Evaluation: ${need.reason}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Product Evaluation\n\n${need.reason}\n`, "utf8");
  }
  process.exit(0);
}

const snapshot = parseJson<ProductSnapshot>(requiredEnv("PRODUCT_SNAPSHOT_JSON"));
verifyProductSnapshot(snapshot);

if (command === "finalize") {
  const runId = positiveIntegerEnv("PRODUCT_EVALUATION_RUN_ID");
  const runAttempt = positiveIntegerEnv("PRODUCT_EVALUATION_RUN_ATTEMPT");
  const rawEvaluatorOutput = JSON.parse(readFileSync(requiredEnv("EVALUATOR_OUTPUT_JSON"), "utf8")) as unknown;

  const report = createProductEvaluationReport(snapshot, rawEvaluatorOutput, {
    sourceRun: {
      runId: positiveIntegerEnv("SNAPSHOT_SOURCE_RUN_ID"),
      runAttempt: positiveIntegerEnv("SNAPSHOT_SOURCE_RUN_ATTEMPT"),
    },
    snapshotArtifact: {
      name: requiredEnv("SNAPSHOT_ARTIFACT_NAME"),
      id: positiveIntegerEnv("SNAPSHOT_ARTIFACT_ID"),
      digest: requiredEnv("SNAPSHOT_ARTIFACT_DIGEST"),
    },
    evaluator: {
      provider: requiredEnv("EVALUATOR_PROVIDER"),
      action: requiredEnv("EVALUATOR_ACTION"),
      model: requiredEnv("EVALUATOR_MODEL"),
      reasoningEffort: requiredEnv("EVALUATOR_REASONING_EFFORT"),
    },
  });
  verifyProductEvaluationReport(report, snapshot);

  writeFileSync(
    requiredEnv("PRODUCT_EVALUATION_REPORT_JSON"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  writeOutput("issue_number", report.deployedCycle.requirementIssueNumber);
  writeOutput("human_merge_pr", report.deployedCycle.humanMergePullRequestNumber);
  writeOutput("report_digest", report.reportDigest);
  writeOutput("report_artifact_name", productEvaluationReportArtifactName(snapshot, runId, runAttempt));
  writeOutput("candidate_count", report.candidate === null ? 0 : 1);
  process.exit(0);
}

const report = parseJson<ProductEvaluationReport>(requiredEnv("PRODUCT_EVALUATION_REPORT_JSON"));
verifyProductEvaluationReport(report, snapshot);

const existingIssues = normalizeExistingIssues(parseJson<unknown>(requiredEnv("EXISTING_ISSUES_JSON")));
const decision = decideImprovementIssue(report, existingIssues);

writeFileSync(
  requiredEnv("IMPROVEMENT_ISSUE_DECISION_JSON"),
  `${JSON.stringify(decision, null, 2)}\n`,
  "utf8",
);
writeOutput("action", decision.action);
if (decision.action === "skip") writeOutput("reason", decision.reason);
