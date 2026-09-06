import assert from "node:assert/strict";
import test from "node:test";
import {
  isReviewDecision,
  REVIEW_DECISIONS,
} from "../src/self-improvement/review-decision.js";

test("세 가지 review decision만 정의한다", () => {
  assert.deepEqual(REVIEW_DECISIONS, [
    "PASS",
    "LOCAL_FIX",
    "STRUCTURAL_CHANGE",
  ]);
  assert.equal(isReviewDecision("LOCAL_FIX"), true);
  assert.equal(isReviewDecision("AUTO_MERGE"), false);
});
