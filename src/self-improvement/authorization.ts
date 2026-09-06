import { createHash } from "node:crypto";

export const APPROVAL_COMMAND = "SI-승인" as const;

export interface TrustedApproverPolicy {
  readonly version: number;
  readonly approvers: readonly string[];
}

export interface AuthorizationRequest {
  readonly issueNumber: number;
  readonly approvalCommentId: number;
  readonly approver: string;
  readonly command: string;
  readonly approvedAt: string;
}

export interface AuthorizationProvenance {
  readonly type: "AUTHORIZE";
  readonly issueNumber: number;
  readonly approvalCommentId: number;
  readonly approver: string;
  readonly policyVersion: number;
  readonly policySnapshot: string;
  readonly approvedAt: string;
  readonly approvalCommand: typeof APPROVAL_COMMAND;
}

/** The digest binds provenance to the exact policy data used for authorization. */
export function policySnapshot(policy: TrustedApproverPolicy): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify({ version: policy.version, approvers: policy.approvers }))
    .digest("hex")}`;
}

const RFC3339_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

function isValidTimestamp(value: string): boolean {
  const match = RFC3339_TIMESTAMP.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[7] ?? 0);
  const offsetMinute = Number(match[8] ?? 0);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];

  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= (daysInMonth[month - 1] ?? 0) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

/** 버전 관리되는 policy를 기준으로 Human 승인을 검증하고 provenance를 만든다. */
export function authorize(
  request: AuthorizationRequest,
  policy: TrustedApproverPolicy,
): AuthorizationProvenance {
  if (!Number.isInteger(policy.version) || policy.version < 1) {
    throw new Error("trusted approver policy version은 양의 정수여야 합니다");
  }
  if (request.command !== APPROVAL_COMMAND) {
    throw new Error(`승인 명령은 ${APPROVAL_COMMAND}이어야 합니다`);
  }
  if (!policy.approvers.includes(request.approver)) {
    throw new Error("trusted approver가 아닙니다");
  }
  if (!isValidTimestamp(request.approvedAt)) {
    throw new Error("approvedAt은 유효한 날짜여야 합니다");
  }

  return Object.freeze({
    type: "AUTHORIZE" as const,
    issueNumber: request.issueNumber,
    approvalCommentId: request.approvalCommentId,
    approver: request.approver,
    policyVersion: policy.version,
    policySnapshot: policySnapshot(policy),
    approvedAt: request.approvedAt,
    approvalCommand: APPROVAL_COMMAND,
  });
}
