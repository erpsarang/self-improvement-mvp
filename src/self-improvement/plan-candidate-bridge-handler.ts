import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createCanonicalCandidatePatch } from "./plan-bridge-patch.js";
import {
  runDeterministicValidation,
  verifyDeterministicValidationResult,
  type DeterministicValidationResult,
} from "./deterministic-ci.js";
import {
  validatePlanImplementWorkerSource,
  verifyPlanImplementWorkerBundle,
  type HandoffArtifactMetadata,
  type PlanImplementWorkerBundle,
  type PlanImplementWorkerSourceRun,
} from "./plan-implement-worker.js";
import {
  createPlanCandidateBridgeProvenance,
  freezePlanRequirement,
  planCandidateBridgeArtifactName,
  validateBridgePatch,
  validatePlanCandidateWorkerSource,
  validateWorkerCandidateAgainstHandoff,
  verifyPlanCandidateBridgeProvenance,
  verifyWorkerCandidateProvenanceShape,
  type ArtifactMetadata,
  type FrozenPlanRequirement,
  type PlanCandidateWorkerSourceRun,
  type TrustedRecoveryCompareGuard,
} from "./plan-candidate-bridge.js";
import type { CandidateChangeSet } from "./single-pass-worker.js";

const HANDOFF_FILES = [
  "context.json",
  "contract.json",
  "handoff.json",
  "prompt.md",
  "schema.json",
  "source.json",
] as const;
const CANDIDATE_FILES = ["candidate-provenance.json", "candidate.json"] as const;

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
      "User-Agent": "self-improvement-mvp-plan-candidate-bridge",
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path}`);
  return await response.json() as T;
}

function assertExactFiles(directory: string, expectedFiles: readonly string[], label: string): void {
  const files = readdirSync(directory, { withFileTypes: true });
  if (files.some((entry) => !entry.isFile())) throw new Error(`${label} artifact must contain files only`);
  const actual = files.map((entry) => entry.name).sort();
  const expected = [...expectedFiles].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} artifact file set mismatch: ${actual.join(",")}`);
  }
}

function loadCandidate(directory: string): {
  candidate: CandidateChangeSet;
  provenance: ReturnType<typeof verifyWorkerCandidateProvenanceShape>;
} {
  assertExactFiles(directory, CANDIDATE_FILES, "Worker candidate");
  const candidate = JSON.parse(readFileSync(join(directory, "candidate.json"), "utf8")) as CandidateChangeSet;
  const provenance = verifyWorkerCandidateProvenanceShape(
    JSON.parse(readFileSync(join(directory, "candidate-provenance.json"), "utf8")),
  );
  if (candidate.candidateDigest !== provenance.candidateDigest) throw new Error("candidate/provenance digest mismatch");
  return { candidate, provenance };
}

function loadBundle(directory: string): PlanImplementWorkerBundle {
  assertExactFiles(directory, HANDOFF_FILES, "Handoff");
  return verifyPlanImplementWorkerBundle({
    contract: JSON.parse(readFileSync(join(directory, "contract.json"), "utf8")),
    context: JSON.parse(readFileSync(join(directory, "context.json"), "utf8")),
    handoff: JSON.parse(readFileSync(join(directory, "handoff.json"), "utf8")),
    source: JSON.parse(readFileSync(join(directory, "source.json"), "utf8")),
    prompt: readFileSync(join(directory, "prompt.md"), "utf8"),
    schema: JSON.parse(readFileSync(join(directory, "schema.json"), "utf8")),
  });
}

function selectedWorkerArtifact(): ArtifactMetadata {
  return {
    name: required("SOURCE_CANDIDATE_ARTIFACT_NAME"),
    id: positiveInteger("SOURCE_CANDIDATE_ARTIFACT_ID"),
    digest: normalizeDigest(required("SOURCE_CANDIDATE_ARTIFACT_DIGEST"), "Worker candidate artifact"),
  };
}

function trustedRecoveryGuard(): TrustedRecoveryCompareGuard | undefined {
  const kind = process.env.TRUSTED_RECOVERY_GUARD_KIND;
  if (!kind) return undefined;
  if (kind !== "trusted-recovery-compare-v1") throw new Error("invalid trusted recovery guard kind");
  const workerHeadSha = process.env.TRUSTED_RECOVERY_WORKER_SHA?.trim();
  return {
    kind,
    baseSha: required("TRUSTED_RECOVERY_BASE_SHA"),
    ...(workerHeadSha ? { workerHeadSha } : {}),
    currentDefaultSha: required("TRUSTED_RECOVERY_DEFAULT_SHA"),
  };
}

