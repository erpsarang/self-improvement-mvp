import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  APPROVAL_COMMAND,
  authorize,
  type AuthorizationProvenance,
  type TrustedApproverPolicy,
} from "./authorization.js";

export const WORKFLOW_PATH = ".github/workflows/authorize.yml" as const;
export const artifactNameFor = (commentId: number, runAttempt: number): string =>
  `authorize-approval-${commentId}-attempt-${runAttempt}`;
export const pointerFor = (commentId: number, runId: number, runAttempt: number): string =>
  `<!-- self-improvement:AUTHORIZE-ARTIFACT approval-comment=${commentId} run-id=${runId} run-attempt=${runAttempt} artifact=${artifactNameFor(commentId, runAttempt)} -->`;

export interface IssueCommentEvent {
  readonly action: string;
  readonly issue: {
    readonly number: number;
    readonly title: string;
    readonly body: string | null;
    readonly pull_request?: unknown;
  };
  readonly comment: {
    readonly id: number;
    readonly body: string;
    readonly created_at: string;
    readonly user: { readonly id: number; readonly login: string };
  };
}

export interface AuthorizationIssueComment {
  readonly id: number;
  readonly issueNumber: number;
  readonly isPullRequest: boolean;
  readonly body: string;
  readonly createdAt: string;
  readonly user: { readonly id: number; readonly login: string; readonly type: string };
}

export interface WorkflowIdentity {
  readonly repository: string;
  readonly workflowPath: typeof WORKFLOW_PATH;
  readonly runId: number;
  readonly runAttempt: number;
  readonly githubSha: string;
}

export interface AuthorizationArtifact {
  readonly name: string;
  readonly provenance: AuthorizationProvenance;
  readonly run: WorkflowIdentity;
}

export interface AuthorizationStore {
  getComment(commentId: number): Promise<AuthorizationIssueComment | undefined>;
  hasPointer(issueNumber: number, body: string): Promise<boolean>;
  listArtifacts(commentId: number, runId: number): Promise<readonly AuthorizationArtifact[]>;
  stagePointer(body: string): Promise<void>;
  writeProvenance(provenance: AuthorizationProvenance): Promise<void>;
}

/** Reusable trust boundary: only an artifact tied to this exact trusted workflow run is AUTHORIZE. */
export function isTrustedAuthorizationArtifact(
  artifact: AuthorizationArtifact,
  expected: AuthorizationProvenance,
): boolean {
  return artifact.name === artifactNameFor(expected.approvalCommentId, expected.runAttempt) &&
    artifact.run.workflowPath === WORKFLOW_PATH &&
    artifact.run.repository === expected.repository &&
    artifact.run.runId === expected.runId &&
    artifact.run.runAttempt === expected.runAttempt &&
    artifact.run.githubSha === expected.githubSha &&
    JSON.stringify(artifact.provenance) === JSON.stringify(expected);
}

export type HandleResult = "authorized" | "already-authorized" | "ignored";

/** Re-fetch the approval, then create artifact provenance; the Issue comment is only a pointer. */
export async function handleAuthorization(
  event: IssueCommentEvent,
  policy: TrustedApproverPolicy,
  identity: WorkflowIdentity,
  store: AuthorizationStore,
): Promise<HandleResult> {
  if (event.action !== "created" || event.issue.pull_request !== undefined || event.comment.body !== APPROVAL_COMMAND) return "ignored";

  const approval = await store.getComment(event.comment.id);
  if (!approval || approval.id !== event.comment.id || approval.issueNumber !== event.issue.number ||
      approval.isPullRequest || approval.body !== APPROVAL_COMMAND || approval.user.id !== event.comment.user.id) {
    return "ignored";
  }
  const trustedApprover = policy.approvers.find(({ id }) => id === approval.user.id);
  if (!trustedApprover) return "ignored";

  // title/body come from the immutable issue_comment event payload that caused this
  // authorization run. Later Issue edits must never change the authorized task.
  const provenance = authorize({
    issueNumber: approval.issueNumber,
    issueTitle: event.issue.title,
    issueBody: event.issue.body,
    approvalCommentId: approval.id,
    approverId: approval.user.id,
    approver: approval.user.login,
    command: approval.body,
    approvedAt: approval.createdAt,
    ...identity,
  }, policy);

  const artifacts = await store.listArtifacts(approval.id, identity.runId);
  const existingArtifact = artifacts.find((artifact) =>
    isTrustedAuthorizationArtifact(artifact, artifact.provenance) &&
    artifact.provenance.approvalCommentId === approval.id &&
    artifact.provenance.issueNumber === approval.issueNumber &&
    artifact.provenance.approverId === approval.user.id &&
    artifact.provenance.approver === approval.user.login &&
    artifact.provenance.approvalCommand === approval.body &&
    artifact.provenance.policyVersion === policy.version &&
    artifact.provenance.policySnapshot === provenance.policySnapshot &&
    artifact.provenance.requirements?.digest === provenance.requirements.digest
  );
  if (existingArtifact) {
    const pointer = pointerFor(approval.id, existingArtifact.run.runId, existingArtifact.run.runAttempt);
    if (!await store.hasPointer(approval.issueNumber, pointer)) await store.stagePointer(pointer);
    return "already-authorized";
  }

  await store.writeProvenance(provenance);
  await store.stagePointer(pointerFor(event.comment.id, identity.runId, identity.runAttempt));
  return "authorized";
}

