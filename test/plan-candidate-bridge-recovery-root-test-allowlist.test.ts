import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  ".github/workflows/plan-candidate-bridge.yml",
  "utf8",
);

const requiredFrameworkRootTests = [
  "test/fix-dispatch-workflow.test.ts",
  "test/plan-candidate-bridge-recovery-finalize.test.ts",
  "test/plan-candidate-bridge-recovery-provenance.test.ts",
  "test/plan-trusted-rail-recovery-source.test.ts",
  "test/seal-workflow.test.ts",
];

test("recovery root-test allowlist는 최신 Framework 전용 회귀 테스트를 exact path로 허용한다", () => {
  for (const path of requiredFrameworkRootTests) {
    assert.match(workflow, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("recovery는 여전히 일반 test/**를 blanket 허용하지 않는다", () => {
  assert.match(workflow, /const frameworkRootTests = new Set\(\[/);
  assert.match(workflow, /path\.startsWith\('test\/self-improvement\/'\) \|\| frameworkRootTests\.has\(path\)/);
  assert.doesNotMatch(workflow, /path\.startsWith\('test\/'\)\s*\|\|/);
});
