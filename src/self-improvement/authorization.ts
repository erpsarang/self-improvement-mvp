export const APPROVAL_COMMAND = "SI-승인" as const;

export interface TrustedApproverPolicy {
  readonly version: number;
  readonly approvers: readonly string[];
}

export interface AuthorizationRequest {
  readonly approver: string;
  readonly command: string;
  readonly approvedAt: string;
}

export interface AuthorizationProvenance {
  readonly approver: string;
  readonly policyVersion: number;
  readonly approvedAt: string;
}

/** 버전 관리되는 policy를 기준으로 Human 승인을 검증하고 provenance를 만든다. */
export function authorize(
  request: AuthorizationRequest,
  policy: TrustedApproverPolicy,
): AuthorizationProvenance {
  if (!Number.isInteger(policy.version) || policy.version < 1) {
    throw new Error("trusted approver policy version은 양의 정수여야 합니다");
  }
  if (request.command.trim() !== APPROVAL_COMMAND) {
    throw new Error(`승인 명령은 ${APPROVAL_COMMAND}이어야 합니다`);
  }
  if (!policy.approvers.includes(request.approver)) {
    throw new Error("trusted approver가 아닙니다");
  }
  if (Number.isNaN(Date.parse(request.approvedAt))) {
    throw new Error("approvedAt은 유효한 날짜여야 합니다");
  }

  return Object.freeze({
    approver: request.approver,
    policyVersion: policy.version,
    approvedAt: request.approvedAt,
  });
}
