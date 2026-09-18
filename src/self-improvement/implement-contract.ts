import { createHash } from "node:crypto";

export interface ApprovedPlanIdentity {
  readonly requirement: {
    readonly issueNumber: number;
    readonly digest: string;
  };
  readonly repository: string;
  readonly targetSha: string;
  readonly plan: {
    readonly runId: number;
    readonly runAttempt: number;
    readonly artifact: {
      readonly name: string;
      readonly id: number;
      readonly digest: string;
    };
    readonly provenanceArtifact: {
      readonly name: string;
      readonly id: number;
      readonly digest: string;
    };
  };
  readonly approval: {
    readonly commentId: number;
    readonly approverUserId: number;
  };
}

export interface ApprovedRequirementSnapshot {
  readonly title: string;
  readonly body: string | null;
}

export interface ImplementScope {
  readonly allowedPaths: readonly string[];
  readonly contextPaths?: readonly string[];
  readonly requiredChanges: readonly string[];
  readonly forbiddenChanges: readonly string[];
  readonly validationCommands: readonly string[];
  readonly maxFilesChanged: number;
  readonly maxContextBytes: number;
  readonly maxPatchBytes?: number;
}

export interface ImplementContractPayload {
  readonly schemaVersion: 1;
  readonly kind: "trusted-implement-contract";
  readonly requirement: ApprovedPlanIdentity["requirement"];
  readonly requirementSnapshot: ApprovedRequirementSnapshot | null;
  readonly repository: string;
  readonly baseSha: string;
  readonly approvedPlan: ApprovedPlanIdentity["plan"];
  readonly approval: ApprovedPlanIdentity["approval"];
  readonly scope: {
    readonly allowedPaths: readonly string[];
    readonly contextPaths: readonly string[];
    readonly requiredChanges: readonly string[];
    readonly forbiddenChanges: readonly string[];
    readonly validationCommands: readonly string[];
    readonly maxFilesChanged: number;
    readonly maxContextBytes: number;
    readonly maxPatchBytes?: number;
  };
}

export interface ImplementContract extends ImplementContractPayload {
  readonly digestAlgorithm: "sha256";
  readonly contractDigest: string;
}

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40,64}$/;

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
}

function assertNonempty(name: string, value: string): void {
  if (!value.trim()) throw new Error(`${name} must be non-empty`);
}

function assertDigest(name: string, value: string): void {
  if (!SHA256.test(value)) throw new Error(`${name} must be a lowercase SHA-256 hex digest`);
}

export function requirementSnapshotDigest(snapshot: ApprovedRequirementSnapshot): string {
  assertNonempty("requirementSnapshot.title", snapshot.title);
  if (snapshot.body !== null && typeof snapshot.body !== "string") throw new Error("requirementSnapshot.body must be string or null");
  return createHash("sha256").update(JSON.stringify([snapshot.title, snapshot.body]), "utf8").digest("hex");
}

function normalizeRequirementSnapshot(
  snapshot: ApprovedRequirementSnapshot | null,
  expectedDigest: string,
): ApprovedRequirementSnapshot | null {
  if (snapshot === null) return null;
  const normalized = { title: snapshot.title, body: snapshot.body };
  if (requirementSnapshotDigest(normalized) !== expectedDigest) {
    throw new Error("requirementSnapshot digest mismatch; re-plan required");
  }
  return normalized;
}

function normalizePaths(name: "allowedPaths" | "contextPaths", paths: readonly string[], allowEmpty: boolean): string[] {
  if (!allowEmpty && paths.length === 0) throw new Error(`${name} must not be empty`);
  const normalized = paths.map((path) => {
    const label = name === "allowedPaths" ? "allowed path" : "context path";
    assertNonempty(label, path);
    if (path.startsWith("/") || path.includes("\\") || path.split("/").some((segment) => segment === ".." || segment === "")) {
      throw new Error(`unsafe ${label}: ${path}`);
    }
    return path;
  });
  if (new Set(normalized).size !== normalized.length) throw new Error(`${name} must be unique`);
  return [...normalized].sort();
}

function normalizeNonemptyList(name: string, values: readonly string[], allowEmpty = false): string[] {
  if (!allowEmpty && values.length === 0) throw new Error(`${name} must not be empty`);
  const result = values.map((value) => {
    assertNonempty(name, value);
    return value;
  });
  return [...result];
}

