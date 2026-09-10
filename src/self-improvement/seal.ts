import type { ImplementProvenance } from "./implement.js";
import { IMPLEMENT_WORKFLOW_PATH, sha256 } from "./implement.js";
import { FIX_WORKFLOW_PATH, type FixProvenance } from "./fix.js";

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
  readonly sourceAuthorization: ImplementProvenance["sourceAuthorization"];
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
  if (!record(value) || !record(value.sourceReview) || !record(value.fixWorkflow)) return false;
  const fixAttempt = value.fixAttempt;
  return (
    value.type === "FIX" &&
    validRepository(value.repository) &&
    positiveInteger(value.issueNumber) &&
    validSha(value.baseSha) &&
    (fixAttempt === 1 || fixAttempt === 2) &&
    validAuthorizationBinding(value.sourceAuthorization) &&
    typeof value.sourceReview.artifactName === "string" &&
    positiveInteger(value.sourceReview.runId) &&
    positiveInteger(value.sourceReview.runAttempt) &&
    value.sourceReview.reviewedBranch === `ai-publish/issue-${String(value.issueNumber)}` &&
    validSha(value.sourceReview.reviewedHeadSha) &&
    validDigest(value.sourceReview.requirementsDigest) &&
    validDigest(value.sourceReview.findingsDigest) &&
    value.baseSha === value.sourceReview.reviewedHeadSha &&
    value.sourceReview.requirementsDigest === value.sourceAuthorization.requirementsDigest &&
    value.fixWorkflow.workflowPath === FIX_WORKFLOW_PATH &&
    positiveInteger(value.fixWorkflow.runId) &&
    positiveInteger(value.fixWorkflow.runAttempt) &&
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
  const match = /^fix-candidate-(\d+)-fix-([12])-(\d+)-attempt-(\d+)$/.exec(artifactName);
  if (!match) throw new Error("FIX candidate artifact 이름이 올바르지 않습니다");
  if (
    Number(match[1]) !== fix.sourceReview.runId ||
    Number(match[2]) !== fix.fixAttempt ||
    Number(match[3]) !== fix.fixWorkflow.runId ||
    Number(match[4]) !== fix.fixWorkflow.runAttempt
  ) {
    throw new Error("FIX candidate artifact identity가 provenance와 일치하지 않습니다");
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
      sourceAuthorization: { ...fix.sourceAuthorization },
      sourceFix: {
        workflowPath: FIX_WORKFLOW_PATH,
        runId: fix.fixWorkflow.runId,
        runAttempt: fix.fixWorkflow.runAttempt,
        controlPlaneSha: input.sourceRun.controlPlaneSha,
        candidateArtifactName: input.candidateArtifactName,
        candidatePatchDigest: fix.candidatePatchDigest,
        fixAttempt: fix.fixAttempt,
        sourceReview: { ...fix.sourceReview },
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
  if (!record(value) || !record(value.sealWorkflow) || !validAuthorizationBinding(value.sourceAuthorization)) {
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

  const hasImplement = record(value.sourceImplement);
  const hasFix = record(value.sourceFix);
  if (hasImplement === hasFix) {
    throw new Error("SEAL provenance에는 IMPLEMENT 또는 FIX source 하나만 있어야 합니다");
  }

  if (hasImplement) {
    const source = value.sourceImplement!;
    if (
      source.workflowPath !== IMPLEMENT_WORKFLOW_PATH ||
      !positiveInteger(source.runId) ||
      !positiveInteger(source.runAttempt) ||
      !validSha(source.controlPlaneSha) ||
      typeof source.candidateArtifactName !== "string" ||
      !validDigest(source.candidatePatchDigest) ||
      !validAiExecution(source.aiExecution) ||
      source.candidatePatchDigest !== value.sealedPatchDigest ||
      value.baseSha !== (value.sourceAuthorization as Record<string, unknown>).authorizedBaseSha
    ) {
      throw new Error("SEAL IMPLEMENT source가 올바르지 않습니다");
    }
  } else {
    const source = value.sourceFix!;
    if (
      source.workflowPath !== FIX_WORKFLOW_PATH ||
      !positiveInteger(source.runId) ||
      !positiveInteger(source.runAttempt) ||
      !validSha(source.controlPlaneSha) ||
      typeof source.candidateArtifactName !== "string" ||
      !validDigest(source.candidatePatchDigest) ||
      !(source.fixAttempt === 1 || source.fixAttempt === 2) ||
      !record(source.sourceReview) ||
      typeof source.sourceReview.artifactName !== "string" ||
      !positiveInteger(source.sourceReview.runId) ||
      !positiveInteger(source.sourceReview.runAttempt) ||
      source.sourceReview.reviewedBranch !== `ai-publish/issue-${String(value.issueNumber)}` ||
      !validSha(source.sourceReview.reviewedHeadSha) ||
      !validDigest(source.sourceReview.requirementsDigest) ||
      !validDigest(source.sourceReview.findingsDigest) ||
      !validAiExecution(source.aiExecution) ||
      source.candidatePatchDigest !== value.sealedPatchDigest ||
      source.sourceReview.reviewedHeadSha !== value.baseSha ||
      source.sourceReview.requirementsDigest !== (value.sourceAuthorization as Record<string, unknown>).requirementsDigest
    ) {
      throw new Error("SEAL FIX source가 올바르지 않습니다");
    }
  }

  return value as unknown as SealProvenance;
}

export function sealSourceRunIdentity(seal: SealProvenance): {
  readonly runId: number;
  readonly runAttempt: number;
  readonly candidatePatchDigest: string;
} {
  if (seal.sourceImplement) {
    return {
      runId: seal.sourceImplement.runId,
      runAttempt: seal.sourceImplement.runAttempt,
      candidatePatchDigest: seal.sourceImplement.candidatePatchDigest,
    };
  }
  if (seal.sourceFix) {
    return {
      runId: seal.sourceFix.runId,
      runAttempt: seal.sourceFix.runAttempt,
      candidatePatchDigest: seal.sourceFix.candidatePatchDigest,
    };
  }
  throw new Error("SEAL source가 없습니다");
}
