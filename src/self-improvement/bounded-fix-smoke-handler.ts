import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BOUNDED_FIX_OUTPUT_SCHEMA,
  createBoundedFixPrompt,
  createBoundedFixRequest,
  createFixedCandidateChangeSet,
} from "./bounded-fix.js";
import { createImplementContextPack } from "./context-pack.js";
import {
  runDeterministicValidation,
  verifyDeterministicValidationResult,
} from "./deterministic-ci.js";
import { createImplementContract, type ApprovedPlanIdentity } from "./implement-contract.js";
import {
  createCandidateChangeSet,
  verifyCandidateChangeSet,
  type WorkerProposal,
} from "./single-pass-worker.js";

const TARGET_PATH = "test/fixtures/bounded-fix-smoke-target.ts";
const EXPECTED_CONTENT = "export const boundedFixSmokeValue: number = 2;\n";
const BROKEN_CONTENT = "export const boundedFixSmokeValue: number = \"2\";\n";

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name: string): number {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function readJson(name: string): any {
  return JSON.parse(readFileSync(join(required("SMOKE_OUTPUT"), name), "utf8"));
}

function writeJson(name: string, value: unknown): void {
  writeFileSync(join(required("SMOKE_OUTPUT"), name), JSON.stringify(value, null, 2));
}

function prepare(): void {
  const repository = required("SMOKE_REPOSITORY");
  const sha = required("SMOKE_SHA");
  const runId = positiveInteger("SMOKE_RUN_ID");
  const runAttempt = positiveInteger("SMOKE_RUN_ATTEMPT");
  const actorId = positiveInteger("SMOKE_ACTOR_ID");
  const targetRoot = required("SMOKE_TARGET_ROOT");
  const output = required("SMOKE_OUTPUT");
  mkdirSync(output, { recursive: true });

  const requirement = `${TARGET_PATH} 파일을 새로 만들고 정확히 ${EXPECTED_CONTENT.trim()} 내용으로 저장한다.`;
  const identity: ApprovedPlanIdentity = {
    requirement: { issueNumber: 80, digest: digest(requirement) },
    repository,
    targetSha: sha,
    plan: {
      runId,
      runAttempt,
      artifact: {
        name: `bounded-fix-smoke-plan-${runId}-attempt-${runAttempt}`,
        id: runId * 10 + 1,
        digest: digest(`bounded-fix-smoke-plan:${repository}:${sha}:${runId}:${runAttempt}`),
      },
      provenanceArtifact: {
        name: `bounded-fix-smoke-plan-${runId}-attempt-${runAttempt}-provenance`,
        id: runId * 10 + 2,
        digest: digest(`bounded-fix-smoke-provenance:${repository}:${sha}:${runId}:${runAttempt}`),
      },
    },
    approval: { commentId: runId * 10 + 3, approverUserId: actorId },
  };

  const contract = createImplementContract(identity, {
    allowedPaths: [TARGET_PATH],
    requiredChanges: [requirement],
    forbiddenChanges: [
      `${TARGET_PATH} 이외의 파일 변경 금지`,
      "repository 탐색 및 테스트 반복 금지",
      "commit, push, PR 생성 금지",
    ],
    validationCommands: ["npm test"],
    maxFilesChanged: 1,
    maxContextBytes: 4096,
    maxPatchBytes: 4096,
  });
  const contextPack = createImplementContextPack(contract, targetRoot, sha);
  const brokenCandidate = createCandidateChangeSet(contract, contextPack, {
    summary: "smoke 검증을 위해 의도적으로 타입 오류가 있는 candidate를 생성",
    changes: [{
      path: TARGET_PATH,
      operation: "create",
      baseContentDigest: null,
      content: BROKEN_CONTENT,
    }],
  });

  verifyCandidateChangeSet(brokenCandidate, contract, contextPack);
  writeJson("contract.json", contract);
  writeJson("context.json", contextPack);
  writeJson("broken-candidate.json", brokenCandidate);
  writeJson("smoke-metadata.json", {
    smokeOnly: true,
    repository,
    sha,
    runId,
    runAttempt,
    targetPath: TARGET_PATH,
    expectedContent: EXPECTED_CONTENT,
  });
}

function createFailureEvidence(): void {
  const contract = readJson("contract.json");
  const contextPack = readJson("context.json");
  const brokenCandidate = readJson("broken-candidate.json");
  const targetRoot = required("SMOKE_TARGET_ROOT");
  const sha = required("SMOKE_SHA");

  const validation = runDeterministicValidation(
    contract,
    contextPack,
    brokenCandidate,
    targetRoot,
    sha,
    { commandTimeoutMs: 60_000 },
  );
  verifyDeterministicValidationResult(validation);
  if (validation.status !== "FAIL") throw new Error("bounded FIX smoke expected the initial deterministic validation to FAIL");

  const request = createBoundedFixRequest(contract, contextPack, brokenCandidate, validation);
  writeJson("validation-fail.json", validation);
  writeJson("fix-request.json", request);
  writeFileSync(join(required("SMOKE_OUTPUT"), "fix-prompt.md"), createBoundedFixPrompt(request, contract, contextPack, brokenCandidate, validation));
  writeJson("fix-schema.json", BOUNDED_FIX_OUTPUT_SCHEMA);
}

function validateFix(): void {
  const contract = readJson("contract.json");
  const contextPack = readJson("context.json");
  const brokenCandidate = readJson("broken-candidate.json");
  const validationFail = readJson("validation-fail.json");
  const request = readJson("fix-request.json");
  const proposal = readJson("raw-fix-proposal.json") as WorkerProposal;
  const targetRoot = required("SMOKE_TARGET_ROOT");
  const sha = required("SMOKE_SHA");

  const fixedCandidate = createFixedCandidateChangeSet(
    request,
    contract,
    contextPack,
    brokenCandidate,
    validationFail,
    proposal,
  );
  verifyCandidateChangeSet(fixedCandidate, contract, contextPack);

  if (fixedCandidate.changes.length !== 1 || fixedCandidate.changes[0]?.path !== TARGET_PATH) {
    throw new Error("bounded FIX smoke must return exactly the allowed target path");
  }

  const validationPass = runDeterministicValidation(
    contract,
    contextPack,
    fixedCandidate,
    targetRoot,
    sha,
    { commandTimeoutMs: 60_000 },
  );
  verifyDeterministicValidationResult(validationPass);
  if (validationPass.status !== "PASS") throw new Error("bounded FIX smoke revised candidate did not PASS deterministic validation");

  writeJson("fixed-candidate.json", fixedCandidate);
  writeJson("validation-pass.json", validationPass);
}

const command = process.argv[2];
if (command === "prepare") prepare();
else if (command === "fail") createFailureEvidence();
else if (command === "validate-fix") validateFix();
else throw new Error("usage: bounded-fix-smoke-handler.ts <prepare|fail|validate-fix>");
