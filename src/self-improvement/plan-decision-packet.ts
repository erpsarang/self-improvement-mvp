import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { validateApprovedPlanDocument, type ApprovedPlanDocument } from "./plan-implement-handoff.js";

/**
 * PLAN Human Gate에서 사람이 AI 도움 없이 "이 계획으로 이 문제를 해결하도록 허용해도 되는가"를
 * 판단하는 데 필요한 재료를 만든다.
 *
 * 두 가지 책임만 가진다.
 * 1. trusted validation을 통과한 PLAN 문서에서 사람이 읽을 발췌(Decision Packet)를 결정적으로 렌더링한다.
 * 2. PLAN_AUTHORIZE가 승인을 거부할 때 사람에게 보여 줄 이유와 다음 행동을 만든다.
 *
 * 이 모듈의 출력은 표시용이다. 승인 authority는 계속 exact PLAN artifact / provenance 재검증에 있으며,
 * 여기서 만든 문자열을 승인, 검증, 리뷰 또는 병합 판단의 입력으로 사용하지 않는다.
 * AI 호출은 없다.
 */

export interface PlanDecisionScope {
  readonly ready: boolean;
  readonly allowedPaths: readonly string[];
  readonly requiredChanges: readonly string[];
  readonly forbiddenChanges: readonly string[];
  readonly validationCommands: readonly string[];
}

export interface PlanDecisionInput {
  readonly summary: string;
  readonly acceptanceCriteria: readonly string[];
  readonly testStrategy: readonly string[];
  readonly questions: readonly string[];
  readonly implementationScope: PlanDecisionScope;
}

/** GitHub Issue 댓글 한도(65,536자) 안에서 provenance 줄과 HumanStatus가 함께 들어갈 여유를 남긴다. */
export const PLAN_DECISION_PACKET_MAX_BYTES = 24_000;

export const PLAN_DECISION_PACKET_HEADING = "### PLAN Decision Packet";

const APPROVE_INSTRUCTION = "승인: 이 Issue에 정확히 `PLAN-승인` 댓글을 남깁니다. (ready=true이고 Blocking Question이 없을 때만 통과합니다)";
const REJECT_INSTRUCTION = "기각: 사유를 댓글로 남기고 Issue를 `not_planned`로 닫습니다.";
const REPLAN_INSTRUCTION = "요구사항 보완 후 재PLAN: Issue 본문을 보완한 뒤 Actions → Read-only AI PLAN을 이 Issue 번호로 다시 실행합니다.";
const DISPLAY_ONLY_NOTE = "이 Packet은 trusted validation을 통과한 PLAN artifact의 사람용 발췌입니다. 승인 시 exact PLAN artifact와 provenance를 다시 검증하며, 이 댓글 자체는 authority가 아닙니다.";

export function isPlanApprovable(plan: PlanDecisionInput): boolean {
  return plan.implementationScope.ready === true && plan.questions.length === 0;
}

function oneLine(value: string): string {
  return value.replace(/\s*\r?\n\s*/g, " ").trim();
}

function bullets(items: readonly string[], empty: string): string {
  if (items.length === 0) return `- ${empty}`;
  return items.map((item) => `- ${oneLine(item)}`).join("\n");
}

function numbered(items: readonly string[]): string {
  return items.map((item, index) => `${index + 1}. ${oneLine(item)}`).join("\n");
}

function codeList(items: readonly string[], empty: string): string {
  if (items.length === 0) return `- ${empty}`;
  return items.map((item) => `- \`${item}\``).join("\n");
}

interface PacketSection {
  readonly key: string;
  readonly text: string;
  /** 크기 상한 초과 시 생략 가능한 섹션의 우선순위. 낮을수록 먼저 생략한다. 없으면 항상 유지한다. */
  readonly dropOrder?: number;
}

/**
 * 사람이 PLAN 승인 여부를 판단하는 데 필요한 항목을 markdown으로 렌더링한다.
 * 입력은 planner.ts validatePlan을 통과한 PLAN 문서여야 한다. 크기 상한을 넘으면 문장을 자르지 않고
 * 섹션 단위로 생략하며, ready/Blocking Question/변경 파일/검증 명령/선택지는 항상 남긴다.
 */
