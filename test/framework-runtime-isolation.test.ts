import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const workflows = [
  ".github/workflows/plan.yml",
  ".github/workflows/plan-authorize.yml",
  ".github/workflows/plan-candidate-bridge.yml",
  ".github/workflows/plan-implement-handoff.yml",
  ".github/workflows/plan-implement-worker.yml",
  ".github/workflows/plan-recovery.yml",
] as const;

test("Framework TypeScript control runtime은 App package와 분리된다", async () => {
  for (const path of workflows) {
    const workflow = await readFile(path, "utf8");
    assert.doesNotMatch(workflow, /node --import tsx/);
    assert.match(workflow, /\.framework-runtime\/node_modules\/\.bin\/tsx/);
    assert.match(workflow, /npm ci --ignore-scripts --prefix \.framework-runtime/);
  }
});

test("distribution은 canonical package metadata를 숨은 Framework runtime 경로로 배포한다", async () => {
  const ownership = JSON.parse(await readFile("policy/framework-distribution-ownership.v1.json", "utf8"));
  const bySource = new Map(ownership.entries.map((entry: { sourcePath: string; targetPath: string }) => [entry.sourcePath, entry.targetPath]));
  assert.equal(bySource.get("package.json"), ".framework-runtime/package.json");
  assert.equal(bySource.get("package-lock.json"), ".framework-runtime/package-lock.json");
});
