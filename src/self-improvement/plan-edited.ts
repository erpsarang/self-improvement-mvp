// 요구 Issue의 제목·본문이 바뀌면 사람이 Actions에서 PLAN을 다시 치던 클릭을 trusted gate로 대체한다.
// 관측(App transportation_guide #2 run 38890924103): ready=false → 사람이 본문 보완 → 수동 dispatch. 다른 App에서 본문 수정 3회(#391).
// gate는 읽기만 하고, 시작 여부를 (현재 digest, 지금까지 PLAN한 digest 목록)만으로 결정한다. AI 호출은 늘리지 않는다:
// 편집 1회 = PLAN 최대 1회, Issue당 서로 다른 본문은 상한까지, 같은 Issue의 run은 concurrency group으로 하나씩 돈다.

const SHA256 = /^[0-9a-f]{64}$/;

/** 한 Issue에서 자동으로 PLAN할 수 있는 서로 다른 요구 본문(requirement digest)의 수. 넘으면 사람이 수동 실행한다. */
export const MAX_AUTO_PLAN_DISTINCT_REQUIREMENTS_PER_ISSUE = 4 as const;

export interface PlanRequestRecord {
  readonly requirementDigest: string;
  readonly runId: number;
  readonly runAttempt: number;
}

// request job이 남기는 PLAN_REQUEST marker(plan.yml). executor도 같은 모양을 읽으므로 여기서는 읽기만 하고 바꾸지 않는다.
const REQUEST_PATTERN = /<!-- ai-dev-framework:PLAN_REQUEST v=1 request=[0-9a-f]{64} issue=([1-9]\d*) repository=[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+ target=[0-9a-f]{40} requirement=([0-9a-f]{64}) run=([1-9]\d*) attempt=([1-9]\d*) artifact=[1-9]\d* digest=[0-9a-f]{64} model=(?:opus|sonnet) -->/;

/** trusted bot 댓글 본문에서만 읽는다. 호출자가 작성자 필터를 먼저 건다. */
export function parsePlanRequestRecords(commentBodies: readonly string[], issueNumber: number): readonly PlanRequestRecord[] {
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new Error("issue number is invalid");
  const records: PlanRequestRecord[] = [];
  for (const rawBody of commentBodies) {
    const match = REQUEST_PATTERN.exec(rawBody.replace(/\r/g, ""));
    if (!match || Number(match[1]) !== issueNumber) continue;
    const [, , requirementDigest = "", runId, runAttempt] = match;
    records.push({ requirementDigest, runId: Number(runId), runAttempt: Number(runAttempt) });
  }
  return records;
}

export type EditedPlanOutcome =
  | "START"
  | "UNCHANGED"
  | "CAP_REACHED";

export interface EditedPlanDecision {
  readonly outcome: EditedPlanOutcome;
  /** 지금까지 PLAN한 서로 다른 본문 수. 현재 본문이 새 것이면 시작 뒤 1 늘어난다. */
  readonly distinctRequirements: number;
}

export function decideEditedPlanStart(input: {
  readonly currentRequirementDigest: string;
  readonly priorRequests: readonly PlanRequestRecord[];
}): EditedPlanDecision {
  if (!SHA256.test(input.currentRequirementDigest)) throw new Error("current requirement digest is invalid");
  const distinct = new Set(input.priorRequests.map((record) => record.requirementDigest));

  // 가장 최근 request는 run id가 가장 큰 것이다(댓글 순서가 아니라 run identity로 고른다).
  const latest = input.priorRequests.reduce<PlanRequestRecord | null>(
    (best, record) => best === null || record.runId > best.runId ? record : best,
    null,
  );
  // 되돌린 편집: 마지막으로 PLAN한 본문과 같으면 새 입력이 아니다. 기존 PLAN이 그대로 유효하다.
  if (latest !== null && latest.requirementDigest === input.currentRequirementDigest) {
    return { outcome: "UNCHANGED", distinctRequirements: distinct.size };
  }
  // 이미 PLAN했던 옛 본문으로 돌아간 경우는 상한에 새로 더하지 않는다. 새 본문만 상한을 소모한다.
  if (!distinct.has(input.currentRequirementDigest) && distinct.size >= MAX_AUTO_PLAN_DISTINCT_REQUIREMENTS_PER_ISSUE) {
    return { outcome: "CAP_REACHED", distinctRequirements: distinct.size };
  }
  return { outcome: "START", distinctRequirements: distinct.size };
}
