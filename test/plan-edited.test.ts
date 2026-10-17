import assert from "node:assert/strict";
import test from "node:test";
import {
  decideEditedPlanStart,
  MAX_AUTO_PLAN_DISTINCT_REQUIREMENTS_PER_ISSUE,
  parsePlanRequestRecords,
  type PlanRequestRecord,
} from "../src/self-improvement/plan-edited.js";

const d = (n: number) => n.toString(16).padStart(64, "0");

// App transportation_guide Issue #2의 실제 PLAN_REQUEST marker 모양(run 38890924103 → 본문 보완 → run 38979993091).
function requestMarker(issue: number, requirement: string, run: number, model = "sonnet"): string {
  return `<!-- ai-dev-framework:PLAN_REQUEST v=1 request=${"a".repeat(64)} issue=${issue} repository=erpsarang/transportation_guide target=${"e77740d0e1bf29709115b2d8f6e758f5ef3b2570"} requirement=${requirement} run=${run} attempt=1 artifact=12050000000 digest=${"b".repeat(64)} model=${model} -->`;
}

test("PLAN_REQUEST marker는 같은 Issue의 것만 읽고 requirement digest·run을 꺼낸다", () => {
  const bodies = [
    `${requestMarker(2, d(1), 38890924103)}\r\n\r\n## PLAN 실행 요청 대기`,
    requestMarker(7, d(9), 38992157914),
    `${requestMarker(2, d(2), 38979993091, "opus")}\n\n## PLAN 실행 요청 대기`,
    "<!-- ai-dev-framework:PLAN_REQUEST v=1 request=zzz issue=2 -->",
    "## PLAN 실패 (게시된 PLAN 없음)",
  ];
  assert.deepEqual(parsePlanRequestRecords(bodies, 2), [
    { requirementDigest: d(1), runId: 38890924103, runAttempt: 1 },
    { requirementDigest: d(2), runId: 38979993091, runAttempt: 1 },
  ]);
  assert.throws(() => parsePlanRequestRecords(bodies, 0), /issue number is invalid/);
});

test("본문이 마지막으로 PLAN한 것과 다르면 시작하고, 같으면(되돌린 편집) 시작하지 않는다", () => {
  const prior: PlanRequestRecord[] = [
    { requirementDigest: d(1), runId: 100, runAttempt: 1 },
    { requirementDigest: d(2), runId: 200, runAttempt: 1 },
  ];
  assert.deepEqual(decideEditedPlanStart({ currentRequirementDigest: d(3), priorRequests: prior }), { outcome: "START", distinctRequirements: 2 });
  assert.deepEqual(decideEditedPlanStart({ currentRequirementDigest: d(2), priorRequests: prior }), { outcome: "UNCHANGED", distinctRequirements: 2 });
  // 최근 판정은 댓글 순서가 아니라 run id로 한다.
  const reversed = [prior[1]!, prior[0]!];
  assert.deepEqual(decideEditedPlanStart({ currentRequirementDigest: d(2), priorRequests: reversed }), { outcome: "UNCHANGED", distinctRequirements: 2 });
  // 옛 본문(d(1))으로 돌아가면 마지막 PLAN(d(2))과 다르므로 다시 PLAN한다.
  assert.deepEqual(decideEditedPlanStart({ currentRequirementDigest: d(1), priorRequests: prior }), { outcome: "START", distinctRequirements: 2 });
  // 아직 PLAN이 없으면 시작한다(제목을 고쳐 [업무 요구]가 된 경우).
  assert.deepEqual(decideEditedPlanStart({ currentRequirementDigest: d(1), priorRequests: [] }), { outcome: "START", distinctRequirements: 0 });
  assert.throws(() => decideEditedPlanStart({ currentRequirementDigest: "abc", priorRequests: [] }), /digest is invalid/);
});

test("Issue당 서로 다른 본문은 상한까지만 자동 PLAN하고, 이미 PLAN한 본문은 상한을 소모하지 않는다", () => {
  assert.equal(MAX_AUTO_PLAN_DISTINCT_REQUIREMENTS_PER_ISSUE, 4);
  const prior: PlanRequestRecord[] = [1, 2, 3, 4].map((n) => ({ requirementDigest: d(n), runId: n * 100, runAttempt: 1 }));
  // 같은 본문으로 PLAN을 두 번 돌린 기록(재시도)은 하나로 센다.
  const withRetry = [...prior, { requirementDigest: d(4), runId: 450, runAttempt: 1 }];
  assert.deepEqual(decideEditedPlanStart({ currentRequirementDigest: d(5), priorRequests: withRetry }), { outcome: "CAP_REACHED", distinctRequirements: 4 });
  assert.deepEqual(decideEditedPlanStart({ currentRequirementDigest: d(2), priorRequests: withRetry }), { outcome: "START", distinctRequirements: 4 });
  const three = prior.slice(0, 3);
  assert.deepEqual(decideEditedPlanStart({ currentRequirementDigest: d(5), priorRequests: three }), { outcome: "START", distinctRequirements: 3 });
});
