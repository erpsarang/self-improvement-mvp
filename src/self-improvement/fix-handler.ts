import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFixProvenance, nextFixAttempt } from "./fix.js";
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

function sourceRun(): ReviewSourceRun {
  return {
    id: positiveInteger("SOURCE_REVIEW_RUN_ID"),
    runAttempt: positiveInteger("SOURCE_REVIEW_RUN_ATTEMPT"),
    repository: required("GITHUB_REPOSITORY"),
    conclusion: "success",
    workflowPath: ".github/workflows/trusted-rail.yml",
  };
}

async function loadValidatedReview(): Promise<ReviewProvenance> {
  const review = JSON.parse(await readFile(required("REVIEW_JSON"), "utf8")) as unknown;
  const validated = validateReviewForOrchestration({
    review,
    reviewArtifactName: required("SOURCE_REVIEW_ARTIFACT_NAME"),
    sourceRun: sourceRun(),
  });
  if (validated.decision !== "LOCAL_FIX") {
    throw new Error("FIX는 LOCAL_FIX REVIEW에서만 시작할 수 있습니다");
  }
  const expectedAttempt = positiveInteger("FIX_ATTEMPT");
  if (expectedAttempt !== 1 && expectedAttempt !== 2) {
    throw new Error("FIX_ATTEMPT는 1 또는 2여야 합니다");
  }
  if (nextFixAttempt(validated) !== expectedAttempt) {
    throw new Error("FIX attempt가 trusted REVIEW provenance에서 계산한 값과 일치하지 않습니다");
  }
  return validated;
}

export async function prepareFix(): Promise<void> {
  await mkdir(required("FIX_RUNTIME_DIR"), { recursive: true });
  const review = await loadValidatedReview();
  const attempt = positiveInteger("FIX_ATTEMPT");
  const blockers = review.findings.filter(
    (finding) => finding.severity === "BLOCKER" && finding.scope === "LOCAL",
  );
  if (blockers.length === 0) throw new Error("수정할 LOCAL BLOCKER가 없습니다");

  const prompt = [
    "당신은 AI Development Framework의 untrusted FIX Worker입니다.",
    `이번 작업은 FIX #${attempt}이며 최대 허용 횟수는 2회입니다.`,
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
}

export async function finalizeFix(): Promise<void> {
  await mkdir(required("FIX_RUNTIME_DIR"), { recursive: true });
  const review = await loadValidatedReview();
  const patch = await readFile(runtimePath("candidate.patch"));
  const provenance = createFixProvenance({
    review,
    reviewArtifactName: required("SOURCE_REVIEW_ARTIFACT_NAME"),
    fixRun: {
      runId: positiveInteger("GITHUB_RUN_ID"),
      runAttempt: positiveInteger("GITHUB_RUN_ATTEMPT"),
    },
    candidatePatch: patch,
    aiResultId: required("AI_RESULT_ID"),
  });
  await writeFile(runtimePath("fix.json"), `${JSON.stringify(provenance, null, 2)}\n`);
}

if (process.argv[1]?.endsWith("fix-handler.ts")) {
  const mode = process.argv[2];
  if (mode === "prepare") await prepareFix();
  else if (mode === "finalize") await finalizeFix();
  else throw new Error("prepare 또는 finalize mode가 필요합니다");
}
