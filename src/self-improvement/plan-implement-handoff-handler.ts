import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createImplementContextPack } from "./context-pack.js";
import { verifyImplementContract, type ImplementContract } from "./implement-contract.js";
import {
  createPlanImplementContract,
  createPlanImplementHandoffManifest,
  PLAN_AUTHORIZE_WORKFLOW_PATH,
  PLAN_WORKFLOW_PATH,
  planImplementHandoffArtifactName,
  validatePlanAuthorizeSource,
  verifyPlanAuthorizeArtifact,
  type PlanAuthorizeArtifactMetadata,
  type PlanAuthorizeSourceRun,
} from "./plan-implement-handoff.js";
import { planAuthorizeArtifactName, type PlanAuthorizeArtifact } from "./plan-authorization.js";
import { createSinglePassPrompt, WORKER_OUTPUT_SCHEMA } from "./single-pass-worker.js";

interface SourceRecord {
  readonly authorization: PlanAuthorizeArtifact;
  readonly sourceArtifact: PlanAuthorizeArtifactMetadata;
}

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

function normalizeDigest(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} digest missing`);
  const normalized = value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error(`${name} digest invalid`);
  return normalized;
}

function output(name: string, value: string): void {
  const path = process.env.GITHUB_OUTPUT;
  if (path) writeFileSync(path, `${name}=${value}\n`, { flag: "a" });
}

function repositoryParts(): { owner: string; repo: string; repository: string } {
  const repository = required("GITHUB_REPOSITORY");
  const [owner, repo, ...extra] = repository.split("/");
  if (!owner || !repo || extra.length > 0) throw new Error("invalid GITHUB_REPOSITORY");
  return { owner, repo, repository };
}

async function api<T>(path: string): Promise<T> {
  const token = required("GITHUB_TOKEN");
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "self-improvement-mvp-plan-implement-handoff",
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path}`);
  return await response.json() as T;
}

