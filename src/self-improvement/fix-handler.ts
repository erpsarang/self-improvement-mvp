import { appendFileSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  FIX_REQUEST_WORKFLOW_PATH,
  createFixProvenance,
  createFixRequestProvenance,
  createFixSubscriptionRequest,
  fixRequestArtifactName,
  materializeFixSubscriptionProposal,
  nextFixAttempt,
  validateFixRequestAgainstReview,
  validateFixRequestProvenance,
  type FixRequestProvenance,
  type FixTargetReader,
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
  // FIX는 이전 Trusted Rail run이 남긴 REVIEW를 읽는다. 이 변경 전 legacy PUBLISH branch도 historical로 허용한다.
  return validateReviewForOrchestration({
    review,
    reviewArtifactName,
    sourceRun,
    publishBranchPolicy: "historical",
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

  writeOutput("issue_number", review.issueNumber);
  writeOutput("reviewed_branch", review.reviewedBranch);
  writeOutput("reviewed_head_sha", review.reviewedHeadSha);
  writeOutput("fix_attempt", request.fixAttempt);
}

/**
 * exact reviewed SHA checkout 안의 일반 파일만 읽는다. 경로의 어느 구성 요소든 symlink면 checkout 밖을 가리킬 수 있으므로 거부한다.
 * 없는 파일은 null(create 대상)이다.
 */
function targetPath(root: string, path: string): string | null {
  const parts = path.split("/");
  if (path.startsWith("/") || parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`FIX target path가 올바르지 않습니다: ${path}`);
  }
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`FIX target path에 symlink가 있습니다: ${path}`);
    if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) {
      throw new Error(`FIX target path가 일반 파일이 아닙니다: ${path}`);
    }
  }
  return current;
}

export function fixTargetReader(root: string): FixTargetReader {
  return (path) => {
    const file = targetPath(root, path);
    return file === null ? null : readFileSync(file);
  };
}

/** Private subscription executor에 보낼 FIX_REQUEST 입력(identity.json, prompt.md, schema.json)을 만든다. */
export async function createFixSubscriptionInput(): Promise<void> {
  const { request, review } = await validateWorkerRequest();
  const target = required("FIX_TARGET_DIRECTORY");
  const directory = required("FIX_SUBSCRIPTION_REQUEST_DIR");
  const { identity, prompt, schema } = createFixSubscriptionRequest({
    review,
    request,
    worker: { runId: positiveInteger("GITHUB_RUN_ID"), runAttempt: positiveInteger("GITHUB_RUN_ATTEMPT") },
    read: fixTargetReader(target),
  });
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "identity.json"), `${JSON.stringify(identity, null, 2)}\n`);
  await writeFile(join(directory, "prompt.md"), `${prompt}\n`);
  await writeFile(join(directory, "schema.json"), `${JSON.stringify(schema, null, 2)}\n`);
  if (readdirSync(directory).sort().join(",") !== "identity.json,prompt.md,schema.json") {
    throw new Error("FIX request directory는 identity.json, prompt.md, schema.json만 가져야 합니다");
  }
  writeOutput("request_artifact_name", `fix-request-subscription-issue-${identity.issueNumber}-worker-${identity.worker.runId}-attempt-${identity.worker.runAttempt}`);
}

/** subscription 결과(raw proposal)를 exact reviewed SHA worktree에 적용한다. 검증이 모두 끝난 뒤에만 쓴다. */
export async function applyFixSubscriptionProposal(): Promise<void> {
  const { review } = await validateWorkerRequest();
  const worktree = required("FIX_WORKTREE_DIRECTORY");
  const proposal = JSON.parse(await readFile(required("FIX_RAW_PROPOSAL_JSON"), "utf8")) as unknown;
  const files = materializeFixSubscriptionProposal(review, proposal, fixTargetReader(worktree));
  for (const [path, content] of files) {
    const file = join(worktree, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
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
  else if (mode === "subscription-request") await createFixSubscriptionInput();
  else if (mode === "apply") await applyFixSubscriptionProposal();
  else if (mode === "finalize") await finalizeFix();
  else throw new Error("request, prepare, subscription-request, apply 또는 finalize mode가 필요합니다");
}
