export const REVIEW_DECISIONS = [
  "PASS",
  "LOCAL_FIX",
  "STRUCTURAL_CHANGE",
] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export function isReviewDecision(value: string): value is ReviewDecision {
  return REVIEW_DECISIONS.some((decision) => decision === value);
}
