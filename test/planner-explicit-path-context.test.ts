import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { augmentPlanContextWithExplicitPaths } from "../src/self-improvement/plan-explicit-path-context.js";
import { selectPlanContext, verifyPlanContextPack } from "../src/self-improvement/planner.js";

test("PLAN Context는 Requirement의 실재 exact path를 등장 순서대로 heuristic보다 우선한다", () => {
  const root = mkdtempSync(join(tmpdir(), "planner-explicit-path-"));
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "test"));
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });

    writeFileSync(join(root, "src", "noise.ts"), "learn test execution provenance context ".repeat(100));
    writeFileSync(join(root, "src", "second.ts"), "export const second = true;\n");
    writeFileSync(join(root, "src", "first.ts"), "export const first = true;\n");
    writeFileSync(join(root, ".github", "workflows", "plan.yml"), "name: plan\n");
    writeFileSync(join(root, "test", "example.test.ts"), "const ok = true; void ok;\n");

    const requirement = [
      "다음 exact Context Anchor를 사용한다.",
      "`src/second.ts`",
      "`src/missing.ts`",
      "`src/first.ts`",
      "`.github/workflows/plan.yml`",
      "`test/example.test.ts`",
    ].join("\n");
    const base = selectPlanContext(requirement, root, "example/framework", "a".repeat(40));
    const options = { maxFiles: 3, maxBytes: 10_000, maxFileBytes: 4_000 };
    const first = augmentPlanContextWithExplicitPaths(requirement, root, base, options);
    const second = augmentPlanContextWithExplicitPaths(requirement, root, base, options);

    assert.deepEqual(first, second);
    assert.doesNotThrow(() => verifyPlanContextPack(first));
    assert.deepEqual(first.files.map((file) => file.path), [
      "src/second.ts",
      "src/first.ts",
      ".github/workflows/plan.yml",
    ]);
    assert.ok(!first.files.some((file) => file.path === "src/missing.ts"));
    assert.ok(first.totalBytes <= options.maxBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PLAN Context explicit path augmentation은 byte budget을 넘지 않고 뒤 heuristic context만 생략한다", () => {
  const root = mkdtempSync(join(tmpdir(), "planner-explicit-byte-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "one.ts"), "ONE ".repeat(100));
    writeFileSync(join(root, "src", "two.ts"), "TWO ".repeat(100));
    writeFileSync(join(root, "src", "noise.ts"), "noise ".repeat(100));

    const requirement = "`src/one.ts`와 `src/two.ts`를 먼저 본다.";
    const base = selectPlanContext(requirement, root, "example/framework", "b".repeat(40));
    const pack = augmentPlanContextWithExplicitPaths(requirement, root, base, {
      maxFiles: 3,
      maxBytes: 60,
      maxFileBytes: 40,
    });

    assert.doesNotThrow(() => verifyPlanContextPack(pack));
    assert.deepEqual(pack.files.map((file) => file.path), ["src/one.ts", "src/two.ts"]);
    assert.equal(pack.totalBytes, 60);
    assert.equal(pack.files[0]?.byteLength, 40);
    assert.equal(pack.files[1]?.byteLength, 20);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planner prepare pipeline은 explicit path augmentation을 최종 Context 우선순위 단계로 적용한다", () => {
  const handler = readFileSync(join(process.cwd(), "src/self-improvement/planner-handler.ts"), "utf8");
  assert.match(handler, /const context = augmentPlanContextWithExplicitPaths\(requirement, target, humanContext\);/);
});
