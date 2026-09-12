import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createImplementContextPack } from "./context-pack.js";
import { createImplementContract, type ApprovedPlanIdentity } from "./implement-contract.js";
import {
  createCandidateChangeSet,
  createSinglePassPrompt,
  verifyCandidateChangeSet,
  WORKER_OUTPUT_SCHEMA,
  type WorkerProposal,
} from "./single-pass-worker.js";

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

function prepare(): void {
  const repository = required("SMOKE_REPOSITORY");
  const sha = required("SMOKE_SHA");
  const runId = positiveInteger("SMOKE_RUN_ID");
  const runAttempt = positiveInteger("SMOKE_RUN_ATTEMPT");
  const actorId = positiveInteger("SMOKE_ACTOR_ID");
  const targetRoot = required("SMOKE_TARGET_ROOT");
  const output = required("SMOKE_OUTPUT");
  mkdirSync(output, { recursive: true });

  const requirement = "README.md의 첫 제목 바로 아래에 <!-- single-pass-smoke-candidate --> 주석 한 줄을 추가하고 나머지 내용은 그대로 유지한다.";
  const identity: ApprovedPlanIdentity = {
    requirement: { issueNumber: 74, digest: digest(requirement) },
    repository,
    targetSha: sha,
    plan: {
      runId,
      runAttempt,
      artifact: {
        name: `smoke-plan-${runId}-attempt-${runAttempt}`,
        id: runId * 10 + 1,
        digest: digest(`smoke-plan:${repository}:${sha}:${runId}:${runAttempt}`),
      },
      provenanceArtifact: {
        name: `smoke-plan-${runId}-attempt-${runAttempt}-provenance`,
        id: runId * 10 + 2,
        digest: digest(`smoke-provenance:${repository}:${sha}:${runId}:${runAttempt}`),
      },
    },
    approval: { commentId: runId * 10 + 3, approverUserId: actorId },
  };

  const contract = createImplementContract(identity, {
    allowedPaths: ["README.md"],
    requiredChanges: [requirement],
    forbiddenChanges: [
      "README.md 이외의 파일 변경 금지",
      "기존 README 내용 삭제 또는 요약 금지",
      "commit, push, PR 생성 금지",
    ],
    validationCommands: ["trusted validator only"],
    maxFilesChanged: 1,
    maxContextBytes: 50_000,
    maxPatchBytes: 50_000,
  });
  const contextPack = createImplementContextPack(contract, targetRoot, sha);

  writeFileSync(join(output, "contract.json"), JSON.stringify(contract, null, 2));
  writeFileSync(join(output, "context.json"), JSON.stringify(contextPack, null, 2));
  writeFileSync(join(output, "prompt.md"), createSinglePassPrompt(contract, contextPack));
  writeFileSync(join(output, "schema.json"), JSON.stringify(WORKER_OUTPUT_SCHEMA, null, 2));
  writeFileSync(join(output, "smoke-metadata.json"), JSON.stringify({ smokeOnly: true, repository, sha, runId, runAttempt }, null, 2));
}

function validate(): void {
  const output = required("SMOKE_OUTPUT");
  const contract = JSON.parse(readFileSync(join(output, "contract.json"), "utf8"));
  const contextPack = JSON.parse(readFileSync(join(output, "context.json"), "utf8"));
  const proposal = JSON.parse(readFileSync(join(output, "raw-proposal.json"), "utf8")) as WorkerProposal;
  const candidate = createCandidateChangeSet(contract, contextPack, proposal);
  verifyCandidateChangeSet(candidate, contract, contextPack);
  writeFileSync(join(output, "candidate.json"), JSON.stringify(candidate, null, 2));
}

const command = process.argv[2];
if (command === "prepare") prepare();
else if (command === "validate") validate();
else throw new Error("usage: single-pass-smoke-handler.ts <prepare|validate>");
