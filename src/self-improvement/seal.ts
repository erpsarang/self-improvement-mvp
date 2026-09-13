import type { ImplementProvenance } from "./implement.js";
import { IMPLEMENT_WORKFLOW_PATH, sha256 } from "./implement.js";
import {
  FIX_REQUEST_WORKFLOW_PATH,
  FIX_WORKFLOW_PATH,
  type FixProvenance,
} from "./fix.js";
import {
  PLAN_CANDIDATE_BRIDGE_WORKFLOW_PATH,
  planCandidateBridgeArtifactName,
  validateBridgePatch,
  verifyPlanCandidateBridgeProvenance,
  type PlanCandidateBridgeProvenance,
} from "./plan-candidate-bridge.js";

export const TRUSTED_RAIL_WORKFLOW_PATH = ".github/workflows/trusted-rail.yml" as const;

export interface CandidateSourceRun {
  readonly id: number;
  readonly runAttempt: number;
  readonly controlPlaneSha: string;
  readonly repository: string;
  readonly conclusion: string;
  readonly workflowPath: string;
}

export type ImplementSourceRun = CandidateSourceRun;

export interface SealRunIdentity {
  readonly runId: number;
  readonly runAttempt: number;
  readonly trustedCodeSha: string;
}

export interface SealProvenance {
  readonly type: "SEAL";
  readonly repository: string;
  readonly issueNumber: number;
  readonly baseSha: string;
  readonly sourceAuthorization?: ImplementProvenance["sourceAuthorization"];
  readonly sourcePlanBridge?: {
    readonly workflowPath: typeof PLAN_CANDIDATE_BRIDGE_WORKFLOW_PATH;
    readonly runId: number;
    readonly runAttempt: number;
    readonly controlPlaneSha: string;
    readonly candidateArtifactName: string;
    readonly bridge: PlanCandidateBridgeProvenance;
  };
  readonly sourceImplement?: {
    readonly workflowPath: typeof IMPLEMENT_WORKFLOW_PATH;
    readonly runId: number;
    readonly runAttempt: number;
    readonly controlPlaneSha: string;
    readonly candidateArtifactName: string;
    readonly candidatePatchDigest: string;
    readonly aiExecution: ImplementProvenance["aiExecution"];
  };
  readonly sourceFix?: {
    readonly workflowPath: typeof FIX_WORKFLOW_PATH;
    readonly runId: number;
    readonly runAttempt: number;
    readonly controlPlaneSha: string;
    readonly candidateArtifactName: string;
    readonly candidatePatchDigest: string;
    readonly fixAttempt: 1 | 2;
    readonly sourceReview: FixProvenance["sourceReview"];
    readonly sourceRequest: FixProvenance["sourceRequest"];
    readonly aiExecution: FixProvenance["aiExecution"];
  };
  readonly sealWorkflow: {
    readonly workflowPath: typeof TRUSTED_RAIL_WORKFLOW_PATH;
    readonly runId: number;
    readonly runAttempt: number;
    readonly trustedCodeSha: string;
  };
  readonly sealedPatchDigest: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validRepository(value: unknown): value is string {
  return typeof value === "string" && /^[^/]+\/[^/]+$/.test(value);
}

function validSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function validAuthorizationBinding(value: unknown): value is ImplementProvenance["sourceAuthorization"] {
  if (!record(value)) return false;
  return (
    positiveInteger(value.runId) &&
    positiveInteger(value.runAttempt) &&
    positiveInteger(value.approvalCommentId) &&
    validDigest(value.policySnapshot) &&
    validDigest(value.requirementsDigest) &&
    validSha(value.authorizedBaseSha)
  );
}

function validAiExecution(value: unknown): value is ImplementProvenance["aiExecution"] {
  return (
    record(value) &&
    value.provider === "openai-codex-action" &&
    typeof value.resultId === "string" &&
    value.resultId.trim().length > 0
  );
}

function validReviewBinding(value: unknown, issueNumber: number): boolean {
  if (!record(value)) return false;
  return (
    typeof value.artifactName === "string" &&
    positiveInteger(value.runId) &&
    positiveInteger(value.runAttempt) &&
    value.reviewedBranch === `ai-publish/issue-${issueNumber}` &&
    validSha(value.reviewedHeadSha) &&
    typeof value.requirementsDigest === "string" &&
    /^(?:sha256:)?[0-9a-f]{64}$/.test(value.requirementsDigest) &&
    validDigest(value.findingsDigest)
  );
}

function validRequestBinding(value: unknown): boolean {
  if (!record(value)) return false;
  return (
    value.workflowPath === FIX_REQUEST_WORKFLOW_PATH &&
    positiveInteger(value.runId) &&
    positiveInteger(value.runAttempt) &&
    typeof value.artifactName === "string" &&
    validSha(value.trustedCodeSha)
  );
}

function validImplementProvenance(value: unknown): value is ImplementProvenance {
  if (!record(value) || !record(value.implementWorkflow)) return false;
  return (
    value.type === "IMPLEMENT" &&
    validRepository(value.repository) &&
    positiveInteger(value.issueNumber) &&
    validSha(value.baseSha) &&
    validAuthorizationBinding(value.sourceAuthorization) &&
    value.implementWorkflow.workflowPath === IMPLEMENT_WORKFLOW_PATH &&
    positiveInteger(value.implementWorkflow.runId) &&
    positiveInteger(value.implementWorkflow.runAttempt) &&
    validDigest(value.candidatePatchDigest) &&
    validAiExecution(value.aiExecution)
  );
}

function validFixProvenance(value: unknown): value is FixProvenance {
  if (
    !record(value) ||
    !record(value.fixWorkflow) ||
    !validReviewBinding(value.sourceReview, Number(value.issueNumber)) ||
    !validRequestBinding(value.sourceRequest)
  ) {
    return false;
  }
  const sourceReview = value.sourceReview as Record<string, unknown>;
  const sourceRequest = value.sourceRequest as Record<string, unknown>;
  const sourceAuthorization = record(value.sourceAuthorization) ? value.sourceAuthorization : undefined;
  const sourcePlanAuthorize = record(value.sourcePlanAuthorize) ? value.sourcePlanAuthorize : undefined;
  const hasLegacyAuthority = sourceAuthorization !== undefined;
  const hasPlanAuthority = sourcePlanAuthorize !== undefined;
  return (
    value.type === "FIX" &&
    validRepository(value.repository) &&
    positiveInteger(value.issueNumber) &&
    validSha(value.baseSha) &&
    (value.fixAttempt === 1 || value.fixAttempt === 2) &&
    hasLegacyAuthority !== hasPlanAuthority &&
    (!hasLegacyAuthority || validAuthorizationBinding(sourceAuthorization)) &&
    value.baseSha === sourceReview.reviewedHeadSha &&
    value.fixWorkflow.workflowPath === FIX_WORKFLOW_PATH &&
    positiveInteger(value.fixWorkflow.runId) &&
    positiveInteger(value.fixWorkflow.runAttempt) &&
    sourceRequest.artifactName ===
      `fix-request-${sourceReview.runId}-fix-${value.fixAttempt}-${sourceRequest.runId}-attempt-${sourceRequest.runAttempt}` &&
    validDigest(value.candidatePatchDigest) &&
    validAiExecution(value.aiExecution)
  );
}

function validateImplementArtifactName(
  artifactName: string,
  implement: ImplementProvenance,
): void {
  const match = /^implement-candidate-(\d+)-(\d+)-attempt-(\d+)$/.exec(artifactName);
  if (!match) throw new Error("IMPLEMENT candidate artifact 이름이 올바르지 않습니다");
  if (
    Number(match[1]) !== implement.sourceAuthorization.runId ||
    Number(match[2]) !== implement.implementWorkflow.runId ||
    Number(match[3]) !== implement.implementWorkflow.runAttempt
  ) {
    throw new Error("IMPLEMENT candidate artifact identity가 provenance와 일치하지 않습니다");
  }
}

function validateFixArtifactName(artifactName: string, fix: FixProvenance): void {
  const match = /^implement-candidate-(\d+)-(\d+)-attempt-(\d+)$/.exec(artifactName);
  if (!match) throw new Error("FIX candidate envelope 이름이 올바르지 않습니다");
  if (
    Number(match[1]) !== fix.sourceRequest.runId ||
    Number(match[2]) !== fix.fixWorkflow.runId ||
    Number(match[3]) !== fix.fixWorkflow.runAttempt
  ) {
    throw new Error("FIX candidate artifact identity가 provenance와 일치하지 않습니다");
  }
}

function validatePlanBridgeArtifactName(
  artifactName: string,
  bridge: PlanCandidateBridgeProvenance,
): void {
  const expected = planCandidateBridgeArtifactName({
    issueNumber: bridge.issueNumber,
    workerRunId: bridge.sourceWorker.runId,
    workerRunAttempt: bridge.sourceWorker.runAttempt,
    bridgeRunId: bridge.bridgeWorkflow.runId,
    bridgeRunAttempt: bridge.bridgeWorkflow.runAttempt,
  });
  if (artifactName !== expected) {
    throw new Error("PLAN bridge candidate artifact identity가 provenance와 일치하지 않습니다");
  }
}

function validatePatch(candidatePatch: string | Buffer, expectedDigest: string): void {
  const patchSize =
    typeof candidatePatch === "string"
      ? Buffer.byteLength(candidatePatch)
      : candidatePatch.length;
  if (patchSize === 0) throw new Error("candidate patch가 비어 있습니다");
  if (sha256(candidatePatch) !== expectedDigest) {
    throw new Error("candidate patch digest가 provenance와 일치하지 않습니다");
  }
}

function validateSourceRun(sourceRun: CandidateSourceRun, expectedPath: string): void {
  if (sourceRun.conclusion !== "success") throw new Error("candidate workflow가 성공하지 않았습니다");
  if (sourceRun.workflowPath !== expectedPath) throw new Error("candidate workflow path가 일치하지 않습니다");
  if (!validRepository(sourceRun.repository) || !validSha(sourceRun.controlPlaneSha)) {
    throw new Error("candidate source workflow identity가 올바르지 않습니다");
  }
  if (!positiveInteger(sourceRun.id) || !positiveInteger(sourceRun.runAttempt)) {
    throw new Error("candidate source run identity가 올바르지 않습니다");
  }
}

function validateSealRun(sealRun: SealRunIdentity): void {
  if (!positiveInteger(sealRun.runId) || !positiveInteger(sealRun.runAttempt)) {
    throw new Error("SEAL workflow identity가 올바르지 않습니다");
  }
  if (!validSha(sealRun.trustedCodeSha)) {
    throw new Error("SEAL trusted control-plane SHA가 올바르지 않습니다");
  }
}

export function validatePlanBridgeCandidateForSeal(
  bridgeValue: unknown,
  candidatePatch: string | Buffer,
  sourceRun: CandidateSourceRun,
): PlanCandidateBridgeProvenance {
  const bridge = verifyPlanCandidateBridgeProvenance(bridgeValue);
  validateSourceRun(sourceRun, PLAN_CANDIDATE_BRIDGE_WORKFLOW_PATH);
  if (bridge.repository !== sourceRun.repository) throw new Error("PLAN bridge repository가 일치하지 않습니다");
  if (
    bridge.bridgeWorkflow.runId !== sourceRun.id ||
    bridge.bridgeWorkflow.runAttempt !== sourceRun.runAttempt ||
    bridge.bridgeWorkflow.trustedCodeSha !== sourceRun.controlPlaneSha
  ) {
    throw new Error("PLAN bridge source run identity가 일치하지 않습니다");
  }
  validateBridgePatch(bridge, candidatePatch);
  return bridge;
}

export function validateImplementCandidateForSeal(
  implement: unknown,
  candidatePatch: string | Buffer,
  sourceRun: CandidateSourceRun,
): ImplementProvenance {
  if (!validImplementProvenance(implement)) {
    throw new Error("IMPLEMENT provenance가 올바르지 않습니다");
  }
  validateSourceRun(sourceRun, IMPLEMENT_WORKFLOW_PATH);
  if (implement.repository !== sourceRun.repository) throw new Error("repository가 일치하지 않습니다");
  if (implement.baseSha !== implement.sourceAuthorization.authorizedBaseSha) {
    throw new Error("IMPLEMENT base SHA가 AUTHORIZE provenance와 일치하지 않습니다");
  }
  if (
    implement.implementWorkflow.runId !== sourceRun.id ||
    implement.implementWorkflow.runAttempt !== sourceRun.runAttempt
  ) {
    throw new Error("IMPLEMENT source run identity가 일치하지 않습니다");
  }
  validatePatch(candidatePatch, implement.candidatePatchDigest);
  return implement;
}

export function validateFixCandidateForSeal(
  fix: unknown,
  candidatePatch: string | Buffer,
  sourceRun: CandidateSourceRun,
): FixProvenance {
  if (!validFixProvenance(fix)) throw new Error("FIX provenance가 올바르지 않습니다");
  validateSourceRun(sourceRun, FIX_WORKFLOW_PATH);
  if (fix.repository !== sourceRun.repository) throw new Error("repository가 일치하지 않습니다");
  if (fix.fixWorkflow.runId !== sourceRun.id || fix.fixWorkflow.runAttempt !== sourceRun.runAttempt) {
    throw new Error("FIX source run identity가 일치하지 않습니다");
  }
  validatePatch(candidatePatch, fix.candidatePatchDigest);
  return fix;
}

export function sealPlanBridgeCandidate(input: {
  readonly bridge: unknown;
  readonly candidatePatch: string | Buffer;
  readonly sourceRun: CandidateSourceRun;
  readonly sealRun: SealRunIdentity;
  readonly candidateArtifactName: string;
}): { readonly sealedPatch: Buffer; readonly provenance: SealProvenance } {
  const bridge = validatePlanBridgeCandidateForSeal(input.bridge, input.candidatePatch, input.sourceRun);
  validateSealRun(input.sealRun);
  validatePlanBridgeArtifactName(input.candidateArtifactName, bridge);
  const sealedPatch = Buffer.from(input.candidatePatch);
  const sealedPatchDigest = sha256(sealedPatch);
  if (sealedPatchDigest !== bridge.candidatePatchDigest) {
    throw new Error("sealed PLAN bridge patch digest가 candidate patch digest와 일치하지 않습니다");
  }

  return Object.freeze({
    sealedPatch,
    provenance: Object.freeze({
      type: "SEAL" as const,
      repository: bridge.repository,
      issueNumber: bridge.issueNumber,
      baseSha: bridge.baseSha,
      sourcePlanBridge: {
        workflowPath: PLAN_CANDIDATE_BRIDGE_WORKFLOW_PATH,
        runId: bridge.bridgeWorkflow.runId,
        runAttempt: bridge.bridgeWorkflow.runAttempt,
        controlPlaneSha: input.sourceRun.controlPlaneSha,
        candidateArtifactName: input.candidateArtifactName,
        bridge,
      },
      sealWorkflow: {
        workflowPath: TRUSTED_RAIL_WORKFLOW_PATH,
        runId: input.sealRun.runId,
        runAttempt: input.sealRun.runAttempt,
        trustedCodeSha: input.sealRun.trustedCodeSha,
      },
      sealedPatchDigest,
    }),
  });
}

export function sealImplementCandidate(input: {
  readonly implement: unknown;
  readonly candidatePatch: string | Buffer;
  readonly sourceRun: CandidateSourceRun;
  readonly sealRun: SealRunIdentity;
  readonly candidateArtifactName: string;
}): { readonly sealedPatch: Buffer; readonly provenance: SealProvenance } {
  const implement = validateImplementCandidateForSeal(
    input.implement,
    input.candidatePatch,
    input.sourceRun,
  );
  validateSealRun(input.sealRun);
  validateImplementArtifactName(input.candidateArtifactName, implement);
  const sealedPatch = Buffer.from(input.candidatePatch);
  const sealedPatchDigest = sha256(sealedPatch);
  if (sealedPatchDigest !== implement.candidatePatchDigest) {
    throw new Error("sealed patch digest가 candidate patch digest와 일치하지 않습니다");
  }

  return Object.freeze({
    sealedPatch,
    provenance: Object.freeze({
      type: "SEAL" as const,
      repository: implement.repository,
      issueNumber: implement.issueNumber,
      baseSha: implement.baseSha,
      sourceAuthorization: { ...implement.sourceAuthorization },
      sourceImplement: {
        workflowPath: IMPLEMENT_WORKFLOW_PATH,
        runId: implement.implementWorkflow.runId,
        runAttempt: implement.implementWorkflow.runAttempt,
        controlPlaneSha: input.sourceRun.controlPlaneSha,
        candidateArtifactName: input.candidateArtifactName,
        candidatePatchDigest: implement.candidatePatchDigest,
        aiExecution: { ...implement.aiExecution },
      },
      sealWorkflow: {
        workflowPath: TRUSTED_RAIL_WORKFLOW_PATH,
        runId: input.sealRun.runId,
        runAttempt: input.sealRun.runAttempt,
        trustedCodeSha: input.sealRun.trustedCodeSha,
      },
      sealedPatchDigest,
    }),
  });
}

export function sealFixCandidate(input: {
  readonly fix: unknown;
  readonly candidatePatch: string | Buffer;
  readonly sourceRun: CandidateSourceRun;
  readonly sealRun: SealRunIdentity;
  readonly candidateArtifactName: string;
}): { readonly sealedPatch: Buffer; readonly provenance: SealProvenance } {
  const fix = validateFixCandidateForSeal(input.fix, input.candidatePatch, input.sourceRun);
  validateSealRun(input.sealRun);
  validateFixArtifactName(input.candidateArtifactName, fix);
  const sealedPatch = Buffer.from(input.candidatePatch);
  const sealedPatchDigest = sha256(sealedPatch);
  if (sealedPatchDigest !== fix.candidatePatchDigest) {
    throw new Error("sealed FIX patch digest가 candidate patch digest와 일치하지 않습니다");
  }

  return Object.freeze({
    sealedPatch,
    provenance: Object.freeze({
      type: "SEAL" as const,
      repository: fix.repository,
      issueNumber: fix.issueNumber,
      baseSha: fix.baseSha,
      ...(fix.sourceAuthorization ? { sourceAuthorization: { ...fix.sourceAuthorization } } : {}),
      ...(fix.sourcePlanAuthorize ? {
        sourcePlanBridge: {
          ...fix.sourcePlanAuthorize.sourcePlanBridge,
          bridge: fix.sourcePlanAuthorize.sourcePlanBridge.bridge,
        },
      } : {}),
      sourceFix: {
        workflowPath: FIX_WORKFLOW_PATH,
        runId: fix.fixWorkflow.runId,
        runAttempt: fix.fixWorkflow.runAttempt,
        controlPlaneSha: input.sourceRun.controlPlaneSha,
        candidateArtifactName: input.candidateArtifactName,
        candidatePatchDigest: fix.candidatePatchDigest,
        fixAttempt: fix.fixAttempt,
        sourceReview: { ...fix.sourceReview },
        sourceRequest: { ...fix.sourceRequest },
        aiExecution: { ...fix.aiExecution },
      },
      sealWorkflow: {
        workflowPath: TRUSTED_RAIL_WORKFLOW_PATH,
        runId: input.sealRun.runId,
        runAttempt: input.sealRun.runAttempt,
        trustedCodeSha: input.sealRun.trustedCodeSha,
      },
      sealedPatchDigest,
    }),
  });
}

export function validateSealProvenance(value: unknown): SealProvenance {
  if (!record(value) || !record(value.sealWorkflow)) {
    throw new Error("SEAL provenance가 올바르지 않습니다");
  }
  if (
    value.type !== "SEAL" ||
    !validRepository(value.repository) ||
    !positiveInteger(value.issueNumber) ||
    !validSha(value.baseSha) ||
    value.sealWorkflow.workflowPath !== TRUSTED_RAIL_WORKFLOW_PATH ||
    !positiveInteger(value.sealWorkflow.runId) ||
    !positiveInteger(value.sealWorkflow.runAttempt) ||
    !validSha(value.sealWorkflow.trustedCodeSha) ||
    !validDigest(value.sealedPatchDigest)
  ) {
    throw new Error("SEAL provenance가 올바르지 않습니다");
  }

  const hasPlanBridge = record(value.sourcePlanBridge);
  const hasImplement = record(value.sourceImplement);
  const hasFix = record(value.sourceFix);
  if (
    (hasImplement && (hasPlanBridge || hasFix)) ||
    (!hasPlanBridge && !hasImplement && !hasFix)
  ) {
    throw new Error("SEAL provenance source 조합이 올바르지 않습니다");
  }

  if (hasPlanBridge && !hasFix) {
    if (value.sourceAuthorization !== undefined) {
      throw new Error("PLAN bridge SEAL은 legacy authorization을 포함할 수 없습니다");
    }
    const source = value.sourcePlanBridge as Record<string, unknown>;
    if (
      source.workflowPath !== PLAN_CANDIDATE_BRIDGE_WORKFLOW_PATH ||
      !positiveInteger(source.runId) ||
      !positiveInteger(source.runAttempt) ||
      !validSha(source.controlPlaneSha) ||
      typeof source.candidateArtifactName !== "string" ||
      !record(source.bridge)
    ) {
      throw new Error("SEAL PLAN bridge source가 올바르지 않습니다");
    }
    const bridge = verifyPlanCandidateBridgeProvenance(source.bridge);
    validatePlanBridgeArtifactName(source.candidateArtifactName, bridge);
    if (
      bridge.repository !== value.repository ||
      bridge.issueNumber !== value.issueNumber ||
      bridge.baseSha !== value.baseSha ||
      bridge.bridgeWorkflow.runId !== source.runId ||
      bridge.bridgeWorkflow.runAttempt !== source.runAttempt ||
      bridge.bridgeWorkflow.trustedCodeSha !== source.controlPlaneSha ||
      bridge.candidatePatchDigest !== value.sealedPatchDigest
    ) {
      throw new Error("SEAL PLAN bridge provenance chain이 올바르지 않습니다");
    }
  } else if (hasImplement) {
    if (!validAuthorizationBinding(value.sourceAuthorization)) {
      throw new Error("SEAL IMPLEMENT authorization이 올바르지 않습니다");
    }
    const source = value.sourceImplement as Record<string, unknown>;
    if (
      source.workflowPath !== IMPLEMENT_WORKFLOW_PATH ||
      !positiveInteger(source.runId) ||
      !positiveInteger(source.runAttempt) ||
      !validSha(source.controlPlaneSha) ||
      typeof source.candidateArtifactName !== "string" ||
      !validDigest(source.candidatePatchDigest) ||
      !validAiExecution(source.aiExecution) ||
      source.candidatePatchDigest !== value.sealedPatchDigest ||
      value.baseSha !== value.sourceAuthorization.authorizedBaseSha
    ) {
      throw new Error("SEAL IMPLEMENT source가 올바르지 않습니다");
    }
  } else {
    const source = value.sourceFix as Record<string, unknown>;
    const sourceAuthorization = value.sourceAuthorization;
    const hasLegacyAuthority = validAuthorizationBinding(sourceAuthorization);
    const hasPlanAuthority = hasPlanBridge;
    if (hasLegacyAuthority === hasPlanAuthority) {
      throw new Error("SEAL FIX authority가 올바르지 않습니다");
    }

    let planBridge: PlanCandidateBridgeProvenance | undefined;
    if (hasPlanAuthority) {
      const planSource = value.sourcePlanBridge as Record<string, unknown>;
      if (
        planSource.workflowPath !== PLAN_CANDIDATE_BRIDGE_WORKFLOW_PATH ||
        !positiveInteger(planSource.runId) ||
        !positiveInteger(planSource.runAttempt) ||
        !validSha(planSource.controlPlaneSha) ||
        typeof planSource.candidateArtifactName !== "string" ||
        !record(planSource.bridge)
      ) {
        throw new Error("SEAL PLAN FIX authority source가 올바르지 않습니다");
      }
      planBridge = verifyPlanCandidateBridgeProvenance(planSource.bridge);
      validatePlanBridgeArtifactName(planSource.candidateArtifactName, planBridge);
      if (
        planBridge.repository !== value.repository ||
        planBridge.issueNumber !== value.issueNumber ||
        planBridge.bridgeWorkflow.runId !== planSource.runId ||
        planBridge.bridgeWorkflow.runAttempt !== planSource.runAttempt ||
        planBridge.bridgeWorkflow.trustedCodeSha !== planSource.controlPlaneSha
      ) {
        throw new Error("SEAL PLAN FIX authority chain이 올바르지 않습니다");
      }
    }

    if (
      source.workflowPath !== FIX_WORKFLOW_PATH ||
      !positiveInteger(source.runId) ||
      !positiveInteger(source.runAttempt) ||
      !validSha(source.controlPlaneSha) ||
      typeof source.candidateArtifactName !== "string" ||
      !validDigest(source.candidatePatchDigest) ||
      !(source.fixAttempt === 1 || source.fixAttempt === 2) ||
      !validReviewBinding(source.sourceReview, value.issueNumber as number) ||
      !validRequestBinding(source.sourceRequest) ||
      !validAiExecution(source.aiExecution) ||
      source.candidatePatchDigest !== value.sealedPatchDigest
    ) {
      throw new Error("SEAL FIX source가 올바르지 않습니다");
    }
    const sourceReview = source.sourceReview as Record<string, unknown>;
    const sourceRequest = source.sourceRequest as Record<string, unknown>;
    if (
      sourceReview.reviewedHeadSha !== value.baseSha ||
      (hasLegacyAuthority &&
        sourceReview.requirementsDigest !== sourceAuthorization.requirementsDigest) ||
      (planBridge !== undefined &&
        sourceReview.requirementsDigest !== planBridge.requirement.digest) ||
      sourceRequest.artifactName !==
        `fix-request-${sourceReview.runId}-fix-${source.fixAttempt}-${sourceRequest.runId}-attempt-${sourceRequest.runAttempt}`
    ) {
      throw new Error("SEAL FIX provenance chain이 올바르지 않습니다");
    }
  }

  return value as unknown as SealProvenance;
}

export function sealSourceRunIdentity(seal: SealProvenance): {
  readonly runId: number;
  readonly runAttempt: number;
  readonly candidatePatchDigest: string;
} {
  if (seal.sourceFix) {
    return {
      runId: seal.sourceFix.runId,
      runAttempt: seal.sourceFix.runAttempt,
      candidatePatchDigest: seal.sourceFix.candidatePatchDigest,
    };
  }
  if (seal.sourcePlanBridge) {
    return {
      runId: seal.sourcePlanBridge.runId,
      runAttempt: seal.sourcePlanBridge.runAttempt,
      candidatePatchDigest: seal.sourcePlanBridge.bridge.candidatePatchDigest,
    };
  }
  if (seal.sourceImplement) {
    return {
      runId: seal.sourceImplement.runId,
      runAttempt: seal.sourceImplement.runAttempt,
      candidatePatchDigest: seal.sourceImplement.candidatePatchDigest,
    };
  }
  throw new Error("SEAL source가 없습니다");
}
