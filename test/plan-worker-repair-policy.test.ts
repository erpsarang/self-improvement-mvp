import assert from "node:assert/strict";
import test from "node:test";
import type { DeterministicValidationResult } from "../src/self-improvement/deterministic-ci.js";
import { classifyRepairEligibility } from "../src/self-improvement/repair-policy.js";

function validation(stdout: string, stderr = ""): DeterministicValidationResult {
  return {
    schemaVersion: 1,
    kind: "deterministic-validation-result",
    contractDigest: "a".repeat(64),
    contextDigest: "b".repeat(64),
    candidateDigest: "c".repeat(64),
    baseSha: "d".repeat(40),
    appliedPaths: ["src/order-analysis.ts"],
    status: "FAIL",
    commands: [{
      raw: "npm test",
      executable: "npm",
      args: ["test"],
      status: "FAIL",
      exitCode: 1,
      signal: null,
      stdout,
      stderr,
    }],
    digestAlgorithm: "sha256",
    evidenceDigest: "e".repeat(64),
  };
}

const allowedPaths = [
  "src/order-analysis.ts",
  "test/order-analysis.test.ts",
  "test/batch-order-analysis.test.ts",
];

test("allowedPaths 밖 source의 명시적 budget boundary 실패는 AI repair를 차단한다", () => {
  const result = classifyRepairEligibility(
    allowedPaths,
    validation([
      "not ok 1 - App Runtime Evidence",
      "error: 'App Runtime Evidence exceeds bounded evidence item budget'",
      "stack: |-",
      "  verifyAppRuntimeEvidence (/workspace/src/app-evidence.ts:141:11)",
      "  TestContext.<anonymous> (/workspace/test/app-evidence.test.ts:13:3)",
    ].join("\n")),
  );

  assert.deepEqual(result, {
    allowed: false,
    reason: "OUT_OF_SCOPE_BOUNDARY",
    sourcePaths: ["src/app-evidence.ts"],
  });
});

test("일반 assertion failure는 다른 test 파일이어도 기존 bounded repair를 유지한다", () => {
  const result = classifyRepairEligibility(
    allowedPaths,
    validation([
      "not ok 1 - 결과가 일치해야 한다",
      "error: 'Expected values to be strictly equal'",
      "  TestContext.<anonymous> (/workspace/test/app-evidence.test.ts:13:3)",
    ].join("\n")),
  );

  assert.equal(result.allowed, true);
  assert.equal(result.reason, "REPAIR_ALLOWED");
});

test("boundary 오류가 allowed source에서 발생하면 repair를 허용한다", () => {
  const result = classifyRepairEligibility(
    allowedPaths,
    validation([
      "error: 'candidate exceeds bounded result limit'",
      "  analyzeOrder (/workspace/src/order-analysis.ts:88:9)",
    ].join("\n")),
  );

  assert.equal(result.allowed, true);
  assert.deepEqual(result.sourcePaths, ["src/order-analysis.ts"]);
});

test("allowedPaths 밖 source라도 boundary signal이 없으면 성급하게 차단하지 않는다", () => {
  const result = classifyRepairEligibility(
    allowedPaths,
    validation([
      "error: 'unexpected value'",
      "  helper (/workspace/src/app-evidence.ts:141:11)",
    ].join("\n")),
  );

  assert.equal(result.allowed, true);
});