/** Strict supported YAML subset: top-level version and a flat array of {id, login} records only. */
export function parseTrustedApproverPolicy(source: string): TrustedApproverPolicy {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let version: number | undefined;
  let approvers: Array<{ id: number; login: string }> | undefined;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const versionMatch = /^version:\s*([1-9]\d*)\s*(?:#.*)?$/.exec(line);
    if (versionMatch) { if (version !== undefined) throw new Error("duplicate version"); version = Number(versionMatch[1]); continue; }
    if (/^approvers:\s*(?:#.*)?$/.test(line)) {
      if (approvers !== undefined) throw new Error("duplicate approvers");
      approvers = [];
      while (i + 1 < lines.length && /^(?:\s|$)/.test(lines[i + 1]!)) {
        const first = lines[++i]!;
        if (/^\s*(?:#.*)?$/.test(first)) continue;
        const idMatch = /^  - id:\s*([1-9]\d*)\s*(?:#.*)?$/.exec(first);
        if (!idMatch || i + 1 >= lines.length) throw new Error("approvers must contain id/login records");
        const loginMatch = /^    login:\s*(?:["']([A-Za-z0-9-]+)["']|([A-Za-z0-9-]+))\s*(?:#.*)?$/.exec(lines[++i]!);
        const id = Number(idMatch[1]);
        if (!loginMatch || !Number.isSafeInteger(id)) throw new Error("approvers must contain id/login records");
        approvers.push({ id, login: (loginMatch[1] ?? loginMatch[2])! });
      }
      continue;
    }
    throw new Error("unsupported trusted approver policy YAML");
  }
  if (version === undefined || !approvers?.length ||
      new Set(approvers.map(({ id }) => id)).size !== approvers.length ||
      new Set(approvers.map(({ login }) => login)).size !== approvers.length) throw new Error("trusted approver policy 형식이 올바르지 않습니다");
  return { version, approvers };
}

export class GitHubApiError extends Error {
  constructor(readonly status: number) {
    super(`GitHub API 오류: ${status}`);
  }
}

type GitHubRequest = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * Read candidate artifacts without turning GitHub retrieval failures into a
 * missing authorization. Only archives that were retrieved successfully but
 * do not contain valid provenance are ignored.
 */
export async function listAuthorizationArtifacts(
  commentId: number,
  workflowRunId: number,
  repository: string,
  request: GitHubRequest,
): Promise<readonly AuthorizationArtifact[]> {
  const data = await (await request(`/actions/runs/${workflowRunId}/artifacts?per_page=100`)).json() as { artifacts?: Array<{ id: number; name: string; archive_download_url: string; workflow_run?: { id?: number } }> };
  const results: AuthorizationArtifact[] = [];
  for (const artifact of data.artifacts ?? []) {
    const attemptMatch = new RegExp(`^authorize-approval-${commentId}-attempt-([1-9]\\d*)$`).exec(artifact.name);
    const artifactRunId = artifact.workflow_run?.id;
    if (!attemptMatch || artifactRunId !== workflowRunId) continue;

    const artifactAttempt = Number(attemptMatch[1]);
    // These requests deliberately remain outside the malformed-archive catch:
    // treating a transient API failure as "not found" could create a duplicate.
    const run = await (await request(`/actions/runs/${artifactRunId}/attempts/${artifactAttempt}`)).json() as { id: number; run_attempt: number; head_sha: string; path: string; repository?: { full_name?: string } };
    const zip = Buffer.from(await (await request(artifact.archive_download_url.replace(`https://api.github.com/repos/${repository}`, ""))).arrayBuffer());
    const tmp = `/tmp/authorize-${artifact.id}.zip`;
    await writeFile(tmp, zip);

    try {
      const { stdout } = await promisify(execFile)("unzip", ["-p", tmp, "authorize.json"]);
      results.push({ name: artifact.name, provenance: JSON.parse(stdout) as AuthorizationProvenance, run: { repository: run.repository?.full_name ?? "", workflowPath: run.path as typeof WORKFLOW_PATH, runId: run.id, runAttempt: run.run_attempt, githubSha: run.head_sha } });
    } catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof Error && "code" in error)) throw error;
      // A successfully downloaded unrelated/malformed archive is not a trust anchor.
    }
  }
  return results;
}

/** A deleted approval is absent; every other API failure remains fail-closed. */
export async function getAuthorizationComment(
  commentId: number,
  request: GitHubRequest,
): Promise<AuthorizationIssueComment | undefined> {
  let response: Response;
  try {
    response = await request(`/issues/comments/${commentId}`);
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) return undefined;
    throw error;
  }
  const c = await response.json() as { id?: number; body?: string; created_at?: string; issue_url?: string; user?: { id?: number; login?: string; type?: string } };
  const issueNumber = Number(/\/issues\/(\d+)$/.exec(c.issue_url ?? "")?.[1]);
  if (!Number.isInteger(issueNumber)) return undefined;
  const issue = await (await request(`/issues/${issueNumber}`)).json() as { pull_request?: unknown };
  return { id: c.id ?? 0, issueNumber, isPullRequest: issue.pull_request !== undefined, body: c.body ?? "", createdAt: c.created_at ?? "", user: { id: c.user?.id ?? 0, login: c.user?.login ?? "", type: c.user?.type ?? "" } };
}

async function main(): Promise<void> {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const runId = Number(process.env.GITHUB_RUN_ID);
  const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  const githubSha = process.env.GITHUB_SHA;
  if (!eventPath || !repository || !token || !githubSha || !Number.isInteger(runId) || !Number.isInteger(runAttempt)) throw new Error("GitHub 실행 환경이 필요합니다");
  const event = JSON.parse(await readFile(eventPath, "utf8")) as IssueCommentEvent;
  const policy = parseTrustedApproverPolicy(await readFile("policy/trusted-approvers.yml", "utf8"));
  const request = async (path: string, init?: RequestInit): Promise<Response> => {
    const response = await fetch(`https://api.github.com/repos/${repository}${path}`, { ...init, headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", ...init?.headers } });
    if (!response.ok) throw new GitHubApiError(response.status);
    return response;
  };
  const store: AuthorizationStore = {
    async getComment(commentId) { return getAuthorizationComment(commentId, request); },
    async hasPointer(issueNumber, body) {
      for (let page = 1; ; page += 1) {
        const data = await (await request(`/issues/${issueNumber}/comments?per_page=100&page=${page}`)).json() as Array<{ body?: string }>;
        if (data.some((comment) => comment.body?.trim() === body)) return true;
        if (data.length < 100) return false;
      }
    },
    async listArtifacts(commentId, workflowRunId) {
      return listAuthorizationArtifacts(commentId, workflowRunId, repository, request);
    },
    async stagePointer(body) { await writeFile("authorize-pointer.txt", `${body}\n`); },
    async writeProvenance(provenance) { await writeFile("authorize.json", `${JSON.stringify(provenance, null, 2)}\n`); },
  };
  console.log(await handleAuthorization(event, policy, { repository, workflowPath: WORKFLOW_PATH, runId, runAttempt, githubSha }, store));
}

if (process.argv[1]?.endsWith("authorize-handler.ts")) await main();
