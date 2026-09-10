import { appendFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FIX_REQUEST_WORKFLOW_PATH,
  createFixProvenance,
  createFixRequestProvenance,
  fixRequestArtifactName,
  nextFixAttempt,
  validateFixRequestAgainstReview,
  validateFixRequestProvenance,
  type FixRequestProvenance,
} from "./fix.js";
import {
  validateReviewForOrchestration,
  type ReviewSourceRun,
} from "./orchestrator.js";
import type { ReviewProvenance } from "./review.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name}이 필요합니다`);
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : undefined;
}

function positiveInteger(name: string): number {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name}은 양의 정수여야 합니다`);
  }
  return value;
}

function runtimePath(name: string): string {
  return join(required("FIX_RUNTIME_DIR"), name);
}

function writeOutput(name: string, value: string | number): void {
  appendFileSync(required("GITHUB_OUTPUT"), `${name}=${String(value)}\n`, "utf8");
}

function reviewSourceRunFromEnv(): ReviewSourceRun {
  return {
    id: positiveInteger("SOURCE_REVIEW_RUN_ID"),
    runAttempt: positiveInteger("SOURCE_REVIEW_RUN_ATTEMPT"),
    repository: required("GITHUB_REPOSITORY"),
    conclusion: "success",
    workflowPath: ".github/workflows/trusted-rail.yml",
  };
}

async function loadReview(
  reviewArtifactName: string,
  sourceRun: ReviewSourceRun,
): Promise<ReviewProvenance> {
  const review = JSON.parse(await readFile(required("REVIEW_JSON"), "utf8")) as unknown;
  return validateReviewForOrchestration({
    review,
    reviewArtifactName,
    sourceRun,
  });
}

function ensureExpectedAttempt(review: ReviewProvenance, expectedAttempt: number): 1 | 2 {
  if (expectedAttempt !== 1 && expectedAttempt !== 2) {
    throw new Error("FIX_ATTEMPT는 1 또는 2여야 합니다");
  }
  if (nextFixAttempt(review) !== expectedAttempt) {
    throw new Error("FIX attempt가 trusted REVIEW provenance에서 계산한 값과 일치하지 않습니다");
  }
  return expectedAttempt;
}

async function validateWorkerRequest(): Promise<{
  readonly request: FixRequestProvenance;
  readonly review: ReviewProvenance;
}> {
  const request = validateFixRequestProvenance(
    JSON.parse(await readFile(required("FIX_REQUEST_JSON"), "utf8")) as unknown,
  );
  const sourceRequestRunId = positiveInteger("SOURCE_FIX_REQUEST_RUN_ID");
  const sourceRequestRunAttempt = positiveInteger("SOURCE_FIX_REQUEST_RUN_ATTEMPT");
  const sourceRequestSha = required("SOURCE_FIX_REQUEST_CONTROL_PLANE_SHA").toLowerCase();
  const sourceRequestPath = required("SOURCE_FIX_REQUEST_WORKFLOW_PATH");
  const sourceRequestArtifact = required("SOURCE_FIX_REQUEST_ARTIFACT_NAME");

  if (
    sourceRequestPath !== FIX_REQUEST_WORKFLOW_PATH ||
    request.requestWorkflow.runId !== sourceRequestRunId ||
    request.requestWorkflow.runAttempt !== sourceRequestRunAttempt ||
    request.requestWorkflow.trustedCodeSha !== sourceRequestSha ||
    fixRequestArtifactName(request) !== sourceRequestArtifact
  ) {
    throw new Error("FIX request source workflow identity가 provenance와 일치하지 않습니다");
  }

  const review = await loadReview(request.sourceReview.artifactName, {
    id: request.sourceReview.runId,
    runAttempt: request.sourceReview.runAttempt,
    repository: request.repository,
    conclusion: "success",
    workflowPath: ".github/workflows/trusted-rail.yml",
  });
  validateFixRequestAgainstReview(request, review, request.sourceReview.artifactName);
  return Object.freeze({ request, review });
}

export async function createFixRequest(): Promise<void> {
  await mkdir(required("FIX_RUNTIME_DIR"), { recursive: true });
  const reviewArtifactName = required("SOURCE_REVIEW_ARTIFACT_NAME");
  const review = await loadReview(reviewArtifactName, reviewSourceRunFromEnv());
  const expectedAttempt = ensureExpectedAttempt(review, positiveInteger("FIX_ATTEMPT"));
  if (review.decision !== "LOCAL_FIX") {
    throw new Error("FIX request는 LOCAL_FIX REVIEW에서만 만들 수 있습니다");
  }

  const request = createFixRequestProvenance({
    review,
    reviewArtifactName,
    requestRun: {
      runId: positiveInteger("GITHUB_RUN_ID"),
      runAttempt: positiveInteger("GITHUB_RUN_ATTEMPT"),
      trustedCodeSha: required("GITHUB_SHA").toLowerCase(),
    },
  });
  if (request.fixAttempt !== expectedAttempt) {
    throw new Error("FIX request attempt가 expected attempt와 일치하지 않습니다");
  }
  await writeFile(runtimePath("fix-request.json"), `${JSON.stringify(request, null, 2)}\n`);
  writeOutput("issue_number", review.issueNumber);
  writeOutput("reviewed_branch", review.reviewedBranch);
  writeOutput("reviewed_head_sha", review.reviewedHeadSha);
  writeOutput("fix_attempt", request.fixAttempt);
  writeOutput("request_artifact_name", fixRequestArtifactName(request));
}

export async function prepareFix(): Promise<void> {
  await mkdir(required("FIX_RUNTIME_DIR"), { recursive: true });
  const { request, review } = await validateWorkerRequest();
  const blockers = review.findings.filter(
    (finding) => finding.severity === "BLOCKER" && finding.scope === "LOCAL",
  );
  if (blockers.length === 0) throw new Error("수정할 LOCAL BLOCKER가 없습니다");

  const prompt = [
    "당신은 AI Development Framework의 untrusted FIX Worker입니다.",
    `이번 작업은 FIX #${request.fixAttempt}이며 최대 허용 횟수는 2회입니다.`,
    `아래 exact reviewed SHA ${review.reviewedHeadSha}에 존재하는 코드만 수정하세요.`,
    "승인된 요구사항의 범위를 확대하거나 구조를 재설계하지 마세요.",
    "아래 LOCAL BLOCKER만 해결하세요. FOLLOW_UP은 이번 FIX 범위가 아닙니다.",
    "GitHub에 commit, push, branch 생성, PR 생성, merge를 시도하지 마세요.",
    "SEAL, PUBLISH, VERIFY, REVIEW, MERGE_READY를 수행하지 마세요.",
    "작업 디렉터리의 파일만 수정하고 필요한 테스트는 실행하세요.",
    "",
    `Issue #${review.issueNumber}: ${review.requirements.title}`,
    "",
    "LOCAL BLOCKER:",
    JSON.stringify(blockers, null, 2),
  ].join("\n");

  await writeFile("fix-prompt.txt", `${prompt}\n`);
  writeOutput("issue_number", review.issueNumber);
  writeOutput("reviewed_branch", review.reviewedBranch);
  writeOutput("reviewed_head_sha", review.reviewedHeadSha);
  writeOutput("fix_attempt", request.fixAttempt);
}

export async function finalizeFix(): Promise<void> {
  await mkdir(required("FIX_RUNTIME_DIR"), { recursive: true });
  const { request, review } = await validateWorkerRequest();
  const patch = await readFile(runtimePath("candidate.patch"));
  const provenance = createFixProvenance({
    review,
    reviewArtifactName: request.sourceReview.artifactName,
    request,
    fixRun: {
      runId: positiveInteger("GITHUB_RUN_ID"),
      runAttempt: positiveInteger("GITHUB_RUN_ATTEMPT"),
    },
    candidatePatch: patch,
    aiResultId: required("AI_RESULT_ID"),
  });
  const outputPath = optional("FIX_PROVENANCE_JSON") ?? runtimePath("implement.json");
  await writeFile(outputPath, `${JSON.stringify(provenance, null, 2)}\n`);
}

if (process.argv[1]?.endsWith("fix-handler.ts")) {
  const mode = process.argv[2];
  if (mode === "request") await createFixRequest();
  else if (mode === "prepare") await prepareFix();
  else if (mode === "finalize") await finalizeFix();
  else throw new Error("request, prepare 또는 finalize mode가 필요합니다");
}