async function readArtifactJson(artifactId: number, fileName: string): Promise<unknown> {
  const token = required("GITHUB_TOKEN");
  const { owner, repo } = repositoryParts();
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/artifacts/${artifactId}/zip`, {
    redirect: "follow",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "self-improvement-mvp-plan-implement-handoff",
    },
  });
  if (!response.ok) throw new Error(`failed to download artifact ${artifactId}: ${response.status}`);

  const directory = mkdtempSync(join(tmpdir(), "plan-implement-handoff-"));
  try {
    const zipPath = join(directory, "artifact.zip");
    writeFileSync(zipPath, Buffer.from(await response.arrayBuffer()));
    const listing = spawnSync("unzip", ["-Z1", zipPath], { encoding: "utf8" });
    if (listing.status !== 0) throw new Error(`artifact ${artifactId} is not a readable ZIP`);
    const exact = listing.stdout.split(/\r?\n/).filter((entry) => entry === fileName);
    if (exact.length !== 1) throw new Error(`${fileName} must exist exactly once in artifact ${artifactId}`);
    const extracted = spawnSync("unzip", ["-p", zipPath, fileName], { encoding: "utf8" });
    if (extracted.status !== 0 || !extracted.stdout.trim()) throw new Error(`${fileName} is unreadable`);
    return JSON.parse(extracted.stdout) as unknown;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertExactArtifact(raw: any, expected: PlanAuthorizeArtifactMetadata, label: string): void {
  if (!raw || raw.expired !== false) throw new Error(`${label} artifact missing or expired`);
  if (raw.name !== expected.name || Number(raw.id) !== expected.id || normalizeDigest(raw.digest, label) !== expected.digest) {
    throw new Error(`${label} artifact identity mismatch`);
  }
}

async function prepare(): Promise<void> {
  const { owner, repo, repository } = repositoryParts();
  const directory = required("HANDOFF_OUTPUT");
  mkdirSync(directory, { recursive: true });

  const authorizationPath = required("PLAN_AUTHORIZE_JSON");
  const authorization = verifyPlanAuthorizeArtifact(JSON.parse(readFileSync(authorizationPath, "utf8")));
  if (authorization.repository !== repository) throw new Error("PLAN_AUTHORIZE repository mismatch");

  const sourceArtifact: PlanAuthorizeArtifactMetadata = {
    name: required("SOURCE_ARTIFACT_NAME"),
    id: positiveInteger("SOURCE_ARTIFACT_ID"),
    digest: normalizeDigest(required("SOURCE_ARTIFACT_DIGEST"), "source PLAN_AUTHORIZE artifact"),
  };
  if (sourceArtifact.name !== planAuthorizeArtifactName(authorization)) {
    throw new Error("source PLAN_AUTHORIZE artifact name does not match its trusted payload");
  }

  const sourceRunId = positiveInteger("SOURCE_RUN_ID");
  const sourceRunAttempt = positiveInteger("SOURCE_RUN_ATTEMPT");
  const sourceRun = await api<any>(`/repos/${owner}/${repo}/actions/runs/${sourceRunId}`);
  const repositoryInfo = await api<any>(`/repos/${owner}/${repo}`);
  const defaultBranch = repositoryInfo.default_branch;
  if (typeof defaultBranch !== "string" || !defaultBranch) throw new Error("default branch missing");
  const branch = await api<any>(`/repos/${owner}/${repo}/branches/${encodeURIComponent(defaultBranch)}`);
  const currentDefaultSha = branch.commit?.sha;
  if (typeof currentDefaultSha !== "string") throw new Error("default branch HEAD missing");

  const source: PlanAuthorizeSourceRun = {
    id: Number(sourceRun.id),
    runAttempt: Number(sourceRun.run_attempt),
    repository,
    workflowPath: sourceRun.path,
    event: sourceRun.event,
    conclusion: sourceRun.conclusion,
    headBranch: sourceRun.head_branch,
    defaultBranch,
    headSha: sourceRun.head_sha,
    currentDefaultSha,
  };
  if (source.id !== sourceRunId || source.runAttempt !== sourceRunAttempt) {
    throw new Error("selected PLAN_AUTHORIZE run identity changed");
  }
  validatePlanAuthorizeSource(authorization, source);

  const sourceArtifactsResponse = await api<any>(`/repos/${owner}/${repo}/actions/runs/${sourceRunId}/artifacts?per_page=100`);
  const sourceMatches = (sourceArtifactsResponse.artifacts ?? []).filter((item: any) => item.name === sourceArtifact.name && !item.expired);
  if (sourceMatches.length !== 1) throw new Error("source PLAN_AUTHORIZE artifact must be unique");
  assertExactArtifact(sourceMatches[0], sourceArtifact, "source PLAN_AUTHORIZE");

  const planRun = await api<any>(`/repos/${owner}/${repo}/actions/runs/${authorization.plan.runId}`);
  if (
    planRun.name !== "Read-only AI PLAN" ||
    planRun.path !== PLAN_WORKFLOW_PATH ||
    !["workflow_dispatch", "issues"].includes(planRun.event) ||
    planRun.status !== "completed" ||
    planRun.conclusion !== "success" ||
    Number(planRun.run_attempt) !== authorization.plan.runAttempt ||
    planRun.head_branch !== defaultBranch ||
    planRun.head_sha !== authorization.targetSha
  ) {
    throw new Error("approved PLAN workflow identity mismatch");
  }

  const planArtifactsResponse = await api<any>(`/repos/${owner}/${repo}/actions/runs/${authorization.plan.runId}/artifacts?per_page=100`);
  const planArtifacts: any[] = planArtifactsResponse.artifacts ?? [];
  const exactPlan = planArtifacts.filter((item) => item.name === authorization.plan.artifact.name && !item.expired);
  const exactProvenance = planArtifacts.filter((item) => item.name === authorization.plan.provenanceArtifact.name && !item.expired);
  if (exactPlan.length !== 1 || exactProvenance.length !== 1) {
    throw new Error("approved PLAN artifacts must each exist exactly once");
  }
  assertExactArtifact(exactPlan[0], authorization.plan.artifact, "approved PLAN");
  assertExactArtifact(exactProvenance[0], authorization.plan.provenanceArtifact, "approved PLAN provenance");

  const requirementIssue = await api<any>(`/repos/${owner}/${repo}/issues/${authorization.requirement.issueNumber}`);
  if (requirementIssue.pull_request || typeof requirementIssue.title !== "string" || !requirementIssue.title.trim()) {
    throw new Error("approved Requirement Issue snapshot is invalid");
  }
  if (requirementIssue.body !== null && typeof requirementIssue.body !== "string") {
    throw new Error("approved Requirement Issue body is invalid");
  }
  const requirementSnapshot = {
    title: requirementIssue.title,
    body: requirementIssue.body ?? null,
  };

  const planJson = await readArtifactJson(authorization.plan.artifact.id, "PLAN.json");
  const contract = createPlanImplementContract(authorization, planJson, requirementSnapshot);
  verifyImplementContract(contract);

  const sourceRecord: SourceRecord = { authorization, sourceArtifact };
  writeFileSync(join(directory, "contract.json"), JSON.stringify(contract, null, 2));
  writeFileSync(join(directory, "source.json"), JSON.stringify(sourceRecord, null, 2));

  output("base_sha", contract.baseSha);
  output("artifact_name", planImplementHandoffArtifactName(authorization));
}

function buildContext(): void {
  const directory = required("HANDOFF_OUTPUT");
  const targetRoot = required("TARGET_ROOT");
  const observedBaseSha = required("OBSERVED_BASE_SHA");
  const contract = JSON.parse(readFileSync(join(directory, "contract.json"), "utf8")) as ImplementContract;
  verifyImplementContract(contract);
  const source = JSON.parse(readFileSync(join(directory, "source.json"), "utf8")) as SourceRecord;
  const authorization = verifyPlanAuthorizeArtifact(source.authorization);

  const context = createImplementContextPack(contract, targetRoot, observedBaseSha);
  const prompt = createSinglePassPrompt(contract, context);
  const manifest = createPlanImplementHandoffManifest({
    authorization,
    sourceArtifact: source.sourceArtifact,
    contract,
    contextDigest: context.contextDigest,
  });

  writeFileSync(join(directory, "context.json"), JSON.stringify(context, null, 2));
  writeFileSync(join(directory, "prompt.md"), prompt);
  writeFileSync(join(directory, "schema.json"), JSON.stringify(WORKER_OUTPUT_SCHEMA, null, 2));
  writeFileSync(join(directory, "handoff.json"), JSON.stringify(manifest, null, 2));
}

const command = process.argv[2];
if (command === "prepare") await prepare();
else if (command === "context") buildContext();
else throw new Error("usage: plan-implement-handoff-handler.ts <prepare|context>");
