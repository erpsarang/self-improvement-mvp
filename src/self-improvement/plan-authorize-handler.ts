import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertExactPlanApproval,
  assertHumanApprover,
  createPlanAuthorizeArtifact,
  normalizePlanProvenance,
  planAuthorizeArtifactName,
  requirementDigest,
  type PlanArtifactMetadata,
  type RawPlanProvenance,
} from "./plan-authorization.js";

interface EventPayload {
  issue: { number: number; pull_request?: unknown };
  comment: {
    id: number;
    body: string;
    created_at: string;
    user: { id: number; login: string; type: string };
  };
  repository: { name: string; owner: { login: string }; default_branch: string };
}

const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error("GITHUB_TOKEN is required");

const eventPath = process.env.GITHUB_EVENT_PATH;
if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required");
const event = JSON.parse(readFileSync(eventPath, "utf8")) as EventPayload;

const repository = `${event.repository.owner.login}/${event.repository.name}`;
const [owner, repo] = repository.split("/");
if (!owner || !repo) throw new Error("invalid repository identity");

async function api<T>(path: string): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "self-improvement-mvp-plan-authorize",
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path}`);
  return await response.json() as T;
}

async function allComments(issueNumber: number): Promise<any[]> {
  const result: any[] = [];
  for (let page = 1; ; page += 1) {
    const pageItems = await api<any[]>(`/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`);
    result.push(...pageItems);
    if (pageItems.length < 100) return result;
  }
}

function parsePlanPointer(body: string): { runId: number; runAttempt: number } | null {
  if (!body.startsWith("## PLAN (AI 제안 — 구현 승인 아님)")) return null;
  const match = body.match(/Workflow run:\s*(\d+)\s*\/\s*attempt:\s*(\d+)/);
  if (!match) return null;
  const runId = Number(match[1]);
  const runAttempt = Number(match[2]);
  if (!Number.isSafeInteger(runId) || runId < 1 || !Number.isSafeInteger(runAttempt) || runAttempt < 1) return null;
  return { runId, runAttempt };
}

function normalizeApiDigest(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} digest missing`);
  return value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
}

