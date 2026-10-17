// Read-only AI PLAN이 실패한 뒤 사람이 Actions에서 같은 Issue 번호를 다시 치던 클릭을 trusted 분류로 대체한다.
// 관측(App transportation_guide 4사이클): PLAN 수동 재실행 6회, 실패 뒤 재실행까지 4~16분 대기, 재실행 전 본문 수정 0회.
// 자동 재시도 대상은 닫힌 목록이고 기본값은 STOP이다. 사유 텍스트는 분류 코드로만 남기며 어떤 prompt에도 넣지 않는다.

const SHA256 = /^[0-9a-f]{64}$/;

export const MAX_AUTO_PLAN_RETRY_PER_REQUIREMENT = 2 as const;

export type PlanFailureCode =
  | "EXECUTOR_EXECUTION_FAILED"
  | "EXECUTOR_REQUEST_REJECTED"
  | "EXECUTOR_RESULT_POST_FAILED"
  | "PLAN_PATH_NOTATION_REJECTED"
  | "PLAN_SCOPE_TOO_LARGE"
  | "PLAN_VALIDATION_REJECTED"
  | "PLAN_RESULT_TIMEOUT"
  | "PLAN_REQUEST_FAILED"
  | "UNKNOWN";

// 같은 입력으로 다시 불러 결과가 달라질 근거가 관측된 코드만 넣는다.
// EXECUTOR_EXECUTION_FAILED: App #2 run 38981512927, #7 run 38992157914 — 사람이 본문을 바꾸지 않고 재실행해 2/2 성공.
// PLAN_PATH_NOTATION_REJECTED(#395, #396)는 같은 입력 재실행이 같은 모양으로 실패했고 validator 수정 뒤에야 통과했으므로 넣지 않는다.
const RETRYABLE_CODES: ReadonlySet<PlanFailureCode> = new Set<PlanFailureCode>(["EXECUTOR_EXECUTION_FAILED"]);

const EXECUTOR_FAILURE_CODES: Readonly<Record<string, PlanFailureCode>> = {
  EXECUTION_FAILED: "EXECUTOR_EXECUTION_FAILED",
  REQUEST_REJECTED: "EXECUTOR_REQUEST_REJECTED",
  RESULT_POST_FAILED: "EXECUTOR_RESULT_POST_FAILED",
};

export interface PlanFailureObservation {
  /** resolve job이 exact PLAN_FAILED marker에서 읽은 executor 사유. 없으면 빈 문자열. */
  readonly executorFailureReason: string;
  /** resolve job의 trusted 검증이 남긴 첫 `Error:` 줄(300자). 없으면 빈 문자열. */
  readonly validationFailureReason: string;
  /** resolve job의 wait step이 PLAN_RESULT를 기다리다 끝났으면 "true". */
  readonly resultTimedOut: string;
  /** `needs.request.result` */
  readonly requestResult: string;
  /** `needs.resolve.result` */
  readonly resolveResult: string;
}

export interface PlanFailureClassification {
  readonly code: PlanFailureCode;
  readonly retryable: boolean;
}

export function classifyPlanFailure(observation: PlanFailureObservation): PlanFailureClassification {
  const code = failureCode(observation);
  return { code, retryable: RETRYABLE_CODES.has(code) };
}

function failureCode(observation: PlanFailureObservation): PlanFailureCode {
  if (observation.requestResult === "failure") return "PLAN_REQUEST_FAILED";
  if (observation.resolveResult !== "failure") return "UNKNOWN";

  const executorReason = observation.executorFailureReason.trim();
  if (executorReason) return EXECUTOR_FAILURE_CODES[executorReason] ?? "UNKNOWN";

  const validationReason = observation.validationFailureReason.trim();
  if (validationReason) {
    if (/PLAN references exact path outside bounded implementation scope/.test(validationReason)) return "PLAN_PATH_NOTATION_REJECTED";
    if (/PLAN scope cannot hold existing tests/.test(validationReason)) return "PLAN_SCOPE_TOO_LARGE";
    return "PLAN_VALIDATION_REJECTED";
  }

  if (observation.resultTimedOut === "true") return "PLAN_RESULT_TIMEOUT";
  return "UNKNOWN";
}

export interface PlanRetryRecord {
  readonly attempt: number;
  readonly code: PlanFailureCode;
  readonly sourceRunId: number;
  readonly sourceRunAttempt: number;
}

export interface PlanRetryKey {
  readonly issueNumber: number;
  readonly requirementDigest: string;
}

