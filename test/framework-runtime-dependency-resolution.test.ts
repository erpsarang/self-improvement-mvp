import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workflows = [
  ".github/workflows/plan.yml",
  ".github/workflows/plan-authorize.yml",
  ".github/workflows/plan-candidate-bridge.yml",
  ".github/workflows/plan-implement-handoff.yml",
  ".github/workflows/plan-implement-worker.yml",
  ".github/workflows/plan-recovery.yml",
] as const;

const INSTALL = "npm ci --ignore-scripts --prefix .framework-runtime";
const LINK = "ln -sT .framework-runtime/node_modules node_modules";

/** `run: |` block whose first line is the Framework dependency install. 각 install step의 모든 줄을 돌려준다. */
function installBlocks(workflow: string): string[][] {
  const lines = workflow.split("\n");
  const blocks: string[][] = [];
  lines.forEach((line, index) => {
    if (!line.includes(INSTALL)) return;
    assert.match(lines[index - 1] ?? "", /run: \|$/, `install must be the first line of a multi-line run block: ${line}`);
    const indent = line.length - line.trimStart().length;
    const block: string[] = [];
    for (let i = index; i < lines.length; i += 1) {
      const current = lines[i]!;
      if (current.trim() === "" || current.length - current.trimStart().length < indent) break;
      block.push(current.trim());
    }
    blocks.push(block);
  });
  return blocks;
}

test("모든 Framework runtime install step은 checkout root node_modules를 .framework-runtime/node_modules로 연결한다", async () => {
  for (const path of workflows) {
    const workflow = readFileSync(path, "utf8");
    const installs = workflow.split("\n").filter((line) => line.includes(INSTALL)).length;
    assert.ok(installs > 0, `${path} must install the Framework runtime`);
    const blocks = installBlocks(workflow);
    assert.equal(blocks.length, installs, path);
    for (const block of blocks) {
      assert.deepEqual(block, [INSTALL, LINK], `${path} install step must link node_modules right after install`);
    }
  }
});

// Git Bash on Windows의 `ln -s`는 symlink가 아닌 복사를 만들므로 symlink 의미를 검증할 수 있는 POSIX에서만 실행한다.
test(
  "Framework TypeScript handler는 .framework-runtime에 설치된 typescript를 resolve하여 실행을 시작한다",
  { skip: process.platform === "win32" ? "requires POSIX symlink semantics (CI runs ubuntu)" : false, timeout: 240_000 },
  () => {
    const planWorkflow = readFileSync(".github/workflows/plan.yml", "utf8");
    const [install] = installBlocks(planWorkflow);
    assert.ok(install);
    const handler = /run: (\.framework-runtime\/node_modules\/\.bin\/tsx src\/self-improvement\/planner-handler\.ts prepare)$/m.exec(planWorkflow)?.[1];
    assert.ok(handler, "plan.yml must run the PLAN prepare handler from .framework-runtime");

    const root = mkdtempSync(join(tmpdir(), "framework-runtime-resolution-"));
    try {
      // App repo에 배포된 Framework control checkout 형태: App root package.json은 typescript를 의존하지 않고,
      // Framework dependency는 .framework-runtime에만 설치된다.
      const control = join(root, "control");
      mkdirSync(join(control, ".framework-runtime"), { recursive: true });
      writeFileSync(join(control, "package.json"), JSON.stringify({ name: "app", private: true, type: "module" }));
      cpSync("package.json", join(control, ".framework-runtime", "package.json"));
      cpSync("package-lock.json", join(control, ".framework-runtime", "package-lock.json"));
      cpSync("src", join(control, "src"), { recursive: true });

      const target = join(root, "target");
      mkdirSync(join(target, "src"), { recursive: true });
      writeFileSync(join(target, "package.json"), JSON.stringify({ name: "app", scripts: { test: "node --test" } }));
      writeFileSync(join(target, "src", "util.ts"), "export const answer = 42;\n");
      writeFileSync(join(target, "src", "app.ts"), 'import { answer } from "./util.js";\nexport const value = answer;\n');
      const output = join(root, "output");
      mkdirSync(output);
      writeFileSync(join(output, "requirement.md"), "app.ts value 계산을 수정한다\n");

      const env = {
        ...process.env,
        PLAN_TARGET: target,
        PLAN_OUTPUT: output,
        PLAN_REQUIREMENT: join(output, "requirement.md"),
        PLAN_REPOSITORY: "example/app",
        PLAN_SHA: "0123456789abcdef0123456789abcdef01234567",
      };
      const bash = (command: string) => spawnSync("bash", ["-e", "-c", command], { cwd: control, env, encoding: "utf8", timeout: 200_000 });

      const [npmCi, ...link] = install;
      const installed = bash(npmCi!);
      assert.equal(installed.status, 0, installed.stderr);
      assert.ok(existsSync(join(control, ".framework-runtime", "node_modules", "typescript", "package.json")));
      assert.ok(!existsSync(join(control, "node_modules")), "App/checkout root must have no node_modules before the link step");

      // 회귀 재현: install만으로는 Node ESM이 typescript를 찾지 못한다 (clean App PLAN run 35661582667).
      const before = bash(handler);
      assert.notEqual(before.status, 0);
      assert.match(before.stderr, /ERR_MODULE_NOT_FOUND[\s\S]*Cannot find package 'typescript'/);

      // workflow step이 실제로 실행하는 link 명령을 그대로 적용한다.
      const linked = bash(link.join("\n"));
      assert.equal(linked.status, 0, linked.stderr);
      assert.equal(readlinkSync(join(control, "node_modules")), ".framework-runtime/node_modules");
      assert.equal(
        realpathSync(join(control, "node_modules", "typescript")),
        realpathSync(join(control, ".framework-runtime", "node_modules", "typescript")),
      );

      // 이제 handler가 typescript를 resolve하고 실제로 실행되어 AI 호출 없이 PLAN Context Pack을 만든다.
      const after = bash(handler);
      assert.equal(after.status, 0, `${after.stdout}\n${after.stderr}`);
      assert.doesNotMatch(after.stderr, /ERR_MODULE_NOT_FOUND|Cannot find package/);
      for (const name of ["input.json", "PLAN-context.json", "prompt.md", "schema.json"]) {
        assert.ok(existsSync(join(output, name)), `${name} must be produced by the handler`);
      }

      // link는 fail-closed: 이미 node_modules가 있으면 덮어쓰거나 그 안에 링크를 만들지 않고 실패한다.
      const again = bash(link.join("\n"));
      assert.notEqual(again.status, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
