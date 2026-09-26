import { createHash } from "node:crypto";
import {
  createImplementContract,
  validateApprovedPlanIdentity,
  type ImplementContract,
  type ApprovedRequirementSnapshot,
} from "./implement-contract.js";
import {
  toApprovedPlanIdentity,
  type PlanAuthorizeArtifact,
} from "./plan-authorization.js";
import type { ApprovedPlanEvidence } from "./context-pack.js";
import {
  PLAN_IMPLEMENT_MAX_CONTEXT_BYTES as PLANNER_IMPLEMENT_MAX_CONTEXT_BYTES,
  verifyPlanContextPack,
  type PlanContextPack,
} from "./planner.js";

export const PLAN_AUTHORIZE_WORKFLOW_PATH = ".github/workflows/plan-authorize.yml" as const;
export const PLAN_WORKFLOW_PATH = ".github/workflows/plan.yml" as const;
export const PLAN_IMPLEMENT_MAX_CONTEXT_BYTES = PLANNER_IMPLEMENT_MAX_CONTEXT_BYTES;
export const PLAN_IMPLEMENT_MAX_PATCH_BYTES = 80_000;
export const PLAN_IMPLEMENT_MAX_FILES = 8;

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40,64}$/;
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;
const TRUSTED_VALIDATION_COMMANDS = new Set(["npm test", "npm run build"]);

export interface PlanAuthorizeSourceRun {
  readonly id: number;
  readonly runAttempt: number;
  readonly repository: string;
  readonly workflowPath: string;
  readonly event: string;
  readonly conclusion: string;
  readonly headBranch: string;
  readonly defaultBranch: string;
  readonly headSha: string;
  readonly currentDefaultSha: string;
}

export interface PlanImplementationScopeInput {
  readonly ready: boolean;
  readonly allowedPaths: readonly string[];
  readonly contextPaths: readonly string[];
  readonly requiredChanges: readonly string[];
  readonly forbiddenChanges: readonly string[];
  readonly validationCommands: readonly string[];
}

export interface ApprovedPlanDocument {
  readonly questions: readonly string[];
  readonly approach: readonly string[];
  readonly implementationScope: PlanImplementationScopeInput;
}

export interface PlanAuthorizeArtifactMetadata {
  readonly name: string;
  readonly id: number;
  readonly digest: string;
}

export interface PlanImplementHandoffPayload {
  readonly schemaVersion: 1;
  readonly kind: "trusted-plan-implement-handoff";
  readonly repository: string;
  readonly baseSha: string;
  readonly issueNumber: number;
  readonly sourcePlanAuthorize: {
    readonly runId: number;
    readonly runAttempt: number;
    readonly artifact: PlanAuthorizeArtifactMetadata;
  };
  readonly approvedPlan: {
    readonly runId: number;
    readonly runAttempt: number;
    readonly artifactName: string;
  };
  readonly approvalCommentId: number;
  readonly contractDigest: string;
  readonly contextDigest: string;
  /**
   * IMPLEMENT Context가 contextPaths를 어떻게 표현했는지. "full"은 전체 파일, "plan-excerpt"는 예산 초과로
   * 승인된 PLAN evidence 발췌를 재사용한 경우이며 그때 어떤 경로가 발췌인지와 근거가 된 PLAN Context digest를 남긴다.
   */
  readonly contextMaterialization: PlanImplementContextMaterialization;
}

export interface PlanImplementContextMaterialization {
  readonly representation: "full" | "plan-excerpt";
  readonly excerptPaths: readonly string[];
  readonly approvedPlanContextDigest: string | null;
}

export const FULL_CONTEXT_MATERIALIZATION: PlanImplementContextMaterialization = Object.freeze({
  representation: "full",
  excerptPaths: Object.freeze([]) as readonly string[],
  approvedPlanContextDigest: null,
});

