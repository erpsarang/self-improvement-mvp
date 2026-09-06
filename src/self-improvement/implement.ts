import { createHash } from "node:crypto";
import type { AuthorizationProvenance } from "./authorization.js";

export const AUTHORIZE_WORKFLOW_PATH = ".github/workflows/authorize.yml" as const;
export const IMPLEMENT_WORKFLOW_PATH = ".github/workflows/implement.yml" as const;

export interface SourceWorkflowRun {
  readonly id: number;
  readonly runAttempt: number;
  readonly headSha: string;
  readonly repository: string;
  readonly conclusion: string;
}

export interface ImplementRunIdentity {
  readonly runId: number;
  readonly runAttempt: number;
}

export interface ImplementProvenance {
  readonly type: "IMPLEMENT";
  readonly repository: string;
  readonly issueNumber: number;
  readonly baseSha: string;
  readonly sourceAuthorization: {
    readonly runId: number;
    readonly runAttempt: number;
    readonly approvalCommentId: number;
    readonly policySnapshot: string;
  };
  readonly implementWorkflow: {
    readonly workflowPath: typeof IMPLEMENT_WORKFLOW_PATH;
    readonly runId: number;
    readonly runAttempt: number;
  };
  readonly candidatePatchDigest: string;
  readonly aiExecution: {
    readonly provider: "openai-codex-action";
    readonly resultId: string;
  };
}

function positiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function validRepository(value: string): boolean {
  return /^[^/]+\/[^/]+$/.test(value);
}

function validSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

function validDigest(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}

export function validateAuthorizationForImplement(
  authorization: AuthorizationProvenance,
  sourceRun: SourceWorkflowRun,
): AuthorizationProvenance {
  if (!authorization || typeof authorization !== "object") throw new Error("AUTHORIZE provenance가 없습니다");
  if (sourceRun.conclusion !== "success") throw new Error("AUTHORIZE workflow가 성공하지 않았습니다");
  if (authorization.type !== "AUTHORIZE") throw new Error("AUTHORIZE provenance가 아닙니다");
  if (!positiveInteger(authorization.issueNumber) || !positiveInteger(authorization.approvalCommentId) ||
      !positiveInteger(authorization.approverId) || !positiveInteger(authorization.policyVersion)) {
    throw new Error("AUTHORIZE provenance identity가 올바르지 않습니다");
  }
  if (authorization.approvalCommand !== "SI-승인") throw new Error("승인 명령이 올바르지 않습니다");
  if (!validDigest(authorization.policySnapshot)) throw new Error("policy snapshot이 올바르지 않습니다");
  if (!Number.isFinite(Date.parse(authorization.approvedAt))) throw new Error("승인 시각이 올바르지 않습니다");
  if (!validRepository(authorization.repository) || !validSha(authorization.githubSha) ||
      !positiveInteger(authorization.runId) || !positiveInteger(authorization.runAttempt)) {
    throw new Error("AUTHORIZE workflow identity가 올바르지 않습니다");
  }
  if (authorization.repository !== sourceRun.repository) throw new Error("repository가 일치하지 않습니다");
  if (authorization.workflowPath !== AUTHORIZE_WORKFLOW_PATH) throw new Error("AUTHORIZE workflow path가 일치하지 않습니다");
  if (authorization.runId !== sourceRun.id) throw new Error("AUTHORIZE run ID가 일치하지 않습니다");
  if (authorization.runAttempt !== sourceRun.runAttempt) throw new Error("AUTHORIZE run attempt가 일치하지 않습니다");
  if (authorization.githubSha !== sourceRun.headSha) throw new Error("AUTHORIZE SHA가 일치하지 않습니다");
  return authorization;
}

export function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function createImplementProvenance(input: {
  readonly authorization: AuthorizationProvenance;
  readonly implementRun: ImplementRunIdentity;
  readonly candidatePatch: string | Buffer;
  readonly aiResultId: string;
}): ImplementProvenance {
  if (!input.aiResultId.trim()) throw new Error("AI 실행 결과 식별자가 필요합니다");
  if (!positiveInteger(input.implementRun.runId) || !positiveInteger(input.implementRun.runAttempt)) {
    throw new Error("IMPLEMENT workflow identity가 올바르지 않습니다");
  }
  const patchSize = typeof input.candidatePatch === "string" ? Buffer.byteLength(input.candidatePatch) : input.candidatePatch.length;
  if (patchSize === 0) throw new Error("candidate patch가 비어 있습니다");

  return Object.freeze({
    type: "IMPLEMENT" as const,
    repository: input.authorization.repository,
    issueNumber: input.authorization.issueNumber,
    baseSha: input.authorization.githubSha,
    sourceAuthorization: {
      runId: input.authorization.runId,
      runAttempt: input.authorization.runAttempt,
      approvalCommentId: input.authorization.approvalCommentId,
      policySnapshot: input.authorization.policySnapshot,
    },
    implementWorkflow: {
      workflowPath: IMPLEMENT_WORKFLOW_PATH,
      runId: input.implementRun.runId,
      runAttempt: input.implementRun.runAttempt,
    },
    candidatePatchDigest: sha256(input.candidatePatch),
    aiExecution: {
      provider: "openai-codex-action" as const,
      resultId: input.aiResultId,
    },
  });
}
