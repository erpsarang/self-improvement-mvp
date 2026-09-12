import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectPlanContext, verifyPlanContextPack } from "../src/self-improvement/planner.js";

test("PLAN context prioritizes exact technical anchor coverage before generic relevance", () => {
  const root = mkdtempSync(join(tmpdir(), "planner-anchor-"));
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "test"));

    writeFileSync(join(root, "src", "planner-noise.ts"), "PLAN PLAN PLAN PLAN PLAN implementation status summary\n".repeat(20));
    writeFileSync(join(root, "src", "orchestrator.ts"), "export type State = 'MERGE_READY' | 'STOPPED';\n");
    writeFileSync(join(root, "src", "plan-authorization.ts"), "export const state = 'PLAN_AUTHORIZE';\n");
    writeFileSync(join(root, "src", "implement.ts"), "export const state = 'IMPLEMENT';\n");
    writeFileSync(join(root, "src", "verify.ts"), "export const state = 'VERIFY';\n");
    writeFileSync(join(root, "test", "orchestrator.test.ts"), "MERGE_READY STOPPED assertions\n");

    const requirement = "`PLAN`, `PLAN_AUTHORIZE`, `IMPLEMENT`, `VERIFY`, `MERGE_READY`, `STOPPED` 상태를 사람이 이해하기 쉽게 표시한다.";
    const first = selectPlanContext(requirement, root, "example/framework", "a".repeat(40), {
      maxFiles: 6,
      maxBytes: 20_000,
      maxFileBytes: 4_000,
    });
    const second = selectPlanContext(requirement, root, "example/framework", "a".repeat(40), {
      maxFiles: 6,
      maxBytes: 20_000,
      maxFileBytes: 4_000,
    });

    assert.deepEqual(first, second);
    assert.doesNotThrow(() => verifyPlanContextPack(first));
    const paths = first.files.map((file) => file.path);
    assert.ok(paths.includes("src/orchestrator.ts"), `missing state anchor source: ${paths.join(", ")}`);
    assert.ok(paths.includes("src/plan-authorization.ts"), `missing PLAN_AUTHORIZE source: ${paths.join(", ")}`);
    assert.ok(paths.includes("src/implement.ts"), `missing IMPLEMENT source: ${paths.join(", ")}`);
    assert.ok(paths.includes("src/verify.ts"), `missing VERIFY source: ${paths.join(", ")}`);
    assert.ok(first.files.length <= 6);
    assert.ok(first.totalBytes <= 20_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uppercase technical anchors are recognized even without backticks", () => {
  const root = mkdtempSync(join(tmpdir(), "planner-anchor-uppercase-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "generic.ts"), "status status status status\n".repeat(20));
    writeFileSync(join(root, "src", "state-machine.ts"), "MERGE_READY STOPPED\n");

    const pack = selectPlanContext("MERGE_READY 다음 행동과 STOPPED 원인을 표시한다", root, "example/framework", "b".repeat(40), {
      maxFiles: 1,
      maxBytes: 4_000,
      maxFileBytes: 4_000,
    });
    assert.equal(pack.files[0]?.path, "src/state-machine.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
