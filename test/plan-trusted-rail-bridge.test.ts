import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const planBridgeWorkflow = readFileSync(".github/workflows/plan-candidate-bridge.yml", "utf8");
const trustedRail = readFileSync(".github/workflows/trusted-rail.yml", "utf8");
const semanticReview = readFileSync(".github/workflows/semantic-review.yml", "utf8");
const seal = readFileSync("src/self-improvement/seal.ts", "utf8");
const sealHandler = readFileSync("src/self-improvement/seal-handler.ts", "utf8");
const review = readFileSync("src/self-improvement/review.ts", "utf8");
const reviewHandler = readFileSync("src/self-improvement/review-handler.ts", "utf8");

test("PLAN bridge crosses the workflow_run depth boundary with explicit trusted dispatch", () => {
  assert.match(planBridgeWorkflow, /dispatch_trusted_rail:/);
  assert.match(planBridgeWorkflow, /actions:\s*write/);
  assert.match(planBridgeWorkflow, /createWorkflowDispatch/);
  assert.match(planBridgeWorkflow, /workflow_id:\s*['"]trusted-rail\.yml['"]/);
  assert.match(planBridgeWorkflow, /source_candidate_kind:\s*['"]PLAN_BRIDGE['"]/);
  assert.doesNotMatch(trustedRail, /workflows:\s*\[[^\]]*Trusted PLAN Candidate Bridge/);
});

test("Trusted Rail accepts canonical PLAN bridge as a truthful source", () => {
  assert.match(trustedRail, /plan-bridge\.json/);
  assert.match(trustedRail, /PLAN_BRIDGE/);
  assert.match(sealHandler, /PLAN_BRIDGE/);
  assert.match(seal, /sourcePlanBridge/);
});

test("PLAN bridge is not disguised as legacy IMPLEMENT provenance", () => {
  assert.doesNotMatch(trustedRail, /plan-bridge\.json[^\n]*implement\.json/);
  assert.doesNotMatch(seal, /sourcePlanBridge[\s\S]{0,800}policySnapshot/);
});

test("Semantic REVIEW recognizes exact PLAN_AUTHORIZE provenance", () => {
  assert.match(semanticReview, /PLAN_AUTHORIZE/);
  assert.match(semanticReview, /plan-authorize\.json/);
  assert.match(reviewHandler, /PLAN_AUTHORIZE/);
  assert.match(review, /sourcePlanAuthorize/);
});

test("Human-only merge boundary remains and auto merge is not introduced", () => {
  assert.match(trustedRail, /orchestrator\.yml/);
  assert.doesNotMatch(trustedRail, /enablePullRequestAutoMerge|enable_auto_merge|auto-merge/i);
});
