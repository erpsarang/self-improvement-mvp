import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuthorizationProvenance } from "./authorization.js";
import { createImplementProvenance, validateAuthorizationForImplement } from "./implement.js";

interface WorkflowRunEvent {
  readonly workflow_run: {
    readonly id: number;
    readonly run_attempt: number;
    readonly head_sha: string;
    readonly conclusion: string;
    readonly repository: { readonly full_name: string };
  };
}

interface IssuePayload {
  readonly number: number;
  readonly pull_request?: unknown;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name}이 필요합니다`);
  return value;
}

function runtimePath(name: string): string {
  return join(required("IMPLEMENT_RUNTIME_DIR"), name);
}

async function githubGet(path: string): Promise<Response> {
  const token = required("GITHUB_TOKEN");
  const repository = required("GITHUB_REPOSITORY");
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GitHub API 오류: ${response.status}`);
  return response;
}

async function loadValidatedAuthorization(): Promise<AuthorizationProvenance> {
  const event = JSON.parse(await readFile(required("GITHUB_EVENT_PATH"), "utf8")) as WorkflowRunEvent;
  const authorization = JSON.parse(await readFile(required("AUTHORIZE_JSON"), "utf8")) as AuthorizationProvenance;
  const source = event.workflow_run;
  return validateAuthorizationForImplement(authorization, {
    id: source.id,
    runAttempt: source.run_attempt,
    headSha: source.head_sha,
    repository: source.repository.full_name,
    conclusion: source.conclusion,
  });
}

export async function prepareImplement(): Promise<void> {
  await mkdir(required("IMPLEMENT_RUNTIME_DIR"), { recursive: true });
  const authorization = await loadValidatedAuthorization();

  // Current Issue content is intentionally not used for implementation. We only
  // re-fetch identity/type so a deleted or PR-shaped target fails closed.
  const issue = await (await githubGet(`/issues/${authorization.issueNumber}`)).json() as IssuePayload;
  if (issue.number !== authorization.issueNumber || issue.pull_request !== undefined) {
    throw new Error("승인 대상은 실제 일반 Issue여야 합니다");
  }

  const prompt = [
    "당신은 AI Development Framework의 untrusted Implementer입니다.",
    "아래 승인 시점에 고정된 Issue 요구사항만 구현하세요.",
    "GitHub에 commit, push, branch 생성, PR 생성, merge를 시도하지 마세요.",
    "작업 디렉터리의 파일만 수정하세요. 기존 테스트가 있으면 실행하고 실패 원인을 해결하세요.",
    "SEAL, PUBLISH, VERIFY, REVIEW, MERGE_READY는 수행하지 마세요.",
    "",
    `Issue #${authorization.issueNumber}: ${authorization.requirements.title}`,
    "",
    authorization.requirements.body ?? "",
  ].join("\n");

  // codex-action의 prompt-file은 repository-relative path를 사용한다.
  await writeFile("codex-prompt.txt", `${prompt}\n`);
}

export async function finalizeImplement(): Promise<void> {
  await mkdir(required("IMPLEMENT_RUNTIME_DIR"), { recursive: true });
  // This function is intended to run from a fresh exact-SHA checkout in a
  // separate job. The untrusted candidate patch is data only and is never applied.
  const authorization = await loadValidatedAuthorization();
  const patch = await readFile(runtimePath("candidate.patch"));
  const provenance = createImplementProvenance({
    authorization,
    implementRun: {
      runId: Number(required("GITHUB_RUN_ID")),
      runAttempt: Number(required("GITHUB_RUN_ATTEMPT")),
    },
    candidatePatch: patch,
    aiResultId: required("AI_RESULT_ID"),
  });
  await writeFile(runtimePath("implement.json"), `${JSON.stringify(provenance, null, 2)}\n`);
}

if (process.argv[1]?.endsWith("implement-handler.ts")) {
  const mode = process.argv[2];
  if (mode === "prepare") await prepareImplement();
  else if (mode === "finalize") await finalizeImplement();
  else throw new Error("prepare 또는 finalize mode가 필요합니다");
}