export interface PlanImplementHandoffManifest extends PlanImplementHandoffPayload {
  readonly digestAlgorithm: "sha256";
  readonly handoffDigest: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(name: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function assertDigest(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 digest`);
  }
}

function assertSafePath(path: string): void {
  if (
    !path.trim() ||
    !SAFE_PATH.test(path) ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("*") ||
    path.includes("?") ||
    path.includes("[") ||
    path.endsWith("/") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`unsafe approved PLAN path: ${path}`);
  }
}

function exactArray(name: string, value: unknown, max: number, allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim().length > 0)) {
    throw new Error(`invalid ${name}`);
  }
  if ((!allowEmpty && value.length === 0) || value.length > max) {
    throw new Error(`${name} exceeds or misses its bounded size`);
  }
  return [...value] as string[];
}

function authorizationPayload(artifact: PlanAuthorizeArtifact): Omit<PlanAuthorizeArtifact, "digestAlgorithm" | "authorizationDigest"> {
  return {
    schemaVersion: 1,
    kind: "trusted-plan-authorize",
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
    authorization: { ...artifact.authorization },
  };
}

export function verifyPlanAuthorizeArtifact(value: unknown): PlanAuthorizeArtifact {
  if (!record(value)) throw new Error("PLAN_AUTHORIZE artifact must be an object");
  if (value.schemaVersion !== 1 || value.kind !== "trusted-plan-authorize" || value.digestAlgorithm !== "sha256") {
    throw new Error("unsupported PLAN_AUTHORIZE artifact schema");
  }
  if (!record(value.authorization)) throw new Error("PLAN_AUTHORIZE authorization identity missing");
  positiveInteger("authorization.runId", value.authorization.runId);
  positiveInteger("authorization.runAttempt", value.authorization.runAttempt);
  assertDigest("authorizationDigest", value.authorizationDigest);

  const artifact = value as unknown as PlanAuthorizeArtifact;
  validateApprovedPlanIdentity(toApprovedPlanIdentity(artifact));
  const expected = createHash("sha256")
    .update(JSON.stringify(authorizationPayload(artifact)), "utf8")
    .digest("hex");
  if (artifact.authorizationDigest !== expected) {
    throw new Error("PLAN_AUTHORIZE artifact digest mismatch");
  }
  return artifact;
}

export function validatePlanAuthorizeSource(
  artifact: PlanAuthorizeArtifact,
  source: PlanAuthorizeSourceRun,
): void {
  verifyPlanAuthorizeArtifact(artifact);
  positiveInteger("source run id", source.id);
  positiveInteger("source run attempt", source.runAttempt);
  if (source.repository !== artifact.repository) throw new Error("PLAN_AUTHORIZE source repository mismatch");
  if (source.workflowPath !== PLAN_AUTHORIZE_WORKFLOW_PATH) throw new Error("unexpected PLAN_AUTHORIZE source workflow");
  if (source.event !== "issue_comment" || source.conclusion !== "success") {
    throw new Error("PLAN_AUTHORIZE source run is not a successful issue_comment run");
  }
  if (source.headBranch !== source.defaultBranch) throw new Error("PLAN_AUTHORIZE source is not on the default branch");
  if (!GIT_SHA.test(source.headSha) || !GIT_SHA.test(source.currentDefaultSha)) throw new Error("invalid source SHA");
  if (source.id !== artifact.authorization.runId || source.runAttempt !== artifact.authorization.runAttempt) {
    throw new Error("PLAN_AUTHORIZE source run identity mismatch");
  }
  if (source.headSha !== artifact.targetSha) throw new Error("PLAN_AUTHORIZE source SHA mismatch");
  if (source.currentDefaultSha !== artifact.targetSha) {
    throw new Error("default branch moved after PLAN approval; re-plan required");
  }
}

export function validateApprovedPlanDocument(value: unknown): ApprovedPlanDocument {
  if (!record(value)) throw new Error("approved PLAN must be an object");
  if (!Array.isArray(value.questions) || !value.questions.every((item) => typeof item === "string")) {
    throw new Error("approved PLAN questions are invalid");
  }
  if (value.questions.length !== 0) throw new Error("approved PLAN still has blocking questions");
  const approach = exactArray("approach", value.approach, 8, false);
  if (!record(value.implementationScope)) throw new Error("approved PLAN implementationScope missing");

  const scope = value.implementationScope;
  const expectedKeys = ["allowedPaths", "contextPaths", "forbiddenChanges", "ready", "requiredChanges", "validationCommands"];
  if (JSON.stringify(Object.keys(scope).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error("approved PLAN implementationScope shape is invalid");
  }
  if (scope.ready !== true) throw new Error("approved PLAN implementationScope is not ready");

  const allowedPaths = exactArray("allowedPaths", scope.allowedPaths, PLAN_IMPLEMENT_MAX_FILES, false);
  const contextPaths = exactArray("contextPaths", scope.contextPaths, PLAN_IMPLEMENT_MAX_FILES, true);
  const requiredChanges = exactArray("requiredChanges", scope.requiredChanges, 8, false);
  const forbiddenChanges = exactArray("forbiddenChanges", scope.forbiddenChanges, 8, true);
  const validationCommands = exactArray("validationCommands", scope.validationCommands, 2, false);
  if (new Set(allowedPaths).size !== allowedPaths.length) throw new Error("approved PLAN allowedPaths must be unique");
  if (new Set(contextPaths).size !== contextPaths.length) throw new Error("approved PLAN contextPaths must be unique");
  for (const path of allowedPaths) assertSafePath(path);
  for (const path of contextPaths) assertSafePath(path);
  for (const command of validationCommands) {
    if (!TRUSTED_VALIDATION_COMMANDS.has(command)) throw new Error(`untrusted approved validation command: ${command}`);
  }

  return {
    questions: [],
    approach,
    implementationScope: {
      ready: true,
      allowedPaths,
      contextPaths,
      requiredChanges,
      forbiddenChanges,
      validationCommands,
    },
  };
}

function extractCanonicalPlanDocument(
  value: unknown,
  authorization: PlanAuthorizeArtifact,
): ApprovedPlanDocument {
  if (!record(value)) throw new Error("approved PLAN artifact must be an object");
  const expectedKeys = ["context", "kind", "plan", "repository", "requirement", "sha"];
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error("approved PLAN artifact wrapper shape is invalid");
  }
  if (value.kind !== "untrusted-plan") throw new Error("approved PLAN artifact kind is invalid");
  if (value.repository !== authorization.repository) throw new Error("approved PLAN artifact repository mismatch");
  if (value.sha !== authorization.targetSha) throw new Error("approved PLAN artifact SHA mismatch");
  if (typeof value.requirement !== "string" || !value.requirement.trim()) {
    throw new Error("approved PLAN artifact requirement is invalid");
  }
  if (!record(value.context)) throw new Error("approved PLAN artifact context is invalid");
  const contextKeys = ["digest", "digestAlgorithm", "evidence", "totalBytes"];
  if (JSON.stringify(Object.keys(value.context).sort()) !== JSON.stringify(contextKeys)) {
    throw new Error("approved PLAN artifact context shape is invalid");
  }
  if (value.context.digestAlgorithm !== "sha256") throw new Error("approved PLAN artifact context digest algorithm is invalid");
  assertDigest("approved PLAN artifact context digest", value.context.digest);
  if (!Array.isArray(value.context.evidence)) throw new Error("approved PLAN artifact context evidence is invalid");
  if (typeof value.context.totalBytes !== "number" || !Number.isSafeInteger(value.context.totalBytes) || value.context.totalBytes < 0) {
    throw new Error("approved PLAN artifact context totalBytes is invalid");
  }
  if (!record(value.plan)) throw new Error("approved PLAN artifact plan is invalid");
  return validateApprovedPlanDocument(value.plan);
}

export function createPlanImplementContract(
  authorization: PlanAuthorizeArtifact,
  planValue: unknown,
  requirementSnapshot: ApprovedRequirementSnapshot,
): ImplementContract {
  const trustedAuthorization = verifyPlanAuthorizeArtifact(authorization);
  const plan = extractCanonicalPlanDocument(planValue, trustedAuthorization);
  const scope = plan.implementationScope;
  const allowedPaths = [...scope.allowedPaths];
  const requiredChanges = [...scope.requiredChanges];

  if (allowedPaths.includes("package.json")) {
    if (!allowedPaths.includes("package-lock.json")) {
      if (allowedPaths.length >= PLAN_IMPLEMENT_MAX_FILES) {
        throw new Error("approved PLAN package.json change requires package-lock.json within bounded scope");
      }
      allowedPaths.push("package-lock.json");
    }
    requiredChanges.push("package.json을 변경하더라도 package-lock.json은 작성하지 않는다. package-lock.json은 trusted deterministic step이 생성해 같은 candidate에 포함한다. 의존성은 npm registry의 semver 버전으로만 지정한다.");
  }

  return createImplementContract(toApprovedPlanIdentity(trustedAuthorization), {
    allowedPaths,
    contextPaths: scope.contextPaths,
    requiredChanges: [
      ...requiredChanges,
      ...plan.approach.map((item) => `승인된 PLAN approach: ${item}`),
    ],
    forbiddenChanges: scope.forbiddenChanges,
    validationCommands: scope.validationCommands,
    maxFilesChanged: allowedPaths.length,
    maxContextBytes: PLAN_IMPLEMENT_MAX_CONTEXT_BYTES,
    maxPatchBytes: PLAN_IMPLEMENT_MAX_PATCH_BYTES,
  }, requirementSnapshot);
}

export function planImplementHandoffArtifactName(authorization: PlanAuthorizeArtifact): string {
  const trusted = verifyPlanAuthorizeArtifact(authorization);
  return `plan-implement-handoff-issue-${trusted.requirement.issueNumber}-plan-${trusted.plan.runId}-attempt-${trusted.plan.runAttempt}-approval-${trusted.approval.commentId}`;
}

function validateContextMaterialization(
  value: PlanImplementContextMaterialization | undefined,
  contract: ImplementContract,
): PlanImplementContextMaterialization {
  const materialization = value ?? FULL_CONTEXT_MATERIALIZATION;
  if (!record(materialization)) throw new Error("contextMaterialization must be an object");
  const keys = Object.keys(materialization).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["approvedPlanContextDigest", "excerptPaths", "representation"])) {
    throw new Error("contextMaterialization has unexpected fields");
  }
  const excerptPaths = exactArray("contextMaterialization.excerptPaths", materialization.excerptPaths, PLAN_IMPLEMENT_MAX_FILES, true);
  if (new Set(excerptPaths).size !== excerptPaths.length) throw new Error("contextMaterialization.excerptPaths must be unique");
  const allowed = new Set(contract.scope.allowedPaths);
  const readOnly = new Set(contract.scope.contextPaths);
  for (const path of excerptPaths) {
    if (allowed.has(path) || !readOnly.has(path)) throw new Error(`excerpt path must be a read-only contextPath: ${path}`);
  }
  if (materialization.representation === "full") {
    if (excerptPaths.length !== 0 || materialization.approvedPlanContextDigest !== null) {
      throw new Error("full context materialization cannot carry excerpt paths or a PLAN context digest");
    }
  } else if (materialization.representation === "plan-excerpt") {
    if (excerptPaths.length === 0) throw new Error("plan-excerpt materialization requires at least one excerpt path");
    assertDigest("contextMaterialization.approvedPlanContextDigest", materialization.approvedPlanContextDigest);
  } else {
    throw new Error("unsupported context materialization representation");
  }
  return {
    representation: materialization.representation,
    excerptPaths: [...excerptPaths],
    approvedPlanContextDigest: materialization.approvedPlanContextDigest,
  };
}

export function createPlanImplementHandoffManifest(input: {
  readonly authorization: PlanAuthorizeArtifact;
  readonly sourceArtifact: PlanAuthorizeArtifactMetadata;
  readonly contract: ImplementContract;
  readonly contextDigest: string;
  readonly contextMaterialization?: PlanImplementContextMaterialization;
}): PlanImplementHandoffManifest {
  const authorization = verifyPlanAuthorizeArtifact(input.authorization);
  assertDigest("source PLAN_AUTHORIZE artifact digest", input.sourceArtifact.digest);
  positiveInteger("source PLAN_AUTHORIZE artifact id", input.sourceArtifact.id);
  if (!input.sourceArtifact.name.trim()) throw new Error("source PLAN_AUTHORIZE artifact name missing");
  assertDigest("contextDigest", input.contextDigest);
  if (input.contract.repository !== authorization.repository || input.contract.baseSha !== authorization.targetSha) {
    throw new Error("IMPLEMENT contract is not bound to approved PLAN identity");
  }
  const contextMaterialization = validateContextMaterialization(input.contextMaterialization, input.contract);

  const payload: PlanImplementHandoffPayload = {
    schemaVersion: 1,
    kind: "trusted-plan-implement-handoff",
    repository: authorization.repository,
    baseSha: authorization.targetSha,
    issueNumber: authorization.requirement.issueNumber,
    sourcePlanAuthorize: {
      runId: authorization.authorization.runId,
      runAttempt: authorization.authorization.runAttempt,
      artifact: { ...input.sourceArtifact },
    },
    approvedPlan: {
      runId: authorization.plan.runId,
      runAttempt: authorization.plan.runAttempt,
      artifactName: authorization.plan.artifact.name,
    },
    approvalCommentId: authorization.approval.commentId,
    contractDigest: input.contract.contractDigest,
    contextDigest: input.contextDigest,
    contextMaterialization,
  };
  const handoffDigest = createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
  return { ...payload, digestAlgorithm: "sha256", handoffDigest };
}

/**
 * 승인된 PLAN artifact의 PLAN-context.json을 PLAN.json의 context digest와 승인 identity에 묶어 검증한다.
 * 이것이 사람이 승인한 PLAN이 실제로 본 evidence이며, IMPLEMENT Context가 예산을 넘을 때
 * read-only contextPath를 발췌로 materialize하는 유일한 근거다 (self-improvement-mvp #244 Handoff run 35976744079).
 */
export function verifyApprovedPlanContext(planJson: unknown, planContext: unknown, authorization: PlanAuthorizeArtifact): PlanContextPack {
  const trusted = verifyPlanAuthorizeArtifact(authorization);
  const context = planContext as PlanContextPack;
  verifyPlanContextPack(context);
  if (!record(planJson) || !record(planJson.context) || context.contextDigest !== planJson.context.digest) {
    throw new Error("approved PLAN context digest does not match PLAN.json");
  }
  if (context.repository !== trusted.repository || context.sha !== trusted.targetSha) {
    throw new Error("approved PLAN context is not bound to approved PLAN identity");
  }
  return context;
}

/** 승인된 PLAN Context의 evidence를 IMPLEMENT Context Pack 발췌 입력으로 투영한다 (내용은 그대로, 필드만 좁힌다). */
export function approvedPlanEvidenceFrom(context: PlanContextPack): ApprovedPlanEvidence[] {
  verifyPlanContextPack(context);
  return context.files.map((file) => ({
    path: file.path,
    startOffset: file.startOffset,
    content: file.content,
    contentDigest: file.contentDigest,
  }));
}