async function defaultBranchIdentity(owner: string, repo: string): Promise<{ defaultBranch: string; currentDefaultSha: string }> {
  const repositoryInfo = await api<any>(`/repos/${owner}/${repo}`);
  const defaultBranch = repositoryInfo.default_branch;
  if (typeof defaultBranch !== "string" || !defaultBranch) throw new Error("default branch missing");
  const branch = await api<any>(`/repos/${owner}/${repo}/branches/${encodeURIComponent(defaultBranch)}`);
  const currentDefaultSha = branch.commit?.sha;
  if (typeof currentDefaultSha !== "string") throw new Error("default branch HEAD missing");
  return { defaultBranch, currentDefaultSha };
}

async function validateLiveWorkerSource(
  provenance: ReturnType<typeof verifyWorkerCandidateProvenanceShape>,
  selectedArtifact: ArtifactMetadata,
): Promise<PlanCandidateWorkerSourceRun> {
  const { owner, repo, repository } = repositoryParts();
  const sourceRunId = positiveInteger("SOURCE_WORKER_RUN_ID");
  const sourceRunAttempt = positiveInteger("SOURCE_WORKER_RUN_ATTEMPT");
  const sourceRun = await api<any>(`/repos/${owner}/${repo}/actions/runs/${sourceRunId}`);
  const { defaultBranch, currentDefaultSha } = await defaultBranchIdentity(owner, repo);
  const source: PlanCandidateWorkerSourceRun = {
    id: Number(sourceRun.id),
    runAttempt: Number(sourceRun.run_attempt),
    repository,
    workflowName: sourceRun.name,
    workflowPath: sourceRun.path,
    event: sourceRun.event,
    conclusion: sourceRun.conclusion,
    headBranch: sourceRun.head_branch,
    defaultBranch,
    headSha: sourceRun.head_sha,
    currentDefaultSha,
  };
  if (source.id !== sourceRunId || source.runAttempt !== sourceRunAttempt) {
    throw new Error("selected Worker source run identity changed");
  }

  const artifactsResponse = await api<any>(`/repos/${owner}/${repo}/actions/runs/${sourceRunId}/artifacts?per_page=100`);
  const broadPattern = new RegExp(`^bounded-worker-candidate-.*-worker-${sourceRunId}-attempt-${sourceRunAttempt}$`);
  const candidates = (artifactsResponse.artifacts ?? []).filter((item: any) => !item.expired && broadPattern.test(item.name));
  const exact = candidates.filter((item: any) => item.name === selectedArtifact.name);
  if (candidates.length !== 1 || exact.length !== 1) {
    throw new Error(`expected exactly one Worker candidate artifact; exact=${exact.length}, total=${candidates.length}`);
  }
  const artifact = exact[0];
  if (
    Number(artifact.id) !== selectedArtifact.id ||
    normalizeDigest(artifact.digest, "live Worker candidate artifact") !== selectedArtifact.digest
  ) {
    throw new Error("live Worker candidate artifact identity mismatch");
  }
  validatePlanCandidateWorkerSource(provenance, source, selectedArtifact, trustedRecoveryGuard());
  return source;
}

async function validateLiveHandoff(
  bundle: PlanImplementWorkerBundle,
  provenance: ReturnType<typeof verifyWorkerCandidateProvenanceShape>,
): Promise<{ source: PlanImplementWorkerSourceRun; artifact: HandoffArtifactMetadata }> {
  const { owner, repo, repository } = repositoryParts();
  const runId = provenance.sourceHandoff.runId;
  const runAttempt = provenance.sourceHandoff.runAttempt;
  const sourceRun = await api<any>(`/repos/${owner}/${repo}/actions/runs/${runId}`);
  const { defaultBranch, currentDefaultSha } = await defaultBranchIdentity(owner, repo);
  const source: PlanImplementWorkerSourceRun = {
    id: Number(sourceRun.id),
    runAttempt: Number(sourceRun.run_attempt),
    repository,
    workflowName: sourceRun.name,
    workflowPath: sourceRun.path,
    event: sourceRun.event,
    conclusion: sourceRun.conclusion,
    headBranch: sourceRun.head_branch,
    defaultBranch,
    headSha: sourceRun.head_sha,
    currentDefaultSha,
  };
  if (source.id !== runId || source.runAttempt !== runAttempt) throw new Error("Handoff source run identity changed");

  const artifact: HandoffArtifactMetadata = {
    name: provenance.sourceHandoff.artifact.name,
    id: provenance.sourceHandoff.artifact.id,
    digest: provenance.sourceHandoff.artifact.digest,
  };
  const artifactsResponse = await api<any>(`/repos/${owner}/${repo}/actions/runs/${runId}/artifacts?per_page=100`);
  const matches = (artifactsResponse.artifacts ?? []).filter((item: any) => !item.expired && item.name === artifact.name);
  if (matches.length !== 1) throw new Error("Handoff artifact must exist exactly once");
  if (
    Number(matches[0].id) !== artifact.id ||
    normalizeDigest(matches[0].digest, "live Handoff artifact") !== artifact.digest
  ) {
    throw new Error("live Handoff artifact identity mismatch");
  }
  validatePlanImplementWorkerSource(bundle, source, artifact, trustedRecoveryGuard());
  return { source, artifact };
}

