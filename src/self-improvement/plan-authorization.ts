import { createHash } from "node:crypto";
import type { ApprovedPlanIdentity } from "./implement-contract.js";

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40,64}$/;

export interface PlanArtifactMetadata {
  readonly name: string;
  readonly id: number;
  readonly digest: string;
}

export interface RawPlanProvenance {
  readonly schemaVersion: number;
  readonly kind: string;
  readonly requirement: {
    readonly issueNumber: number;
    readonly digest: string;
  };
  readonly repository: string;
  readonly targetSha: string;
  readonly workflow: {
    readonly runId: string | number;
    readonly runAttempt: string | number;
  };
  readonly artifactName: string;
  readonly artifact: {
    readonly name: string;
    readonly id: string | number;
    readonly digest: string;
  };
}

export interface PlanAuthorizePayload extends ApprovedPlanIdentity {
  readonly schemaVersion: 1;
  readonly kind: "trusted-plan-authorize";
  readonly authorization: {
    readonly runId: number;
    readonly runAttempt: number;
  };
}

export interface PlanAuthorizeArtifact extends PlanAuthorizePayload {
  readonly digestAlgorithm: "sha256";
  readonly authorizationDigest: string;
}

function positiveInteger(name: string, value: string | number): number {
  const normalized = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) throw new Error(`${name} must be a positive safe integer`);
  return normalized;
}

function digest(name: string, value: string): string {
  const normalized = value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
  if (!SHA256.test(normalized)) throw new Error(`${name} must be a lowercase SHA-256 digest`);
  return normalized;
}

function nonempty(name: string, value: string): string {
  if (!value.trim()) throw new Error(`${name} must be non-empty`);
  return value;
}

export function requirementDigest(title: string, body: string | null): string {
  return createHash("sha256").update(JSON.stringify([title, body]), "utf8").digest("hex");
}

export function assertExactPlanApproval(body: string): void {
  if (body !== "PLAN-승인") throw new Error("approval comment must be exact PLAN-승인");
}

export function assertHumanApprover(userType: string, userId: number): void {
  if (userType !== "User") throw new Error("PLAN approval must come from a human GitHub user");
  positiveInteger("approver user id", userId);
}

export function normalizePlanProvenance(
  provenance: RawPlanProvenance,
  expected: {
    issueNumber: number;
    repository: string;
    runId: number;
    runAttempt: number;
    planArtifact: PlanArtifactMetadata;
  },
): Omit<ApprovedPlanIdentity, "approval"> {
  if (provenance.schemaVersion !== 1 || provenance.kind !== "untrusted-plan-provenance") {
    throw new Error("unsupported PLAN provenance schema");
  }
  if (provenance.requirement.issueNumber !== expected.issueNumber) throw new Error("PLAN provenance issue mismatch");
  if (provenance.repository !== expected.repository) throw new Error("PLAN provenance repository mismatch");
  if (!GIT_SHA.test(provenance.targetSha)) throw new Error("PLAN provenance target SHA is invalid");
  const runId = positiveInteger("PLAN run id", provenance.workflow.runId);
  const runAttempt = positiveInteger("PLAN run attempt", provenance.workflow.runAttempt);
  if (runId !== expected.runId || runAttempt !== expected.runAttempt) throw new Error("PLAN workflow identity mismatch");

  const artifactId = positiveInteger("PLAN artifact id", provenance.artifact.id);
  const artifactDigest = digest("PLAN artifact digest", provenance.artifact.digest);
  if (provenance.artifactName !== expected.planArtifact.name || provenance.artifact.name !== expected.planArtifact.name) {
    throw new Error("PLAN artifact name mismatch");
  }
  if (artifactId !== expected.planArtifact.id || artifactDigest !== digest("expected PLAN artifact digest", expected.planArtifact.digest)) {
    throw new Error("PLAN artifact identity mismatch");
  }

  return {
    requirement: {
      issueNumber: provenance.requirement.issueNumber,
      digest: digest("requirement digest", provenance.requirement.digest),
    },
    repository: nonempty("repository", provenance.repository),
    targetSha: provenance.targetSha,
    plan: {
      runId,
      runAttempt,
      artifact: {
        name: expected.planArtifact.name,
        id: expected.planArtifact.id,
        digest: digest("PLAN artifact digest", expected.planArtifact.digest),
      },
      provenanceArtifact: {
        name: "",
        id: 0,
        digest: "",
      },
    },
  };
}

export function createPlanAuthorizeArtifact(input: {
  normalizedPlan: Omit<ApprovedPlanIdentity, "approval">;
  provenanceArtifact: PlanArtifactMetadata;
  currentRequirementDigest: string;
  currentTargetSha: string;
  approvalCommentId: number;
  approverUserId: number;
  authorizationRunId: number;
  authorizationRunAttempt: number;
}): PlanAuthorizeArtifact {
  const currentRequirementDigest = digest("current requirement digest", input.currentRequirementDigest);
  if (input.normalizedPlan.requirement.digest !== currentRequirementDigest) throw new Error("current requirement digest mismatch; re-plan required");
  if (input.normalizedPlan.targetSha !== input.currentTargetSha) throw new Error("current target SHA mismatch; re-plan required");
  if (!GIT_SHA.test(input.currentTargetSha)) throw new Error("current target SHA is invalid");

  const payload: PlanAuthorizePayload = {
    schemaVersion: 1,
    kind: "trusted-plan-authorize",
    requirement: { ...input.normalizedPlan.requirement },
    repository: input.normalizedPlan.repository,
    targetSha: input.normalizedPlan.targetSha,
    plan: {
      runId: input.normalizedPlan.plan.runId,
      runAttempt: input.normalizedPlan.plan.runAttempt,
      artifact: { ...input.normalizedPlan.plan.artifact },
      provenanceArtifact: {
        name: nonempty("PLAN provenance artifact name", input.provenanceArtifact.name),
        id: positiveInteger("PLAN provenance artifact id", input.provenanceArtifact.id),
        digest: digest("PLAN provenance artifact digest", input.provenanceArtifact.digest),
      },
    },
    approval: {
      commentId: positiveInteger("approval comment id", input.approvalCommentId),
      approverUserId: positiveInteger("approver user id", input.approverUserId),
    },
    authorization: {
      runId: positiveInteger("authorization run id", input.authorizationRunId),
      runAttempt: positiveInteger("authorization run attempt", input.authorizationRunAttempt),
    },
  };

  const authorizationDigest = createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
  return { ...payload, digestAlgorithm: "sha256", authorizationDigest };
}

export function planAuthorizeArtifactName(artifact: PlanAuthorizeArtifact): string {
  return `plan-authorize-issue-${artifact.requirement.issueNumber}-plan-${artifact.plan.runId}-attempt-${artifact.plan.runAttempt}-approval-${artifact.approval.commentId}-run-${artifact.authorization.runId}-attempt-${artifact.authorization.runAttempt}`;
}

export function toApprovedPlanIdentity(artifact: PlanAuthorizeArtifact): ApprovedPlanIdentity {
  return {
    requirement: { ...artifact.requirement },
    repository: artifact.repository,
    targetSha: artifact.targetSha,
    plan: {
      runId: artifact.plan.runId,
      runAttempt: artifact.plan.runAttempt,
      artifact: { ...artifact.plan.artifact },
      provenanceArtifact: { ...artifact.plan.provenanceArtifact },
    },
    approval: { ...artifact.approval },
  };
}
