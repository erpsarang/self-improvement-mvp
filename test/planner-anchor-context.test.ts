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

test("definition-bearing runtime sources outrank test and docs mentions of the same anchors", () => {
  const root = mkdtempSync(join(tmpdir(), "planner-anchor-role-"));
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "test"));
    mkdirSync(join(root, "docs"));
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });

    writeFileSync(join(root, "src", "orchestrator.ts"), "export type State = 'MERGE_READY' | 'STOPPED';\n");
    writeFileSync(join(root, "src", "plan-authorization.ts"), "export const state = 'PLAN_AUTHORIZE';\n");
    writeFileSync(join(root, "test", "state.test.ts"), "MERGE_READY STOPPED PLAN_AUTHORIZE\n".repeat(50));
    writeFileSync(join(root, "docs", "state.md"), "MERGE_READY STOPPED PLAN_AUTHORIZE\n".repeat(50));
    writeFileSync(join(root, ".github", "workflows", "status.yml"), "name: WORKFLOW_ONLY\n");
    writeFileSync(join(root, "test", "workflow.test.ts"), "WORKFLOW_ONLY\n".repeat(50));
    writeFileSync(join(root, "docs", "workflow.md"), "WORKFLOW_ONLY\n".repeat(50));

    const pack = selectPlanContext(
      "`MERGE_READY`, `STOPPED`, `PLAN_AUTHORIZE`, `WORKFLOW_ONLY` 상태를 표시한다.",
      root,
      "example/framework",
      "c".repeat(40),
      { maxFiles: 3, maxBytes: 12_000, maxFileBytes: 4_000 },
    );

    const paths = pack.files.map((file) => file.path);
    assert.deepEqual(paths, [
      "src/orchestrator.ts",
      "src/plan-authorization.ts",
      ".github/workflows/status.yml",
    ]);
    assert.ok(!paths.some((path) => path.startsWith("test/")));
    assert.ok(!paths.some((path) => path.startsWith("docs/")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow-only anchor outranks test and docs when no runtime source defines it", () => {
  const root = mkdtempSync(join(tmpdir(), "planner-anchor-workflow-"));
  try {
    mkdirSync(join(root, "test"));
    mkdirSync(join(root, "docs"));
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(join(root, ".github", "workflows", "authorize.yml"), "name: PLAN_AUTHORIZE_WORKFLOW\n");
    writeFileSync(join(root, "test", "authorize.test.ts"), "PLAN_AUTHORIZE_WORKFLOW\n".repeat(30));
    writeFileSync(join(root, "docs", "authorize.md"), "PLAN_AUTHORIZE_WORKFLOW\n".repeat(30));

    const pack = selectPlanContext(
      "`PLAN_AUTHORIZE_WORKFLOW` 동작을 설명한다.",
      root,
      "example/framework",
      "d".repeat(40),
      { maxFiles: 1, maxBytes: 4_000, maxFileBytes: 4_000 },
    );
    assert.equal(pack.files[0]?.path, ".github/workflows/authorize.yml");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("요구에 명시된 여러 exact path는 lexical noise보다 먼저 budget 안에 모두 보존된다", () => {
  const root = mkdtempSync(join(tmpdir(), "planner-explicit-paths-"));
  try {
    mkdirSync(join(root, "src", "self-improvement"), { recursive: true });
    mkdirSync(join(root, "test"));

    writeFileSync(join(root, "src", "order-analysis.ts"), "export const order = 'exceptionGuides';\n");
    writeFileSync(join(root, "test", "order-analysis.test.ts"), "import '../src/order-analysis.js';\n");
    writeFileSync(join(root, "test", "batch-order-analysis.test.ts"), "export const batch = true;\n");
    writeFileSync(join(root, "src", "app-evidence.ts"), "export const budget = 8192;\n");
    writeFileSync(join(root, "test", "app-evidence.test.ts"), "import '../src/app-evidence.js';\n");
    writeFileSync(
      join(root, "src", "self-improvement", "planner.ts"),
      "PLAN implementationScope Runtime Evidence exceptionGuides bounded budget ".repeat(200),
    );
    writeFileSync(
      join(root, "test", "planner-noise.test.ts"),
      "PLAN Runtime Evidence exceptionGuides bounded budget ".repeat(200),
    );

    const requirement = [
      "이전 PLAN allowedPaths는 `src/order-analysis.ts`, `test/order-analysis.test.ts`, `test/batch-order-analysis.test.ts`였다.",
      "Runtime Evidence 실패는 `src/app-evidence.ts`와 `test/app-evidence.test.ts`를 반드시 확인해야 한다.",
    ].join("\n");

    const pack = selectPlanContext(
      requirement,
      root,
      "example/orders",
      "e".repeat(40),
      { maxFiles: 6, maxBytes: 24_000, maxFileBytes: 4_000 },
    );
    const paths = pack.files.map((file) => file.path);

    assert.deepEqual(paths.slice(0, 5), [
      "src/order-analysis.ts",
      "test/order-analysis.test.ts",
      "test/batch-order-analysis.test.ts",
      "src/app-evidence.ts",
      "test/app-evidence.test.ts",
    ]);
    assert.ok(paths.length <= 6);
    assert.ok(pack.totalBytes <= 24_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("요구의 npm run script가 가리키는 runtime entrypoint와 direct test를 Context Pack에 예약한다", () => {
  const root = mkdtempSync(join(tmpdir(), "planner-npm-script-"));
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "test"));

    writeFileSync(join(root, "package.json"), JSON.stringify({
      scripts: {
        analyze: "node --import tsx src/order-analysis-cli.ts",
      },
    }));
    writeFileSync(
      join(root, "src", "order-analysis-cli.ts"),
      "export async function runOrderAnalysisCli() { return '분석'; }\n",
    );
    writeFileSync(
      join(root, "test", "order-analysis-cli.test.ts"),
      "import { runOrderAnalysisCli } from '../src/order-analysis-cli.js';\nvoid runOrderAnalysisCli;\n",
    );
    writeFileSync(
      join(root, "src", "analysis-noise.ts"),
      "analyze csv orders output exception analyze csv orders output exception\n".repeat(100),
    );
    writeFileSync(
      join(root, "test", "analysis-noise.test.ts"),
      "analyze csv orders output exception\n".repeat(100),
    );

    const pack = selectPlanContext(
      "기존 `npm run analyze -- orders.json`는 유지하고 `--csv` 옵션을 추가한다.",
      root,
      "example/orders",
      "f".repeat(40),
      { maxFiles: 3, maxBytes: 12_000, maxFileBytes: 4_000 },
    );
    const paths = pack.files.map((file) => file.path);

    assert.ok(paths.includes("src/order-analysis-cli.ts"), `missing script entrypoint: ${paths.join(", ")}`);
    assert.ok(paths.includes("test/order-analysis-cli.test.ts"), `missing direct CLI test: ${paths.join(", ")}`);
    assert.ok(paths.includes("package.json"), `missing package script contract: ${paths.join(", ")}`);
    assert.ok(!paths.includes("src/analysis-noise.ts"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("npm run source/direct test/package 계약은 큰 relevance 파일의 byte budget보다 먼저 보존된다", () => {
  const root = mkdtempSync(join(tmpdir(), "planner-npm-byte-reserve-"));
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "test"));

    writeFileSync(join(root, "package.json"), JSON.stringify({
      scripts: { analyze: "node --import tsx src/order-analysis-cli.ts" },
    }));
    writeFileSync(
      join(root, "src", "order-analysis-cli.ts"),
      "export async function runOrderAnalysisCli() { return 'ok'; }\n",
    );
    writeFileSync(
      join(root, "test", "order-analysis-cli.test.ts"),
      "import { runOrderAnalysisCli } from '../src/order-analysis-cli.js';\nvoid runOrderAnalysisCli;\n",
    );
    for (const [name, anchor] of [
      ["csv-noise.ts", "CSV"],
      ["excel-noise.ts", "EXCEL"],
      ["output-noise.ts", "OUTPUT"],
      ["exception-noise.ts", "EXCEPTION"],
    ] as const) {
      writeFileSync(join(root, "src", name), `${anchor} `.repeat(5000));
    }

    const pack = selectPlanContext(
      "기존 `npm run analyze -- orders.json`를 유지하고 CSV EXCEL OUTPUT EXCEPTION 요구를 지원한다.",
      root,
      "example/orders",
      "a".repeat(40),
      { maxFiles: 8, maxBytes: 12_000, maxFileBytes: 4_000 },
    );
    const paths = pack.files.map((file) => file.path);

    assert.deepEqual(paths.slice(0, 3), [
      "src/order-analysis-cli.ts",
      "test/order-analysis-cli.test.ts",
      "package.json",
    ]);
    assert.ok(pack.totalBytes <= 12_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