export function validateApprovedPlanIdentity(identity: ApprovedPlanIdentity): void {
  assertPositiveInteger("requirement.issueNumber", identity.requirement.issueNumber);
  assertDigest("requirement.digest", identity.requirement.digest);
  assertNonempty("repository", identity.repository);
  if (!GIT_SHA.test(identity.targetSha)) throw new Error("targetSha must be a lowercase Git commit SHA");

  assertPositiveInteger("plan.runId", identity.plan.runId);
  assertPositiveInteger("plan.runAttempt", identity.plan.runAttempt);
  assertNonempty("plan.artifact.name", identity.plan.artifact.name);
  assertPositiveInteger("plan.artifact.id", identity.plan.artifact.id);
  assertDigest("plan.artifact.digest", identity.plan.artifact.digest);
  assertNonempty("plan.provenanceArtifact.name", identity.plan.provenanceArtifact.name);
  assertPositiveInteger("plan.provenanceArtifact.id", identity.plan.provenanceArtifact.id);
  assertDigest("plan.provenanceArtifact.digest", identity.plan.provenanceArtifact.digest);

  assertPositiveInteger("approval.commentId", identity.approval.commentId);
  assertPositiveInteger("approval.approverUserId", identity.approval.approverUserId);
}

export function implementContractArtifactName(identity: ApprovedPlanIdentity): string {
  validateApprovedPlanIdentity(identity);
  return `implement-contract-issue-${identity.requirement.issueNumber}-plan-${identity.plan.runId}-attempt-${identity.plan.runAttempt}-approval-${identity.approval.commentId}`;
}

export function createImplementContract(
  identity: ApprovedPlanIdentity,
  scope: ImplementScope,
  requirementSnapshot: ApprovedRequirementSnapshot | null = null,
): ImplementContract {
  validateApprovedPlanIdentity(identity);
  const approvedRequirementSnapshot = normalizeRequirementSnapshot(requirementSnapshot, identity.requirement.digest);
  const allowedPaths = normalizePaths("allowedPaths", scope.allowedPaths, false);
  const contextPaths = normalizePaths("contextPaths", scope.contextPaths ?? [], true);
  const requiredChanges = normalizeNonemptyList("requiredChanges", scope.requiredChanges);
  const forbiddenChanges = normalizeNonemptyList("forbiddenChanges", scope.forbiddenChanges, true);
  const validationCommands = normalizeNonemptyList("validationCommands", scope.validationCommands);
  assertPositiveInteger("maxFilesChanged", scope.maxFilesChanged);
  if (scope.maxFilesChanged > allowedPaths.length) throw new Error("maxFilesChanged cannot exceed allowedPaths length");
  assertPositiveInteger("maxContextBytes", scope.maxContextBytes);
  if (scope.maxPatchBytes !== undefined) assertPositiveInteger("maxPatchBytes", scope.maxPatchBytes);

  const payload: ImplementContractPayload = {
    schemaVersion: 1,
    kind: "trusted-implement-contract",
    requirement: { ...identity.requirement },
    requirementSnapshot: approvedRequirementSnapshot,
    repository: identity.repository,
    baseSha: identity.targetSha,
    approvedPlan: {
      runId: identity.plan.runId,
      runAttempt: identity.plan.runAttempt,
      artifact: { ...identity.plan.artifact },
      provenanceArtifact: { ...identity.plan.provenanceArtifact },
    },
    approval: { ...identity.approval },
    scope: {
      allowedPaths,
      contextPaths,
      requiredChanges,
      forbiddenChanges,
      validationCommands,
      maxFilesChanged: scope.maxFilesChanged,
      maxContextBytes: scope.maxContextBytes,
      ...(scope.maxPatchBytes === undefined ? {} : { maxPatchBytes: scope.maxPatchBytes }),
    },
  };

  const contractDigest = createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
  return { ...payload, digestAlgorithm: "sha256", contractDigest };
}

export function verifyImplementContract(contract: ImplementContract): void {
  if (contract.schemaVersion !== 1 || contract.kind !== "trusted-implement-contract" || contract.digestAlgorithm !== "sha256") {
    throw new Error("unsupported IMPLEMENT contract schema");
  }
  assertDigest("contractDigest", contract.contractDigest);

  const regenerated = createImplementContract({
    requirement: contract.requirement,
    repository: contract.repository,
    targetSha: contract.baseSha,
    plan: contract.approvedPlan,
    approval: contract.approval,
  }, contract.scope, contract.requirementSnapshot);

  if (JSON.stringify(regenerated) !== JSON.stringify(contract)) {
    throw new Error("IMPLEMENT contract digest or canonical shape mismatch");
  }
}
