import type { PlanAuthorizeArtifact } from "./plan-authorization.js";

const GIT_SHA = /^[0-9a-f]{40,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

// 정상 Read-only AI PLAN run이 가질 수 있는 event. plan-authorize / handoff handler와 같은 집합이다.
const PLAN_TRIGGER_EVENTS: readonly string[] = ["workflow_dispatch", "issues"];

export const PLAN_WORKFLOW_PATH = ".github/workflows/plan.yml" as const;
export const MAX_AUTO_REPLAN_PER_AUTHORIZATION = 2 as const;

export type PlanRecoveryReason =
  | "NONE"
  | "DEFAULT_BRANCH_MOVED"
  | "PLAN_CONTROL_PLANE_STALE";

export interface PlanRunObservation {
  readonly name: string;
  readonly path: string;
  readonly event: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly runAttempt: number;
  readonly headBranch: string;
  readonly headSha: string;
}

export interface PlanRecoveryDecision {
  readonly required: boolean;
  readonly reason: PlanRecoveryReason;
}

function validAuthorizationDigest(value: string): void {
  if (!SHA256.test(value)) throw new Error("authorization digest is invalid");
}

export function planRecoveryAuthorizationMarkerPrefix(authorizationDigest: string): string {
  validAuthorizationDigest(authorizationDigest);
  return `<!-- self-improvement:AUTO_REPLAN authorization-digest=${authorizationDigest}`;
}

export function planRecoveryMarker(authorizationDigest: string, currentDefaultSha: string): string {
  validAuthorizationDigest(authorizationDigest);
  validSha("current default SHA", currentDefaultSha);
  return `${planRecoveryAuthorizationMarkerPrefix(authorizationDigest)} target-sha=${currentDefaultSha} -->`;
}

export function planRecoveryBudgetStopMarker(authorizationDigest: string): string {
  validAuthorizationDigest(authorizationDigest);
  return `<!-- self-improvement:AUTO_REPLAN_STOP authorization-digest=${authorizationDigest} -->`;
}

export function countAutomaticPlanRecoveries(
  commentBodies: readonly string[],
  authorizationDigest: string,
): number {
  const prefix = planRecoveryAuthorizationMarkerPrefix(authorizationDigest);
  return commentBodies.filter((body) => body.includes(prefix)).length;
}

function validSha(name: string, value: string): void {
  if (!GIT_SHA.test(value)) throw new Error(`${name} is invalid`);
}

export function classifyPlanRecovery(
  authorization: PlanAuthorizeArtifact,
  planRun: PlanRunObservation,
  defaultBranch: string,
  currentDefaultSha: string,
): PlanRecoveryDecision {
  if (!defaultBranch.trim()) throw new Error("default branch missing");
  validSha("approved PLAN target SHA", authorization.targetSha);
  validSha("PLAN workflow head SHA", planRun.headSha);
  validSha("current default SHA", currentDefaultSha);

  if (
    planRun.name !== "Read-only AI PLAN" ||
    planRun.path !== PLAN_WORKFLOW_PATH ||
    !PLAN_TRIGGER_EVENTS.includes(planRun.event) ||
    planRun.status !== "completed" ||
    planRun.conclusion !== "success" ||
    planRun.headBranch !== defaultBranch ||
    planRun.runAttempt !== authorization.plan.runAttempt
  ) {
    throw new Error("approved PLAN workflow identity is invalid for automatic recovery");
  }

  if (currentDefaultSha !== authorization.targetSha) {
    return { required: true, reason: "DEFAULT_BRANCH_MOVED" };
  }

  if (planRun.headSha !== authorization.targetSha) {
    return { required: true, reason: "PLAN_CONTROL_PLANE_STALE" };
  }

  return { required: false, reason: "NONE" };
}