async function freezeLiveRequirement(bundle: PlanImplementWorkerBundle): Promise<FrozenPlanRequirement> {
  const { owner, repo } = repositoryParts();
  const issueNumber = bundle.authorization.requirement.issueNumber;
  const issue = await api<any>(`/repos/${owner}/${repo}/issues/${issueNumber}`);
  if (issue.pull_request) throw new Error("requirement source must be an Issue, not a PR");
  if (typeof issue.title !== "string") throw new Error("requirement Issue title missing");
  const body = issue.body === null ? null : typeof issue.body === "string" ? issue.body : null;
  return freezePlanRequirement(bundle.authorization, issue.title, body);
}

async function validateAllLiveInputs(input: {
  candidateDirectory: string;
  handoffDirectory: string;
  workerArtifact: ArtifactMetadata;
}): Promise<{
  candidate: CandidateChangeSet;
  provenance: ReturnType<typeof verifyWorkerCandidateProvenanceShape>;
  bundle: PlanImplementWorkerBundle;
  workerSource: PlanCandidateWorkerSourceRun;
  handoffSource: PlanImplementWorkerSourceRun;
  handoffArtifact: HandoffArtifactMetadata;
  requirement: FrozenPlanRequirement;
}> {
  const { candidate, provenance } = loadCandidate(input.candidateDirectory);
  const workerSource = await validateLiveWorkerSource(provenance, input.workerArtifact);
  const bundle = loadBundle(input.handoffDirectory);
  const { source: handoffSource, artifact: handoffArtifact } = await validateLiveHandoff(bundle, provenance);
  const recoveryGuard = trustedRecoveryGuard();
  validateWorkerCandidateAgainstHandoff({
    candidate,
    provenance,
    bundle,
    handoffSource,
    handoffArtifact,
    workerSource,
    workerArtifact: input.workerArtifact,
    ...(recoveryGuard ? { recoveryGuard } : {}),
  });
  const requirement = await freezeLiveRequirement(bundle);
  return { candidate, provenance, bundle, workerSource, handoffSource, handoffArtifact, requirement };
}

async function prepare(): Promise<void> {
  const candidateDirectory = required("SOURCE_CANDIDATE_DIRECTORY");
  const workerArtifact = selectedWorkerArtifact();
  const { provenance } = loadCandidate(candidateDirectory);
  await validateLiveWorkerSource(provenance, workerArtifact);

  const bridgeRunId = positiveInteger("BRIDGE_RUN_ID");
  const bridgeRunAttempt = positiveInteger("BRIDGE_RUN_ATTEMPT");
  output("handoff_run_id", String(provenance.sourceHandoff.runId));
  output("handoff_run_attempt", String(provenance.sourceHandoff.runAttempt));
  output("handoff_artifact_name", provenance.sourceHandoff.artifact.name);
  output("handoff_artifact_id", String(provenance.sourceHandoff.artifact.id));
  output("handoff_artifact_digest", provenance.sourceHandoff.artifact.digest);
  output("base_sha", provenance.baseSha);
  output("issue_number", String(provenance.issueNumber));
  output("bridge_artifact_name", planCandidateBridgeArtifactName({
    issueNumber: provenance.issueNumber,
    workerRunId: provenance.worker.runId,
    workerRunAttempt: provenance.worker.runAttempt,
    bridgeRunId,
    bridgeRunAttempt,
  }));
}

