import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { augmentPlanContextWithHumanOutputSurfaces } from "../src/self-improvement/plan-human-output-context.js";
import { selectPlanContext, verifyPlanContextPack } from "../src/self-improvement/planner.js";

test("human-facing requirement reserves exact Issue output surfaces within bounded context", () => {
  const root = mkdtempSync(join(tmpdir(), "planner-human-output-"));
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "docs"));
    mkdirSync(join(root, "test"));
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });

    writeFileSync(
      join(root, "src", "state.ts"),
      "export type State = 'PLAN' | 'PLAN_AUTHORIZE' | 'IMPLEMENT' | 'VERIFY' | 'MERGE_READY' | 'STOPPED';\n",
    );
    writeFileSync(
      join(root, "src", "marker-constants.ts"),
      "export const markers = ['github.rest.issues.createComment(', 'github.rest.issues.create(', 'github.rest.pulls.create('];\n사용자 표시 요약 다음 행동\n".repeat(20),
    );
    writeFileSync(
      join(root, ".github", "workflows", "noisy.yml"),
      "PLAN PLAN_AUTHORIZE IMPLEMENT VERIFY MERGE_READY STOPPED\n".repeat(80),
    );
    writeFileSync(
      join(root, ".github", "workflows", "plan.yml"),
      "name: PLAN\nscript: |\n  await github.rest.issues.createComment({ body: 'PLAN 제안 — 승인 대기' });\n",
    );
    writeFileSync(
      join(root, ".github", "workflows", "plan-authorize.yml"),
      "name: PLAN_AUTHORIZE\nscript: |\n  await github.rest.issues.createComment({ body: 'PLAN 승인 완료' });\n",
    );
    writeFileSync(
      join(root, "docs", "fake.md"),
      "github.rest.issues.createComment({ body: 'docs only' });\n".repeat(100),
    );
    writeFileSync(
      join(root, "test", "fake.test.ts"),
      "github.rest.issues.createComment({ body: 'test only' });\n".repeat(100),
    );

    const requirement = "`PLAN`, `PLAN_AUTHORIZE`, `IMPLEMENT`, `VERIFY`, `MERGE_READY`, `STOPPED` 상태를 사람이 이해하기 쉽게 표시하고 다음 행동을 안내한다.";
    const initial = selectPlanContext(requirement, root, "example/framework", "a".repeat(40), {
      maxFiles: 1,
      maxBytes: 18_000,
      maxFileBytes: 6_000,
    });
    const augmented = augmentPlanContextWithHumanOutputSurfaces(requirement, root, initial);

    assert.doesNotThrow(() => verifyPlanContextPack(augmented));
    const paths = augmented.files.map((file) => file.path);
    assert.ok(paths.includes("src/state.ts"), `missing definition-bearing state source: ${paths.join(", ")}`);
    assert.ok(paths.includes(".github/workflows/plan.yml"), `missing PLAN output surface: ${paths.join(", ")}`);
    assert.ok(paths.includes(".github/workflows/plan-authorize.yml"), `missing PLAN_AUTHORIZE output surface: ${paths.join(", ")}`);
    assert.ok(!paths.includes("src/marker-constants.ts"), `marker-only source must not be an output surface: ${paths.join(", ")}`);
    assert.ok(!paths.includes("docs/fake.md"));
    assert.ok(!paths.includes("test/fake.test.ts"));
    assert.ok(augmented.files.length <= 8);
    assert.ok(augmented.totalBytes <= 80_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("named lifecycle anchors reserve workflows even before human-output callsites exist", () => {
  const root = mkdtempSync(join(tmpdir(), "planner-lifecycle-output-"));
  try {
    mkdirSync(join(root, "src", "self-improvement"), { recursive: true });
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });

    writeFileSync(
      join(root, "src", "self-improvement", "state.ts"),
      "export const WORKFLOW_STATES = ['PLAN', 'PLAN_AUTHORIZE', 'IMPLEMENT', 'VERIFY', 'MERGE_READY', 'STOPPED'];\n",
    );
    writeFileSync(
      join(root, "src", "self-improvement", "implement-contract.ts"),
      "export interface ImplementContract { allowedPaths: readonly string[]; validationCommands: readonly string[]; }\n",
    );
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { test: "node --test", build: "tsc --noEmit" } }, null, 2),
    );

    const workflows: Record<string, string> = {
      "plan.yml": "name: Read-only AI PLAN\nrun: produce bounded PLAN artifact\n",
      "plan-authorize.yml": "name: PLAN_AUTHORIZE\nrun: validate exact human PLAN approval\n",
      "implement.yml": "name: IMPLEMENT\nrun: consume trusted implementation contract\n",
      "trusted-rail.yml": "name: VERIFY\nrun: verify exact published SHA\n",
      "orchestrator.yml": "name: Orchestrator\nrun: choose MERGE_READY or STOPPED without auto merge\n",
    };
    for (const [name, content] of Object.entries(workflows)) {
      writeFileSync(join(root, ".github", "workflows", name), content);
    }
    writeFileSync(
      join(root, ".github", "workflows", "noisy.yml"),
      "name: unrelated\nrun: PLAN PLAN_AUTHORIZE IMPLEMENT VERIFY MERGE_READY STOPPED\n",
    );

    const requirement = "`PLAN`, `PLAN_AUTHORIZE`, `IMPLEMENT`, `VERIFY`, `MERGE_READY`, `STOPPED` 상태를 사람이 이해하기 쉬운 한국어로 표시한다.";
    const initial = selectPlanContext(requirement, root, "example/framework", "d".repeat(40), {
      maxFiles: 2,
      maxBytes: 12_000,
      maxFileBytes: 4_000,
    });
    const augmented = augmentPlanContextWithHumanOutputSurfaces(requirement, root, initial);

    assert.doesNotThrow(() => verifyPlanContextPack(augmented));
    const paths = new Set(augmented.files.map((file) => file.path));
    for (const required of [
      ".github/workflows/plan.yml",
      ".github/workflows/plan-authorize.yml",
      ".github/workflows/implement.yml",
      ".github/workflows/trusted-rail.yml",
      ".github/workflows/orchestrator.yml",
      "src/self-improvement/state.ts",
      "src/self-improvement/implement-contract.ts",
      "package.json",
    ]) {
      assert.ok(paths.has(required), `missing lifecycle context: ${required}; got=${[...paths].join(", ")}`);
    }
    assert.ok(!paths.has(".github/workflows/noisy.yml"), `unmapped noisy workflow must be evicted: ${[...paths].join(", ")}`);
    assert.equal(augmented.files.length, 8);
    assert.ok(augmented.totalBytes <= 80_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime source must contain an executable API callsite, not only a string or comment mention", () => {
  const root = mkdtempSync(join(tmpdir(), "planner-human-output-source-call-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "state.ts"), "export const state = 'CORE_STATE';\n");
    writeFileSync(
      join(root, "src", "marker-only.ts"),
      "const marker = 'github.rest.issues.createComment(';\n// github.rest.issues.createComment({ body: 'comment only' });\n",
    );
    writeFileSync(
      join(root, "src", "commenter.ts"),
      "export async function publish(github: any) { await github.rest.issues.createComment({ body: '사용자 상태' }); }\n",
    );

    const requirement = "`CORE_STATE` 상태를 사용자에게 표시한다.";
    const initial = selectPlanContext(requirement, root, "example/framework", "c".repeat(40), {
      maxFiles: 1,
      maxBytes: 8_000,
      maxFileBytes: 4_000,
    });
    const augmented = augmentPlanContextWithHumanOutputSurfaces(requirement, root, initial);
    const paths = augmented.files.map((file) => file.path);

    assert.ok(paths.includes("src/state.ts"));
    assert.ok(paths.includes("src/commenter.ts"), `missing executable source callsite: ${paths.join(", ")}`);
    assert.ok(!paths.includes("src/marker-only.ts"), `string/comment mention must not be promoted: ${paths.join(", ")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non human-facing requirement keeps the primary PLAN context unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "planner-human-output-off-"));
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(join(root, "src", "contract.ts"), "PLAN_AUTHORIZE contract digest\n");
    writeFileSync(
      join(root, ".github", "workflows", "comment.yml"),
      "script: |\n  await github.rest.issues.createComment({ body: 'hello' });\n",
    );

    const requirement = "`PLAN_AUTHORIZE` contract digest validation";
    const initial = selectPlanContext(requirement, root, "example/framework", "b".repeat(40), {
      maxFiles: 2,
      maxBytes: 8_000,
      maxFileBytes: 4_000,
    });
    const augmented = augmentPlanContextWithHumanOutputSurfaces(requirement, root, initial);
    assert.deepEqual(augmented, initial);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