export function renderPlanDecisionPacket(plan: PlanDecisionInput, options: { maxBytes?: number } = {}): string {
  const maxBytes = options.maxBytes ?? PLAN_DECISION_PACKET_MAX_BYTES;
  const scope = plan.implementationScope;
  const approvable = isPlanApprovable(plan);
  const notReadyReason = scope.ready
    ? "Blocking Question이 남아 있습니다."
    : "AI가 구현 범위 또는 검증 방법을 확정하지 못했습니다 (ready=false).";

  const sections: PacketSection[] = [
    { key: "heading", text: `${PLAN_DECISION_PACKET_HEADING} (사람이 읽는 판단 재료)` },
    {
      key: "ready",
      text: approvable
        ? "**준비 상태:** `ready=true` — Blocking Question 없음. 승인 여부를 판단할 수 있습니다."
        : `**준비 상태:** \`ready=${String(scope.ready)}\` — **이 PLAN은 승인할 수 없습니다.** ${notReadyReason} 아래 Blocking Question에 답하도록 Issue 본문을 보완한 뒤 PLAN을 다시 받거나, 사유를 남기고 Issue를 닫으세요. \`PLAN-승인\`을 남겨도 PLAN_AUTHORIZE가 fail-closed로 거부합니다.`,
    },
    {
      key: "questions",
      text: plan.questions.length === 0
        ? "**Blocking Question:** 없음"
        : `**Blocking Question (${plan.questions.length}개, 사람이 답해야 함):**\n${numbered(plan.questions)}`,
    },
    { key: "summary", dropOrder: 5, text: `**AI가 이해한 목표:**\n${oneLine(plan.summary)}` },
    {
      key: "requiredChanges",
      dropOrder: 4,
      text: `**구현 항목 (requiredChanges):**\n${bullets(scope.requiredChanges, scope.ready ? "없음" : "미확정 (ready=false)")}`,
    },
    {
      key: "allowedPaths",
      text: `**변경 예상 파일 (allowedPaths, 이 밖의 파일은 IMPLEMENT가 수정할 수 없음):**\n${codeList(scope.allowedPaths, scope.ready ? "없음" : "미확정 (ready=false)")}`,
    },
    { key: "acceptanceCriteria", dropOrder: 2, text: `**완료조건 (acceptanceCriteria):**\n${bullets(plan.acceptanceCriteria, "없음")}` },
    { key: "testStrategy", dropOrder: 1, text: `**테스트 계획 (testStrategy):**\n${bullets(plan.testStrategy, "없음")}` },
    {
      key: "validationCommands",
      text: `**검증 명령 (validationCommands, trusted CI가 실행):**\n${codeList(scope.validationCommands, scope.ready ? "없음" : "미확정 (ready=false)")}`,
    },
    {
      key: "forbiddenChanges",
      dropOrder: 3,
      text: `**범위 밖 / 금지 변경 (forbiddenChanges):**\n${bullets(scope.forbiddenChanges, "명시된 금지 변경 없음")}`,
    },
    {
      key: "choices",
      text: `**사람의 선택지:**\n- ${approvable ? APPROVE_INSTRUCTION : "승인: 지금은 불가합니다. 위 준비 상태를 보세요."}\n- ${REJECT_INSTRUCTION}\n- ${REPLAN_INSTRUCTION}`,
    },
    { key: "note", text: DISPLAY_ONLY_NOTE },
  ];

  const kept = [...sections];
  const droppable = sections.filter((section) => section.dropOrder !== undefined).sort((a, b) => a.dropOrder! - b.dropOrder!);
  const dropped: string[] = [];
  const render = (): string => {
    const body = kept.map((section) => section.text).join("\n\n");
    return dropped.length === 0
      ? body
      : `${body}\n\n_댓글 크기 제한으로 ${dropped.join(", ")} 섹션을 생략했습니다. 전체 내용은 PLAN artifact의 PLAN.md를 확인하세요._`;
  };
  let output = render();
  for (const section of droppable) {
    if (Buffer.byteLength(output, "utf8") <= maxBytes) break;
    kept.splice(kept.indexOf(section), 1);
    dropped.push(section.key);
    output = render();
  }
  return output;
}

/** ready 여부에 따라 달라지는 HumanStatus "다음 행동" 문구. 표시 전용. */
export function planDecisionNextAction(approvable: boolean): string {
  return approvable
    ? "위 PLAN Decision Packet을 읽고 이 계획으로 문제를 해결하도록 허용할지 결정하세요. 허용하면 정확히 `PLAN-승인` 댓글을 남기고, 아니면 사유를 남기고 Issue를 닫거나 요구사항을 보완한 뒤 재PLAN하세요."
    : "이 PLAN은 승인할 수 없습니다. Blocking Question에 답하도록 Issue 본문을 보완한 뒤 PLAN을 다시 받거나, 사유를 남기고 Issue를 닫으세요. `PLAN-승인`을 남겨도 fail-closed로 거부됩니다.";
}

export interface PlanAuthorizeRejection {
  /** 사람이 읽는 한 줄 이유 */
  readonly reason: string;
  /** 사람이 해야 할 다음 행동 */
  readonly nextAction: string;
  /** trusted 검증이 던진 원문 메시지 (추적용) */
  readonly detail: string;
  readonly questions: readonly string[];
}

const REPLAN_NEXT_ACTION = "현재 main 기준으로 PLAN을 다시 받으세요 (Actions → Read-only AI PLAN → 이 Issue 번호). 새 PLAN 댓글의 Decision Packet을 읽고 다시 승인 여부를 결정하세요.";