async function validate(): Promise<void> {
  const candidateDirectory = required("SOURCE_CANDIDATE_DIRECTORY");
  const handoffDirectory = required("HANDOFF_DIRECTORY");
  const targetDirectory = required("TARGET_DIRECTORY");
  const stateDirectory = required("STATE_DIRECTORY");
  const observedBaseSha = required("OBSERVED_BASE_SHA");
  const workerArtifact = selectedWorkerArtifact();
  const live = await validateAllLiveInputs({ candidateDirectory, handoffDirectory, workerArtifact });
  if (observedBaseSha !== live.bundle.contract.baseSha) throw new Error("bridge exact checkout SHA mismatch");

  const result = runDeterministicValidation(
    live.bundle.contract,
    live.bundle.context,
    live.candidate,
    targetDirectory,
    observedBaseSha,
  );
  if (result.status !== "PASS") {
    throw new Error(`deterministic validation failed: ${JSON.stringify(result.commands)}`);
  }
  mkdirSync(stateDirectory, { recursive: true });
  writeFileSync(join(stateDirectory, "validation.json"), JSON.stringify(result, null, 2));
  writeFileSync(join(stateDirectory, "requirement.json"), JSON.stringify(live.requirement, null, 2));
}

async function finalize(): Promise<void> {
  const candidateDirectory = required("SOURCE_CANDIDATE_DIRECTORY");
  const handoffDirectory = required("HANDOFF_DIRECTORY");
  const targetDirectory = required("TARGET_DIRECTORY");
  const stateDirectory = required("STATE_DIRECTORY");
  const outputDirectory = required("BRIDGE_OUTPUT_DIRECTORY");
  const observedBaseSha = required("OBSERVED_BASE_SHA");
  const workerArtifact = selectedWorkerArtifact();
  const live = await validateAllLiveInputs({ candidateDirectory, handoffDirectory, workerArtifact });
  if (observedBaseSha !== live.bundle.contract.baseSha) throw new Error("bridge finalize exact checkout SHA mismatch");

  const validation = JSON.parse(readFileSync(join(stateDirectory, "validation.json"), "utf8")) as DeterministicValidationResult;
  verifyDeterministicValidationResult(validation);
  const frozen = JSON.parse(readFileSync(join(stateDirectory, "requirement.json"), "utf8")) as FrozenPlanRequirement;
  if (JSON.stringify(frozen) !== JSON.stringify(live.requirement)) throw new Error("frozen requirement changed between validation and finalize");

  // canonical patch는 candidate의 exact approved paths만 대상으로 만든다.
  // candidate 밖 tracked 변경은 fail-closed, candidate 밖 untracked build artifact는 patch/provenance에서 제외한다.
  const { patch, classification } = createCanonicalCandidatePatch(
    targetDirectory,
    observedBaseSha,
    live.candidate.changes.map(({ path, content }) => ({ path, content })),
  );
  if (classification.excludedUntrackedPaths.length > 0) {
    console.log(`canonical patch excludes ${classification.excludedUntrackedPaths.length} untracked validation artifact(s) outside the candidate`);
  }
  const bridgeRunId = positiveInteger("BRIDGE_RUN_ID");
  const bridgeRunAttempt = positiveInteger("BRIDGE_RUN_ATTEMPT");
  const trustedCodeSha = required("BRIDGE_TRUSTED_CODE_SHA");
  const recoveryGuard = trustedRecoveryGuard();
  const provenance = createPlanCandidateBridgeProvenance({
    bundle: live.bundle,
    requirement: live.requirement,
    candidate: live.candidate,
    workerProvenance: live.provenance,
    handoffSource: live.handoffSource,
    handoffArtifact: live.handoffArtifact,
    workerSource: live.workerSource,
    workerArtifact,
    ...(recoveryGuard ? { recoveryGuard } : {}),
    deterministicValidation: validation,
    candidatePatch: patch,
    bridgeRun: { runId: bridgeRunId, runAttempt: bridgeRunAttempt, trustedCodeSha },
  });
  verifyPlanCandidateBridgeProvenance(provenance);
  validateBridgePatch(provenance, patch);

  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(join(outputDirectory, "candidate.patch"), patch);
  writeFileSync(join(outputDirectory, "plan-bridge.json"), JSON.stringify(provenance, null, 2));
}

const command = process.argv[2];
if (command === "prepare") await prepare();
else if (command === "validate") await validate();
else if (command === "finalize") await finalize();
else throw new Error("usage: plan-candidate-bridge-handler.ts <prepare|validate|finalize>");
