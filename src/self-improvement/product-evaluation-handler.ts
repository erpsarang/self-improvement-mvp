import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import {
  createProductDiscoverySubscriptionIdentity,
  createProductEvaluationOutputSchema,
  createProductEvaluationPrompt,
  createProductEvaluationReport,
  createProductSnapshot,
  decideImprovementIssue,
  productEvaluationReportArtifactName,
  renderDiscoveryResultComment,
  verifyProductEvaluationReport,
  verifyProductSnapshot,
  type CompletedRequirement,
  type ExistingIssue,
  type ProductDiscoveryTarget,
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
  const target = parseJson<ProductDiscoveryTarget>(requiredEnv("PRODUCT_DISCOVERY_TARGET_JSON"));
  const snapshot = createProductSnapshot(target, requiredEnv("PRODUCT_TARGET_ROOT"), {
    completedRequirements: parseJson<readonly CompletedRequirement[]>(requiredEnv("COMPLETED_REQUIREMENTS_JSON")),
    rejectedCandidates: parseJson<readonly RejectedCandidate[]>(requiredEnv("REJECTED_CANDIDATES_JSON")),
    recentChangedPaths: parseJson<readonly unknown[]>(requiredEnv("RECENT_CHANGED_PATHS_JSON")),
  });
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

  // Private subscription executor에 보낼 PRODUCT_EVALUATION_REQUEST 입력. prompt에 snapshot 전체가 들어 있다.
  // 위 snapshot artifact는 finalize의 exact binding용으로 그대로 둔다.
  const subscriptionDir = requiredEnv("PRODUCT_EVALUATION_SUBSCRIPTION_DIR");
  mkdirSync(subscriptionDir, { recursive: true });
  const subscriptionIdentity = createProductDiscoverySubscriptionIdentity(snapshot, {
    runId: positiveIntegerEnv("GITHUB_RUN_ID"),
    runAttempt: positiveIntegerEnv("GITHUB_RUN_ATTEMPT"),
  });
  writeFileSync(`${subscriptionDir}/identity.json`, `${JSON.stringify(subscriptionIdentity, null, 2)}\n`, "utf8");
  writeFileSync(`${subscriptionDir}/prompt.md`, `${createProductEvaluationPrompt(snapshot)}\n`, "utf8");
  writeFileSync(`${subscriptionDir}/schema.json`, `${JSON.stringify(createProductEvaluationOutputSchema(snapshot), null, 2)}\n`, "utf8");
  if (readdirSync(subscriptionDir).sort().join(",") !== "identity.json,prompt.md,schema.json") {
    throw new Error("PRODUCT_EVALUATION request directory는 identity.json, prompt.md, schema.json만 가져야 합니다");
  }

  writeOutput("issue_number", snapshot.discovery.issueNumber);
  writeOutput("snapshot_digest", snapshot.snapshotDigest);
  writeOutput("file_count", snapshot.fileCount);

  // 전체 한도를 넘어 빠진 파일은 사람이 볼 수 있게 남긴다.
  const summary = [
    "### Product Discovery snapshot",
    "",
    `- 배포 SHA: \`${snapshot.discovery.deployedSha}\``,
    `- 담은 제품 파일 ${snapshot.fileCount}개 / ${snapshot.totalSnapshotBytes}B (전체 한도 ${snapshot.budget.maxTotalBytes}B)`,
    `- 한도로 빠진 파일 ${snapshot.omittedPaths.length}개${snapshot.omittedPaths.length > 0 ? `: ${snapshot.omittedPaths.join(", ")}` : ""}`,
    `- 완료한 요구 ${snapshot.history.completedRequirements.length}건, 기각된 후보 ${snapshot.history.rejectedCandidates.length}건, 최근 변경 경로 ${snapshot.history.recentChangedPaths.length}개`,
  ].join("\n");
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`, "utf8");
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
  writeOutput("issue_number", report.discovery.issueNumber);
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
writeFileSync(
  requiredEnv("DISCOVERY_RESULT_COMMENT_MD"),
  `${renderDiscoveryResultComment(report, decision)}\n`,
  "utf8",
);
writeOutput("action", decision.action);
if (decision.action === "skip") writeOutput("reason", decision.reason);
