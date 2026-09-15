import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const bridgeSource = readFileSync(
  new URL("../src/self-improvement/plan-candidate-bridge.ts", import.meta.url),
  "utf8",
);
const handlerSource = readFileSync(
  new URL("../src/self-improvement/plan-candidate-bridge-handler.ts", import.meta.url),
  "utf8",
);

test("bridge provenance 생성은 trusted recovery guard를 내부 재검증까지 전달한다", () => {
  assert.match(
    bridgeSource,
    /readonly recoveryGuard\?: TrustedRecoveryCompareGuard;/,
  );
  assert.match(
    bridgeSource,
    /\.\.\.\(input\.recoveryGuard \? \{ recoveryGuard: input\.recoveryGuard \} : \{\}\),/,
  );
});

test("finalize는 workflow가 검증한 recovery guard를 provenance 생성에 전달한다", () => {
  const finalize = handlerSource.split("async function finalize(): Promise<void> {")[1] ?? "";
  assert.match(finalize, /const recoveryGuard = trustedRecoveryGuard\(\);/);
  assert.match(
    finalize,
    /\.\.\.\(recoveryGuard \? \{ recoveryGuard \} : \{\}\),/,
  );
});