function validKey(key: PlanRetryKey): void {
  if (!Number.isSafeInteger(key.issueNumber) || key.issueNumber < 1) throw new Error("issue number is invalid");
  if (!SHA256.test(key.requirementDigest)) throw new Error("requirement digest is invalid");
}

function positiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
}

/** 예산 키는 (Issue, requirement digest)다. 본문이 바뀌면 입력이 바뀐 것이므로 예산도 새로 센다. */
export function planRetryMarkerPrefix(key: PlanRetryKey): string {
  validKey(key);
  return `<!-- self-improvement:AUTO_PLAN_RETRY issue=${key.issueNumber} requirement=${key.requirementDigest}`;
}

export function planRetryMarker(key: PlanRetryKey, record: PlanRetryRecord): string {
  positiveInteger("retry attempt", record.attempt);
  positiveInteger("source run id", record.sourceRunId);
  positiveInteger("source run attempt", record.sourceRunAttempt);
  return `${planRetryMarkerPrefix(key)} attempt=${record.attempt} code=${record.code} source-run=${record.sourceRunId} source-attempt=${record.sourceRunAttempt} -->`;
}

export function planRetryStopMarker(key: PlanRetryKey): string {
  validKey(key);
  return `<!-- self-improvement:AUTO_PLAN_RETRY_STOP issue=${key.issueNumber} requirement=${key.requirementDigest} -->`;
}

const RECORD_PATTERN = /^<!-- self-improvement:AUTO_PLAN_RETRY issue=([1-9]\d*) requirement=([0-9a-f]{64}) attempt=([1-9]\d*) code=([A-Z_]+) source-run=([1-9]\d*) source-attempt=([1-9]\d*) -->$/m;

/** trusted bot 댓글 본문에서만 읽는다. 호출자가 작성자 필터를 먼저 건다. */
export function parsePlanRetryRecords(commentBodies: readonly string[], key: PlanRetryKey): readonly PlanRetryRecord[] {
  const prefix = planRetryMarkerPrefix(key);
  const records: PlanRetryRecord[] = [];
  for (const rawBody of commentBodies) {
    if (!rawBody.includes(prefix)) continue;
    // 웹에서 편집된 댓글은 CRLF로 돌아올 수 있다. 줄 끝 CR 때문에 기록을 놓치면 예산을 적게 세므로 먼저 지운다.
    const body = rawBody.replace(/\r/g, "");
    const match = RECORD_PATTERN.exec(body);
    if (!match) continue;
    if (Number(match[1]) !== key.issueNumber || match[2] !== key.requirementDigest) continue;
    records.push({
      attempt: Number(match[3]),
      code: match[4] as PlanFailureCode,
      sourceRunId: Number(match[5]),
      sourceRunAttempt: Number(match[6]),
    });
  }
  return records;
}

export type PlanRetryOutcome =
  | "RETRY"
  | "DISABLED"
  | "NOT_RETRYABLE"
  | "ALREADY_DISPATCHED"
  | "SAME_CODE_REPEATED"
  | "BUDGET_EXHAUSTED";

export interface PlanRetryDecision {
  readonly outcome: PlanRetryOutcome;
  readonly attempt: number;
}

export function decidePlanRetry(input: {
  readonly enabled: boolean;
  readonly classification: PlanFailureClassification;
  readonly priorRecords: readonly PlanRetryRecord[];
  readonly sourceRunId: number;
}): PlanRetryDecision {
  const attempt = input.priorRecords.length + 1;
  if (!input.enabled) return { outcome: "DISABLED", attempt };
  if (!input.classification.retryable) return { outcome: "NOT_RETRYABLE", attempt };
  // 같은 실패 run의 auto_retry job 재실행은 두 번 dispatch하지 않는다.
  if (input.priorRecords.some((record) => record.sourceRunId === input.sourceRunId)) {
    return { outcome: "ALREADY_DISPATCHED", attempt };
  }
  if (input.priorRecords.length >= MAX_AUTO_PLAN_RETRY_PER_REQUIREMENT) return { outcome: "BUDGET_EXHAUSTED", attempt };
  // 같은 사유가 두 번이면 입력이 아니라 프레임워크·executor 쪽 결함이 의심되므로 멈춘다.
  if (input.priorRecords.some((record) => record.code === input.classification.code)) {
    return { outcome: "SAME_CODE_REPEATED", attempt };
  }
  return { outcome: "RETRY", attempt };
}
