import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { selectPlanContext, verifyPlanContextPack, type PlanContextFile, type PlanContextPack } from "../src/self-improvement/planner.js";
import { augmentPlanContextWithDirectTestEvidence } from "../src/self-improvement/plan-business-context.js";
import { prioritizedRequirementPaths } from "../src/self-improvement/plan-explicit-path-context.js";
import { requirementOutOfScopePaths } from "../src/self-improvement/plan-context-policy.js";

// App #310 첫 PLAN(run 37265738573): "`src/fulfillment-risk.ts` 정리는 이 Issue 밖"이라는 문장 때문에
// 그 파일과 테스트가 Context 앞자리를 차지했고, 화면 source는 빠졌다.
test("문장으로 범위 밖이라고 적은 경로를 찾는다", () => {
  const requirement = [
    "# 공급 위험 정렬",
    "",
    "- 파일 삭제는 하지 않습니다. 쓰이지 않는 `src/fulfillment-risk.ts` 정리는 이 Issue 밖입니다.",
    "- `src/legacy-a.ts`는 범위 밖이다.",
    "- `src/later.ts` 변경은 별도 Issue로 다룹니다.",
    "- `src/old.ts` cleanup is out of scope.",
    "- 화면은 `src/web-main.ts`를 고칩니다.",
    "",
    "## 범위 밖",
    "",
    "- `src/section-a.ts`",
    "- `docs/section-b.md`",
    "",
    "## 관련 파일",
    "",
    "- `src/related.ts`",
  ].join("\n");
  assert.deepEqual([...requirementOutOfScopePaths(requirement)].sort(), [
    "docs/section-b.md",
    "src/fulfillment-risk.ts",
    "src/later.ts",
    "src/legacy-a.ts",
    "src/old.ts",
    "src/section-a.ts",
  ]);
});

test("범위 밖 문장 밖에서도 언급된 경로는 범위 밖으로 보지 않는다", () => {
  const requirement = [
    "- `src/shared.ts` 정리는 이 Issue 밖입니다.",
    "- 대신 `src/shared.ts`의 정렬 함수를 화면에서 씁니다.",
  ].join("\n");
  assert.deepEqual([...requirementOutOfScopePaths(requirement)], []);
});

test("범위 밖 표시가 없는 금지 문장은 경로를 범위 밖으로 만들지 않는다", () => {
  const requirement = "- `src/batch-order-analysis.ts`의 배분 계산은 바꾸지 않습니다.";
  assert.deepEqual([...requirementOutOfScopePaths(requirement)], []);
});

test("범위 밖 경로는 PLAN Context 우선 경로가 되지 않는다", () => {
  const root = mkdtempSync(join(tmpdir(), "planner-out-of-scope-"));
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "test"));
    writeFileSync(join(root, "src", "legacy.ts"), "export const legacyRisk = 1;\n");
    writeFileSync(join(root, "test", "legacy.test.ts"), "import { legacyRisk } from '../src/legacy.js';\nvoid legacyRisk;\n");
    writeFileSync(join(root, "src", "supply.ts"), "export function supplyRiskOrders() { return ['공급', '위험', '정렬']; }\n");
    writeFileSync(join(root, "test", "supply.test.ts"), "import { supplyRiskOrders } from '../src/supply.js';\nvoid supplyRiskOrders;\n");
    const requirement = [
      "공급 위험 정렬을 한 곳에서 정합니다.",
      "",
      "- 쓰이지 않는 `src/legacy.ts` 정리는 이 Issue 밖입니다.",
    ].join("\n");

    assert.deepEqual(prioritizedRequirementPaths(requirement), []);
    const pack = selectPlanContext(requirement, root, "example/app", "a".repeat(40));
    const paths = pack.files.map((file) => file.path);
    assert.equal(paths[0], "src/supply.ts", paths.join(", "));
    if (paths.includes("src/legacy.ts")) assert.ok(paths.indexOf("src/legacy.ts") > paths.indexOf("test/supply.test.ts"), paths.join(", "));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function contextFile(path: string, content: string, index: number): PlanContextFile {
  return {
    evidenceId: `E${index + 1}`,
    path,
    startOffset: 0,
    byteLength: Buffer.byteLength(content, "utf8"),
    digestAlgorithm: "sha256",
    contentDigest: createHash("sha256").update(content, "utf8").digest("hex"),
    content,
  };
}