/**
 * PLAN_AUTHORIZE의 fail-closed 사유를 사람이 행동할 수 있는 문장으로 바꾼다.
 * 알려진 사유만 매핑하고, 나머지는 원문을 그대로 보여 준다. 사유를 숨기거나 완화하지 않는다.
 */
export function describePlanAuthorizeRejection(error: unknown, questions: readonly string[] = []): PlanAuthorizeRejection {
  const detail = error instanceof Error ? error.message : String(error);
  const base = { detail, questions: [...questions] };
  if (/blocking questions|is not ready/.test(detail)) {
    return {
      ...base,
      reason: "승인한 PLAN이 아직 구현 준비 상태가 아닙니다 (ready=false 또는 Blocking Question 있음).",
      nextAction: "Blocking Question에 답하도록 Issue 본문을 보완한 뒤 PLAN을 다시 받거나, 진행하지 않으려면 사유를 남기고 Issue를 닫으세요.",
    };
  }
  if (/current target SHA mismatch/.test(detail)) {
    return {
      ...base,
      reason: "PLAN이 만들어진 뒤 default branch가 이동했습니다. 오래된 PLAN은 승인할 수 없습니다.",
      nextAction: REPLAN_NEXT_ACTION,
    };
  }
  if (/current requirement digest mismatch/.test(detail)) {
    return {
      ...base,
      reason: "PLAN이 만들어진 뒤 Issue 제목 또는 본문이 바뀌었습니다. 바뀐 요구로 만든 PLAN이 아니므로 승인할 수 없습니다.",
      nextAction: REPLAN_NEXT_ACTION,
    };
  }
  if (/no valid PLAN provenance/.test(detail)) {
    return {
      ...base,
      reason: "이 승인 댓글 이전에 유효한 PLAN이 없습니다. 승인할 대상이 없습니다.",
      nextAction: "PLAN 댓글(## PLAN (AI 제안 — 구현 승인 아님))이 달린 뒤에 승인하세요. PLAN이 없으면 Actions → Read-only AI PLAN을 이 Issue 번호로 실행하세요.",
    };
  }
  if (/human GitHub user/.test(detail)) {
    return {
      ...base,
      reason: "PLAN 승인은 사람 GitHub 계정만 할 수 있습니다.",
      nextAction: "사람 계정으로 `PLAN-승인` 댓글을 남기세요.",
    };
  }
  return {
    ...base,
    reason: "trusted PLAN_AUTHORIZE 검증이 실패했습니다.",
    nextAction: "검증 메시지와 PLAN_AUTHORIZE 실행 기록을 확인한 뒤, 필요하면 PLAN을 다시 받으세요.",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * PLAN artifact에 남아 있는 blocking question을 표시용으로 읽는다. 판정에는 쓰지 않는다.
 * 승인 거부 댓글이 "무엇에 답해야 하는지"를 보여 주기 위해 검증 전에 읽어 둔다.
 */
export function planArtifactQuestions(value: unknown): string[] {
  if (!isRecord(value) || !isRecord(value.plan) || !Array.isArray(value.plan.questions)) return [];
  return value.plan.questions.filter((item): item is string => typeof item === "string");
}

/**
 * PLAN artifact의 PLAN.json이 지금 승인 가능한 문서인지 확인한다.
 * Handoff가 쓰는 validateApprovedPlanDocument를 그대로 재사용하므로 두 단계의 판정이 같다.
 * 실패 시 던지는 예외 메시지는 describePlanAuthorizeRejection이 사람 문장으로 바꾼다.
 */
export function assertApprovablePlanArtifact(
  value: unknown,
  expected: { readonly repository: string; readonly targetSha: string },
): ApprovedPlanDocument {
  if (!isRecord(value)) throw new Error("PLAN artifact must be an object");
  if (value.kind !== "untrusted-plan") throw new Error("PLAN artifact kind is invalid");
  if (value.repository !== expected.repository) throw new Error("PLAN artifact repository mismatch");
  if (value.sha !== expected.targetSha) throw new Error("PLAN artifact SHA mismatch");
  if (!isRecord(value.plan)) throw new Error("PLAN artifact plan is invalid");
  return validateApprovedPlanDocument(value.plan);
}

/** GITHUB_OUTPUT에 값을 기록한다. 여러 줄 값은 무작위 delimiter의 heredoc 형식을 쓴다. */
export function writeGithubOutput(outputPath: string, name: string, value: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid GITHUB_OUTPUT name: ${name}`);
  if (!value.includes("\n")) {
    appendFileSync(outputPath, `${name}=${value}\n`, "utf8");
    return;
  }
  const delimiter = `ghadelim_${randomUUID().replaceAll("-", "")}`;
  if (value.includes(delimiter)) throw new Error("GITHUB_OUTPUT delimiter collision");
  appendFileSync(outputPath, `${name}<<${delimiter}\n${value}\n${delimiter}\n`, "utf8");
}
