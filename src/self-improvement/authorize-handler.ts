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
export const artifactNameFor = (commentId: number): string =>
  `authorize-approval-${commentId}`;
export const pointerFor = (commentId: number, runId: number, runAttempt: number): string =>
  `<!-- self-improvement:AUTHORIZE-ARTIFACT approval-comment=${commentId} run-id=${runId} run-attempt=${runAttempt} artifact=${artifactNameFor(commentId)} -->`;

export interface IssueCommentEvent {
  readonly action: string;
  readonly issue: { readonly number: number; readonly pull_request?: unknown };
  readonly comment: { readonly id: number; readonly body: string; readonly created_at: string; readonly user: { readonly login: string } };
}

export interface AuthorizationIssueComment {
  readonly id: number;
  readonly issueNumber: number;
  readonly isPullRequest: boolean;
  readonly body: string;
  readonly createdAt: string;
  readonly user: { readonly login: string; readonly type: string };
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
  listArtifacts(name: string): Promise<readonly AuthorizationArtifact[]>;
  stagePointer(body: string): Promise<void>;
  writeProvenance(provenance: AuthorizationProvenance): Promise<void>;
}

/** Reusable trust boundary: only an artifact tied to this exact trusted workflow run is AUTHORIZE. */
export function isTrustedAuthorizationArtifact(
  artifact: AuthorizationArtifact,
  expected: AuthorizationProvenance,
): boolean {
  return artifact.name === artifactNameFor(expected.approvalCommentId) &&
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
      approval.isPullRequest || approval.body !== APPROVAL_COMMAND || approval.user.login !== event.comment.user.login) {
    return "ignored";
  }
  if (!policy.approvers.includes(approval.user.login)) return "ignored";
  const provenance = authorize({
    issueNumber: approval.issueNumber,
    approvalCommentId: approval.id,
    approver: approval.user.login,
    command: approval.body,
    approvedAt: approval.createdAt,
    ...identity,
  }, policy);

  const artifacts = await store.listArtifacts(artifactNameFor(approval.id));
  if (artifacts.some((artifact) => isTrustedAuthorizationArtifact(artifact, artifact.provenance) &&
      artifact.provenance.approvalCommentId === approval.id && artifact.provenance.issueNumber === approval.issueNumber &&
      artifact.provenance.approver === approval.user.login && artifact.provenance.approvalCommand === approval.body &&
      artifact.provenance.policyVersion === policy.version && artifact.provenance.policySnapshot === provenance.policySnapshot)) {
    return "already-authorized";
  }

  await store.writeProvenance(provenance);
  await store.stagePointer(pointerFor(event.comment.id, identity.runId, identity.runAttempt));
  return "authorized";
}

/** Strict supported YAML subset: top-level version and a flat string array only. */
export function parseTrustedApproverPolicy(source: string): TrustedApproverPolicy {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let version: number | undefined;
  let approvers: string[] | undefined;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const versionMatch = /^version:\s*([1-9]\d*)\s*(?:#.*)?$/.exec(line);
    if (versionMatch) { if (version !== undefined) throw new Error("duplicate version"); version = Number(versionMatch[1]); continue; }
    const inline = /^approvers:\s*\[(.*)\]\s*(?:#.*)?$/.exec(line);
    if (inline) {
      if (approvers !== undefined) throw new Error("duplicate approvers");
      approvers = inline[1]!.trim() === "" ? [] : inline[1]!.split(",").map((item) => {
        const match = /^\s*["']([A-Za-z0-9-]+)["']\s*$/.exec(item);
        if (!match) throw new Error("approvers must be quoted strings");
        return match[1]!;
      });
      continue;
    }
    if (/^approvers:\s*(?:#.*)?$/.test(line)) {
      if (approvers !== undefined) throw new Error("duplicate approvers");
      approvers = [];
      while (i + 1 < lines.length && /^(?:\s|$)/.test(lines[i + 1]!)) {
        const child = lines[++i]!;
        if (/^\s*(?:#.*)?$/.test(child)) continue;
        const item = /^  -\s+(?:["']([A-Za-z0-9-]+)["']|([A-Za-z0-9-]+))\s*(?:#.*)?$/.exec(child);
        if (!item) throw new Error("approvers must be a flat string array");
        approvers.push((item[1] ?? item[2])!);
      }
      continue;
    }
    throw new Error("unsupported trusted approver policy YAML");
  }
  if (version === undefined || !approvers?.length || new Set(approvers).size !== approvers.length) throw new Error("trusted approver policy 형식이 올바르지 않습니다");
  return { version, approvers };
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
    if (!response.ok) throw new Error(`GitHub API 오류: ${response.status}`);
    return response;
  };
  const store: AuthorizationStore = {
    async getComment(commentId) {
      const response = await request(`/issues/comments/${commentId}`);
      const c = await response.json() as { id?: number; body?: string; created_at?: string; issue_url?: string; user?: { login?: string; type?: string } };
      const issueNumber = Number(/\/issues\/(\d+)$/.exec(c.issue_url ?? "")?.[1]);
      if (!Number.isInteger(issueNumber)) return undefined;
      const issue = await (await request(`/issues/${issueNumber}`)).json() as { pull_request?: unknown };
      return { id: c.id ?? 0, issueNumber, isPullRequest: issue.pull_request !== undefined, body: c.body ?? "", createdAt: c.created_at ?? "", user: { login: c.user?.login ?? "", type: c.user?.type ?? "" } };
    },
    async listArtifacts(name) {
      const data = await (await request(`/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100`)).json() as { artifacts?: Array<{ name: string; archive_download_url: string; workflow_run?: { id?: number } }> };
      const results: AuthorizationArtifact[] = [];
      for (const artifact of data.artifacts ?? []) {
        if (!artifact.workflow_run?.id) continue;
        try {
          const run = await (await request(`/actions/runs/${artifact.workflow_run.id}`)).json() as { id: number; run_attempt: number; head_sha: string; path: string; repository?: { full_name?: string } };
          const zip = Buffer.from(await (await request(artifact.archive_download_url.replace(`https://api.github.com/repos/${repository}`, ""))).arrayBuffer());
          const tmp = `/tmp/authorize-${artifact.workflow_run.id}.zip`;
          await writeFile(tmp, zip);
          const { stdout } = await promisify(execFile)("unzip", ["-p", tmp, "authorize.json"]);
          results.push({ name: artifact.name, provenance: JSON.parse(stdout) as AuthorizationProvenance, run: { repository: run.repository?.full_name ?? "", workflowPath: run.path as typeof WORKFLOW_PATH, runId: run.id, runAttempt: run.run_attempt, githubSha: run.head_sha } });
        } catch {
          // An unrelated or malformed same-name artifact is never a trust anchor.
        }
      }
      return results;
    },
    async stagePointer(body) { await writeFile("authorize-pointer.txt", `${body}\n`); },
    async writeProvenance(provenance) { await writeFile("authorize.json", `${JSON.stringify(provenance, null, 2)}\n`); },
  };
  console.log(await handleAuthorization(event, policy, { repository, workflowPath: WORKFLOW_PATH, runId, runAttempt, githubSha }, store));
}

if (process.argv[1]?.endsWith("authorize-handler.ts")) await main();