function pack(entries: readonly [string, string][]): PlanContextPack {
  const files = entries.map(([path, content], index) => contextFile(path, content, index));
  const payload = {
    schemaVersion: 1 as const,
    kind: "trusted-plan-context-pack" as const,
    repository: "example/app",
    sha: "b".repeat(40),
    files,
    totalBytes: files.reduce((sum, file) => sum + file.byteLength, 0),
  };
  const contextDigest = createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
  const result: PlanContextPack = { ...payload, digestAlgorithm: "sha256", contextDigest };
  verifyPlanContextPack(result);
  return result;
}

// App #310 첫 PLAN: 보호할 source/직접 테스트 쌍이 80KB를 조금 넘자 src/web-main.ts(20KB)를 통째로 뺐고,
// 빈 20KB는 그대로 남았다(총 60,000B).
test("직접 테스트가 들어가지 않아 뺀 source는 남은 예산으로 직접 테스트와 함께 다시 넣는다", () => {
  const root = mkdtempSync(join(tmpdir(), "planner-refill-"));
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "test"));
    const body = (name: string, bytes: number) => `// ${name}\n${"x".repeat(bytes - name.length - 4)}\n`;
    const a = body("a", 6_300);
    const aTest = `import { a } from '../src/a.js';\n${body("a.test", 12_700)}`;
    const b = body("b", 6_300);
    const bTest = `import { b } from '../src/b.js';\n${body("b.test", 14_700)}`;
    const web = body("web", 31_000);
    const webTest = `import '../src/web.js';\n${body("web.test", 29_000)}`;
    const readme = body("readme", 19_800);
    for (const [path, content] of [
      ["src/a.ts", a], ["test/a.test.ts", aTest], ["src/b.ts", b], ["test/b.test.ts", bTest],
      ["src/web.ts", web], ["test/web.test.ts", webTest], ["README.md", readme],
    ] as const) writeFileSync(join(root, path), content);

    const before = pack([
      ["src/a.ts", a],
      ["test/a.test.ts", aTest],
      ["src/web.ts", web.slice(0, 20_000)],
      ["test/b.test.ts", bTest],
      ["README.md", readme],
      ["src/b.ts", b],
    ]);
    const after = augmentPlanContextWithDirectTestEvidence(root, before);
    verifyPlanContextPack(after);
    const paths = after.files.map((file) => file.path);
    assert.ok(paths.includes("src/web.ts"), paths.join(", "));
    assert.ok(paths.includes("test/web.test.ts"), paths.join(", "));
    for (const kept of ["src/a.ts", "test/a.test.ts", "src/b.ts", "test/b.test.ts"]) assert.ok(paths.includes(kept), kept);
    const webFile = after.files.find((file) => file.path === "src/web.ts")!;
    assert.equal(webFile.content, web.slice(0, webFile.byteLength));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("다른 Issue를 가리키기만 하는 '별도 Issue' 문장은 범위 밖 표시가 아니다", () => {
  const requirement = "- 별도 Issue #123에서 만든 `src/shared-sort.ts`를 재사용합니다.";
  assert.deepEqual([...requirementOutOfScopePaths(requirement)], []);
});

test("작은 source와 직접 테스트는 최소 크기와 상관없이 그대로 다시 넣는다", () => {
  const root = mkdtempSync(join(tmpdir(), "planner-refill-small-"));
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "test"));
    const big = (name: string) => `// ${name}\n${"x".repeat(19_990)}\n`;
    const files: [string, string][] = [];
    for (const name of ["a", "b"]) {
      files.push([`src/${name}.ts`, big(name).slice(0, 19_000)]);
      files.push([`test/${name}.test.ts`, `import { ${name} } from '../src/${name}.js';\n${big(`${name}.test`)}`.slice(0, 20_000)]);
    }
    const small = "export const small = 1;\n";
    const smallTest = "import { small } from '../src/small.js';\nvoid small;\n";
    for (const [path, content] of files) writeFileSync(join(root, path), content);
    writeFileSync(join(root, "src", "small.ts"), small);
    writeFileSync(join(root, "test", "small.test.ts"), smallTest);
    // a/b 쌍만으로 78,000B다. small.ts를 넣으면 직접 테스트가 들어갈 자리가 없어 small.ts가 빠진다.
    const before = pack([files[0]!, files[1]!, files[2]!, ["src/small.ts", small], files[3]!]);
    const after = augmentPlanContextWithDirectTestEvidence(root, before);
    verifyPlanContextPack(after);
    const paths = after.files.map((file) => file.path);
    assert.ok(paths.includes("src/small.ts") && paths.includes("test/small.test.ts"), paths.join(", "));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
