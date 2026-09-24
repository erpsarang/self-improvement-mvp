import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Framework runtime(.framework-runtime)은 배포본(App)에서는 distribution이 만들고,
// canonical Framework repo에서는 존재하지 않는다 (root package.json이 곧 Framework package).
// PLAN 계열 workflow는 둘 다에서 같은 install/실행 경로를 써야 하므로, Framework control checkout 직후에
// canonical source tree일 때만 같은 layout을 materialize한다 (regression: self-improvement-mvp #244 PLAN run 35965051596).
const workflows = [
  ".github/workflows/plan.yml",
  ".github/workflows/plan-authorize.yml",
  ".github/workflows/plan-candidate-bridge.yml",
  ".github/workflows/plan-implement-handoff.yml",
  ".github/workflows/plan-implement-worker.yml",
  ".github/workflows/plan-recovery.yml",
] as const;

const INSTALL = "npm ci --ignore-scripts --prefix .framework-runtime";
const LAYOUT_STEP_NAME = "Framework runtime layout 준비";
const CANONICAL_PACKAGE_NAME = "self-improvement-mvp";
const LAYOUT_RUN = [
  `if grep -q '"name": "${CANONICAL_PACKAGE_NAME}"' package.json; then`,
  "mkdir -p .framework-runtime",
  "cp package.json package-lock.json .framework-runtime/",
  "fi",
];

interface Step {
  readonly lines: string[];
  readonly name: string | null;
  readonly condition: string | null;
  readonly workingDirectory: string | null;
  readonly checkoutPath: string | null | undefined; // undefined: not a checkout step
  readonly runBlock: string[];
}

