import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateBridgeTrustedCodeIdentity } from "../src/self-improvement/plan-candidate-bridge.js";

const baseSha = "b".repeat(40);
const currentSha = "c".repeat(40);

test("automatic PLAN Bridge는 trusted code SHA가 candidate base SHA와 같아야 한다", () => {
  assert.doesNotThrow(() => validateBridgeTrustedCodeIdentity({
    baseSha,
    trustedCodeSha: baseSha,
  }));
  assert.throws(() => validateBridgeTrustedCodeIdentity({
    baseSha,
    trustedCodeSha: currentSha,
  }), /must equal exact candidate base SHA/);
});

test("recovery PLAN Bridge는 candidate base와 최신 trusted code SHA를 guard로 각각 고정한다", () => {
  assert.doesNotThrow(() => validateBridgeTrustedCodeIdentity({
    baseSha,
    trustedCodeSha: currentSha,
    recoveryGuard: {
      kind: "trusted-recovery-compare-v1",
      baseSha,
      currentDefaultSha: currentSha,
    },
  }));

  assert.throws(() => validateBridgeTrustedCodeIdentity({
    baseSha,
    trustedCodeSha: currentSha,
    recoveryGuard: {
      kind: "trusted-recovery-compare-v1",
      baseSha: "d".repeat(40),
      currentDefaultSha: currentSha,
    },
  }), /does not bind candidate base and trusted code SHA/);

  assert.throws(() => validateBridgeTrustedCodeIdentity({
    baseSha,
    trustedCodeSha: currentSha,
    recoveryGuard: {
      kind: "trusted-recovery-compare-v1",
      baseSha,
      currentDefaultSha: "e".repeat(40),
    },
  }), /does not bind candidate base and trusted code SHA/);
});

test("recovery guard는 bridge provenance와 digest payload 양쪽에 포함된다", () => {
  const source = readFileSync(
    new URL("../src/self-improvement/plan-candidate-bridge.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /\.\.\.\(input\.recoveryGuard \? \{ recoveryGuard: \{ \.\.\.input\.recoveryGuard \} \} : \{\}\),/);
  assert.match(source, /\.\.\.\(value\.recoveryGuard \? \{ recoveryGuard: \{ \.\.\.value\.recoveryGuard \} \} : \{\}\),/);
  assert.match(source, /\.\.\.\(provenance\.recoveryGuard \? \{ recoveryGuard: provenance\.recoveryGuard \} : \{\}\),/);
});