async function readProvenanceArtifact(artifactId: number): Promise<RawPlanProvenance> {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/artifacts/${artifactId}/zip`, {
    redirect: "follow",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "self-improvement-mvp-plan-authorize",
    },
  });
  if (!response.ok) throw new Error(`failed to download provenance artifact ${artifactId}: ${response.status}`);

  const directory = mkdtempSync(join(tmpdir(), "plan-authorize-"));
  try {
    const zipPath = join(directory, "artifact.zip");
    writeFileSync(zipPath, Buffer.from(await response.arrayBuffer()));
    const unzip = spawnSync("unzip", ["-p", zipPath, "PLAN-provenance.json"], { encoding: "utf8" });
    if (unzip.status !== 0 || !unzip.stdout.trim()) throw new Error("PLAN provenance artifact is unreadable");
    return JSON.parse(unzip.stdout) as RawPlanProvenance;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  if (event.issue.pull_request) throw new Error("PLAN approval is allowed only on requirement Issues");
  assertExactPlanApproval(event.comment.body);
  assertHumanApprover(event.comment.user.type, event.comment.user.id);

  const comments = await allComments(event.issue.number);
  const duplicate = comments.some((comment) =>
    typeof comment.body === "string" &&
    comment.body.includes(`<!-- self-improvement:PLAN_AUTHORIZE approval-comment=${event.comment.id} `),
  );
  if (duplicate) {
    if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, "created=false\n", { flag: "a" });
    return;
  }

  const issue = await api<any>(`/repos/${owner}/${repo}/issues/${event.issue.number}`);
  if (issue.pull_request || typeof issue.title !== "string") throw new Error("requirement Issue expected");
  const currentDigest = requirementDigest(issue.title, issue.body ?? null);

  const repositoryInfo = await api<any>(`/repos/${owner}/${repo}`);
  const defaultBranch = repositoryInfo.default_branch;
  if (typeof defaultBranch !== "string" || !defaultBranch) throw new Error("default branch missing");
  const branch = await api<any>(`/repos/${owner}/${repo}/branches/${encodeURIComponent(defaultBranch)}`);
  const currentTargetSha = branch.commit?.sha;
  if (typeof currentTargetSha !== "string") throw new Error("default branch HEAD missing");

  const approvalTime = Date.parse(event.comment.created_at);
  const locators = comments
    .filter((comment) => comment.id !== event.comment.id && comment.user?.login === "github-actions[bot]")
    .filter((comment) => Date.parse(comment.created_at) <= approvalTime)
    .map((comment) => ({ comment, locator: parsePlanPointer(comment.body ?? "") }))
    .filter((item): item is { comment: any; locator: { runId: number; runAttempt: number } } => item.locator !== null)
    .sort((a, b) => Date.parse(b.comment.created_at) - Date.parse(a.comment.created_at) || b.comment.id - a.comment.id);

  let selected: ReturnType<typeof normalizePlanProvenance> | null = null;
  let selectedProvenanceArtifact: PlanArtifactMetadata | null = null;
  let selectedRunId = 0;
  let selectedRunAttempt = 0;

  for (const { locator } of locators) {
    try {
      const run = await api<any>(`/repos/${owner}/${repo}/actions/runs/${locator.runId}`);
      if (run.name !== "Read-only AI PLAN" || run.event !== "workflow_dispatch" || run.conclusion !== "success") continue;
      if (Number(run.run_attempt) !== locator.runAttempt) continue;

      const artifactsResponse = await api<any>(`/repos/${owner}/${repo}/actions/runs/${locator.runId}/artifacts?per_page=100`);
      const artifacts: any[] = artifactsResponse.artifacts ?? [];
      const planName = `plan-issue-${event.issue.number}-${locator.runId}-attempt-${locator.runAttempt}`;
      const planRaw = artifacts.find((artifact) => artifact.name === planName && artifact.expired === false);
      const provenanceRaw = artifacts.find((artifact) => artifact.name === `${planName}-provenance` && artifact.expired === false);
      if (!planRaw || !provenanceRaw) continue;

      const planArtifact: PlanArtifactMetadata = {
        name: planRaw.name,
        id: Number(planRaw.id),
        digest: normalizeApiDigest(planRaw.digest, "PLAN artifact"),
      };
      const provenanceArtifact: PlanArtifactMetadata = {
        name: provenanceRaw.name,
        id: Number(provenanceRaw.id),
        digest: normalizeApiDigest(provenanceRaw.digest, "PLAN provenance artifact"),
      };
      const provenance = await readProvenanceArtifact(provenanceArtifact.id);
      const normalized = normalizePlanProvenance(provenance, {
        issueNumber: event.issue.number,
        repository,
        runId: locator.runId,
        runAttempt: locator.runAttempt,
        planArtifact,
      });

      selected = normalized;
      selectedProvenanceArtifact = provenanceArtifact;
      selectedRunId = locator.runId;
      selectedRunAttempt = locator.runAttempt;
      break;
    } catch {
      continue;
    }
  }

  if (!selected || !selectedProvenanceArtifact) throw new Error("no valid PLAN provenance exists before this approval");

  const authorization = createPlanAuthorizeArtifact({
    normalizedPlan: selected,
    provenanceArtifact: selectedProvenanceArtifact,
    currentRequirementDigest: currentDigest,
    currentTargetSha,
    approvalCommentId: event.comment.id,
    approverUserId: event.comment.user.id,
    authorizationRunId: Number(process.env.GITHUB_RUN_ID),
    authorizationRunAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  });

  const artifactName = planAuthorizeArtifactName(authorization);
  writeFileSync("plan-authorize.json", JSON.stringify(authorization, null, 2));
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `created=true\nartifact_name=${artifactName}\nplan_run_id=${selectedRunId}\nplan_run_attempt=${selectedRunAttempt}\n`, { flag: "a" });
  }
}

await main();