function field(lines: string[], prefix: string): string | null {
  const line = lines.find((l) => l.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : null;
}

function parseSteps(workflow: string): Step[] {
  const lines = workflow.split("\n");
  const starts = lines.flatMap((line, index) => (/^      - /.test(line) ? [index] : []));
  return starts.map((start, i) => {
    const end = starts[i + 1] ?? lines.length;
    const body = lines.slice(start, end);
    const runIndex = body.findIndex((l) => /^(?:        |      - )run: \|$/.test(l));
    const runBlock = runIndex === -1
      ? []
      : body.slice(runIndex + 1).filter((l) => l.trim() !== "").map((l) => l.trim());
    const isCheckout = body.some((l) => l.includes("uses: actions/checkout@v4"));
    return {
      lines: body,
      name: field(body, "      - name: "),
      condition: field(body, "        if: "),
      workingDirectory: field(body, "        working-directory: "),
      checkoutPath: isCheckout ? field(body, "          path: ") : undefined,
      runBlock,
    };
  });
}

test("guard 패턴은 canonical Framework root package.json과 일치한다", () => {
  const pkg = readFileSync("package.json", "utf8");
  assert.match(pkg, new RegExp(`"name": "${CANONICAL_PACKAGE_NAME}"`));
  assert.equal(JSON.parse(pkg).name, CANONICAL_PACKAGE_NAME);
});

test("모든 Framework runtime install은 같은 checkout 직후의 layout 준비 step을 전제로 한다", () => {
  let installs = 0;
  for (const path of workflows) {
    const steps = parseSteps(readFileSync(path, "utf8"));
    steps.forEach((step, index) => {
      if (!step.runBlock.includes(INSTALL)) return;
      installs += 1;
      const label = `${path} install #${installs} (${step.workingDirectory ?? "<root>"})`;

      // install step이 실행되는 Framework control checkout: working-directory와 path가 exact match하는 직전 checkout.
      let checkoutIndex = -1;
      for (let i = index - 1; i >= 0; i -= 1) {
        const candidate = steps[i]!;
        if (candidate.checkoutPath === undefined) continue;
        if (candidate.checkoutPath === step.workingDirectory) {
          checkoutIndex = i;
          break;
        }
      }
      assert.ok(checkoutIndex >= 0, `${label}: Framework control checkout not found`);
      const checkout = steps[checkoutIndex]!;

      // layout 준비는 checkout 바로 다음 step이고, 같은 if / working-directory를 가지며, run block은 canonical 그대로다.
      const layout = steps[checkoutIndex + 1];
      assert.ok(layout, `${label}: no step after checkout`);
      assert.equal(layout.name, LAYOUT_STEP_NAME, label);
      assert.equal(layout.condition, checkout.condition, `${label}: layout step must share the checkout condition`);
      assert.equal(layout.workingDirectory, step.workingDirectory, `${label}: layout step must run in the checkout`);
      assert.deepEqual(layout.runBlock, LAYOUT_RUN, label);
      assert.ok(!layout.lines.some((l) => l.includes("uses:")), `${label}: layout step is plain shell`);

      // checkout과 install 사이의 setup-node cache path는 layout 준비 이후에만 평가된다.
      for (let i = checkoutIndex + 2; i < index; i += 1) {
        const between = steps[i]!;
        assert.notEqual(between.name, LAYOUT_STEP_NAME, `${label}: duplicate layout step`);
      }
      const cacheStep = steps.slice(checkoutIndex + 1, index).find((s) => s.lines.some((l) => l.includes("cache-dependency-path")));
      if (cacheStep) {
        const cachePath = field(cacheStep.lines, "          cache-dependency-path: ");
        const expected = step.workingDirectory ? `${step.workingDirectory}/.framework-runtime/package-lock.json` : ".framework-runtime/package-lock.json";
        assert.equal(cachePath, expected, `${label}: cache path must point at the materialized lockfile`);
      }
    });
  }
  assert.equal(installs, 11, "every Framework runtime install site is covered");
});

test(
  "layout 준비는 canonical source tree에서만 root manifest를 복사하고 배포본은 건드리지 않는다",
  { skip: process.platform === "win32" ? "bash step semantics (CI runs ubuntu)" : false },
  () => {
    const planWorkflow = readFileSync(".github/workflows/plan.yml", "utf8");
    const layout = parseSteps(planWorkflow).find((s) => s.name === LAYOUT_STEP_NAME);
    assert.ok(layout);
    // workflow가 실행하는 명령을 그대로 사용한다 (들여쓰기만 제거).
    const script = layout.lines
      .slice(layout.lines.findIndex((l) => /^        run: \|$/.test(l)) + 1)
      .map((l) => l.replace(/^          /, ""))
      .join("\n");
    const run = (cwd: string) => spawnSync("bash", ["-e", "-c", script], { cwd, encoding: "utf8" });

    const root = mkdtempSync(join(tmpdir(), "framework-runtime-layout-"));
    try {
      // 1) canonical Framework checkout: root manifest가 .framework-runtime으로 materialize된다 (idempotent).
      const canonical = join(root, "canonical");
      mkdirSync(canonical);
      cpSync("package.json", join(canonical, "package.json"));
      cpSync("package-lock.json", join(canonical, "package-lock.json"));
      for (let i = 0; i < 2; i += 1) {
        const result = run(canonical);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(readFileSync(join(canonical, ".framework-runtime", "package.json"), "utf8"), readFileSync("package.json", "utf8"));
        assert.equal(readFileSync(join(canonical, ".framework-runtime", "package-lock.json"), "utf8"), readFileSync("package-lock.json", "utf8"));
      }

      // 2) App 배포본: distribution이 둔 .framework-runtime을 그대로 두고 App root manifest는 복사하지 않는다.
      const app = join(root, "app");
      mkdirSync(join(app, ".framework-runtime"), { recursive: true });
      writeFileSync(join(app, "package.json"), JSON.stringify({ name: "sales-order-app", private: true }));
      writeFileSync(join(app, "package-lock.json"), "{}\n");
      writeFileSync(join(app, ".framework-runtime", "package.json"), "distributed\n");
      writeFileSync(join(app, ".framework-runtime", "package-lock.json"), "distributed-lock\n");
      const appResult = run(app);
      assert.equal(appResult.status, 0, appResult.stderr);
      assert.equal(readFileSync(join(app, ".framework-runtime", "package.json"), "utf8"), "distributed\n");
      assert.equal(readFileSync(join(app, ".framework-runtime", "package-lock.json"), "utf8"), "distributed-lock\n");

      // 3) .framework-runtime이 빠진 App: App 의존성으로 Framework를 조용히 실행하지 않는다 (이후 npm ci가 fail-closed).
      const broken = join(root, "broken");
      mkdirSync(broken);
      writeFileSync(join(broken, "package.json"), JSON.stringify({ name: "sales-order-app", private: true }));
      writeFileSync(join(broken, "package-lock.json"), "{}\n");
      const brokenResult = run(broken);
      assert.equal(brokenResult.status, 0, brokenResult.stderr);
      assert.ok(!existsSync(join(broken, ".framework-runtime")), "App manifests must never be promoted to the Framework runtime");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
