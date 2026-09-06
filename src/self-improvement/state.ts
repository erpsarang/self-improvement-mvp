import type { AuthorizationProvenance } from "./authorization.js";
import { isReviewDecision, type ReviewDecision } from "./review-decision.js";

export const WORKFLOW_STATES = [
  "CANDIDATE",
  "AUTHORIZED",
  "IMPLEMENTING",
  "SEALED",
  "PUBLISHED",
  "VERIFIED",
  "REVIEWING",
  "FIXING",
  "MERGE_READY",
  "STOPPED",
  "MERGED",
] as const;
export type WorkflowState = (typeof WORKFLOW_STATES)[number];

export interface WorkflowSnapshot {
  readonly state: WorkflowState;
  readonly fixCount: number;
  readonly authorization?: AuthorizationProvenance;
  readonly publishedHeadSha?: string;
  readonly verifiedSha?: string;
}

export type WorkflowEvent =
  | { readonly type: "AUTHORIZE"; readonly provenance: AuthorizationProvenance }
  | { readonly type: "START_IMPLEMENT" }
  | { readonly type: "SEAL" }
  | { readonly type: "RECORD_PUBLISHED"; readonly publishedHeadSha: string }
  | { readonly type: "VERIFY"; readonly targetSha: string }
  | { readonly type: "START_REVIEW" }
  | { readonly type: "REVIEW_DECISION"; readonly decision: ReviewDecision }
  | { readonly type: "RECORD_HUMAN_MERGE" };

export const initialState = (): WorkflowSnapshot => ({
  state: "CANDIDATE",
  fixCount: 0,
});

function invalid(snapshot: WorkflowSnapshot, event: WorkflowEvent): never {
  throw new Error(
    `${snapshot.state} 상태에서는 ${event.type} 이벤트를 처리할 수 없습니다`,
  );
}

/** 외부 작업을 실행하지 않고, 검증된 사실만 기록하는 순수 상태 전이 함수다. */
export function transition(
  snapshot: WorkflowSnapshot,
  event: WorkflowEvent,
): WorkflowSnapshot {
  switch (event.type) {
    case "AUTHORIZE":
      if (snapshot.state !== "CANDIDATE") return invalid(snapshot, event);
      return {
        ...snapshot,
        state: "AUTHORIZED",
        authorization: event.provenance,
      };
    case "START_IMPLEMENT":
      if (snapshot.state !== "AUTHORIZED") return invalid(snapshot, event);
      return { ...snapshot, state: "IMPLEMENTING" };
    case "SEAL":
      if (snapshot.state !== "IMPLEMENTING" && snapshot.state !== "FIXING")
        return invalid(snapshot, event);
      return {
        state: "SEALED",
        fixCount: snapshot.fixCount,
        ...(snapshot.authorization
          ? { authorization: snapshot.authorization }
          : {}),
      };
    case "RECORD_PUBLISHED":
      if (snapshot.state !== "SEALED") return invalid(snapshot, event);
      if (!/^[0-9a-f]{40}$/i.test(event.publishedHeadSha))
        throw new Error("published_head_sha는 40자리 Git SHA여야 합니다");
      return {
        state: "PUBLISHED",
        fixCount: snapshot.fixCount,
        ...(snapshot.authorization
          ? { authorization: snapshot.authorization }
          : {}),
        publishedHeadSha: event.publishedHeadSha.toLowerCase(),
      };
    case "VERIFY":
      if (snapshot.state !== "PUBLISHED") return invalid(snapshot, event);
      const targetSha = event.targetSha.toLowerCase();
      if (targetSha !== snapshot.publishedHeadSha)
        throw new Error(
          "검증 대상 SHA가 published_head_sha와 일치하지 않습니다",
        );
      return { ...snapshot, state: "VERIFIED", verifiedSha: targetSha };
    case "START_REVIEW":
      if (
        snapshot.state !== "VERIFIED" ||
        snapshot.verifiedSha !== snapshot.publishedHeadSha
      )
        return invalid(snapshot, event);
      return { ...snapshot, state: "REVIEWING" };
    case "REVIEW_DECISION":
      if (snapshot.state !== "REVIEWING") return invalid(snapshot, event);
      if (!isReviewDecision(event.decision))
        throw new Error(
          `지원하지 않는 review decision입니다: ${event.decision}`,
        );
      if (event.decision === "PASS")
        return { ...snapshot, state: "MERGE_READY" };
      if (event.decision === "STRUCTURAL_CHANGE")
        return { ...snapshot, state: "STOPPED" };
      if (snapshot.fixCount >= 2) return { ...snapshot, state: "STOPPED" };
      return { ...snapshot, state: "FIXING", fixCount: snapshot.fixCount + 1 };
    case "RECORD_HUMAN_MERGE":
      if (snapshot.state !== "MERGE_READY") return invalid(snapshot, event);
      return { ...snapshot, state: "MERGED" };
  }
}
