import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sha256 } from "../src/self-improvement/implement.js";
import { validateFixRequestProvenance } from "../src/self-improvement/fix.js";
import {
  cyclePublishBranchName,
  legacyPublishBranchName,
} from "../src/self-improvement/publish-branch.js";

// App #250 multi-slice: 같은 Issue의 다음 slice가 이전 slice의 publish branch와 충돌하지 않아야 한다
// (Trusted Rail run 36285848604: "publish branch exists at an unexpected SHA").

const trustedRail = readFileSync(".github/workflows/trusted-rail.yml", "utf8");
const JS_BRANCH_PATTERN = "`^ai-publish/issue-${issueNumber}(?:-cycle-[0-9a-f]{16})?$`";

function listFiles(dir: string, suffix: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => join(entry.parentPath, entry.name));
}

test("publish branch 형식은 publish-branch.ts와 명시된 workflow consumer에만 있다", () => {
  const allowed = new Map<string, number>([
    [".github/workflows/orchestrator.yml", 2],
    [".github/workflows/post-merge-learn.yml", 1],
  ]);
  for (const file of listFiles(".github/workflows", ".yml")) {
    const text = readFileSync(file, "utf8");
    const patterns = text.split(JS_BRANCH_PATTERN).length - 1;
    assert.equal(patterns, allowed.get(file) ?? 0, `${file} JS branch pattern count`);
    // issue-only branch를 exact 비교하거나 artifact 이름에서 재구성하는 consumer가 남아 있으면 안 된다.
    assert.doesNotMatch(text, /[!=]==? `ai-publish\/issue-\$\{[^}]+\}`/, file);
    assert.doesNotMatch(text, /'ai-publish\/issue-\$1'/, file);
  }
  for (const file of listFiles("src", ".ts").filter((path) => !path.endsWith(".test.ts"))) {
    if (file === join("src", "self-improvement", "publish-branch.ts")) continue;
    assert.doesNotMatch(readFileSync(file, "utf8"), /ai-publish\/issue-/, `${file} must use publish-branch.ts`);
  }
});

test("workflow consumer의 branch 판별은 같은 Issue의 cycle/legacy 형식만 허용한다", () => {
  const branchPattern = new Function("issueNumber", `return new RegExp(${JS_BRANCH_PATTERN});`) as
    (issueNumber: number) => RegExp;
  const cycle = cyclePublishBranchName(250, "a".repeat(40), sha256("slice"));
  assert.ok(branchPattern(250).test(cycle));
  assert.ok(branchPattern(250).test(legacyPublishBranchName(250)));
  for (const rejected of [
    legacyPublishBranchName(25),
    cycle.replace("issue-250", "issue-251"),
    `${cycle}0`,
    cycle.replace("-cycle-", "/cycle-"),
    "main",
  ]) {
    assert.ok(!branchPattern(250).test(rejected), rejected);
  }
});

test("FIX request의 source REVIEW branch는 같은 Issue의 legacy/cycle 형식만 허용한다", () => {
  const request = (reviewedBranch: string) => ({
    type: "FIX_REQUEST",
    repository: "erpsarang/sales-order-exception-analyzer",
    issueNumber: 250,
    fixAttempt: 1,
    sourceReview: {
      artifactName: "review-provenance-issue-250-400-attempt-1",
      runId: 400,
      runAttempt: 1,
      reviewedBranch,
      reviewedHeadSha: "b".repeat(40),
      requirementsDigest: `sha256:${"2".repeat(64)}`,
      findingsDigest: `sha256:${"3".repeat(64)}`,
    },
    requestWorkflow: {
      workflowPath: ".github/workflows/fix-request.yml",
      runId: 500,
      runAttempt: 1,
      trustedCodeSha: "c".repeat(40),
    },
  });
  const cycle = cyclePublishBranchName(250, "a".repeat(40), sha256("slice"));
  assert.equal(validateFixRequestProvenance(request(cycle)).sourceReview.reviewedBranch, cycle);
  assert.equal(validateFixRequestProvenance(request("ai-publish/issue-250")).sourceReview.reviewedBranch, "ai-publish/issue-250");
  assert.throws(() => validateFixRequestProvenance(request("ai-publish/issue-251")), /FIX request/);
  assert.throws(() => validateFixRequestProvenance(request(`${cycle}0`)), /FIX request/);
});

// Trusted Rail PUBLISH step의 bash 본문을 그대로 꺼내 로컬 bare origin에 대해 실행한다.
function publishStepScript(): string {
  const lines = trustedRail.split("\n");
  const start = lines.findIndex((line) => line.trim() === "- name: sealed patch를 publish branch에 적용 및 push");
  assert.ok(start >= 0, "PUBLISH step must exist");
  const runIndex = lines.findIndex((line, index) => index > start && line.trim() === "run: |");
  const runIndent = lines[runIndex]!.length - lines[runIndex]!.trimStart().length;
  const body: string[] = [];
  for (const line of lines.slice(runIndex + 1)) {
    if (line.trim() !== "" && line.length - line.trimStart().length <= runIndent) break;
    body.push(line.slice(runIndent + 2));
  }
  return body.join("\n");
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function newFilePatch(path: string, content: string): string {
  return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+${content}\n`;
}

test("#250 multi-slice: 이전 slice branch가 남아 있어도 다음 slice는 새 cycle branch로 publish하고, 재시도와 FIX는 같은 branch를 쓴다", () => {
  const root = mkdtempSync(join(tmpdir(), "publish-multi-slice-"));
  try {
    const origin = join(root, "origin.git");
    const work = join(root, "work");
    const runnerTemp = join(root, "runner");
    spawnSync("mkdir", ["-p", runnerTemp]);
    git(root, "init", "--bare", "-q", "-b", "main", origin);
    git(root, "init", "-q", "-b", "main", work);
    git(work, "remote", "add", "origin", origin);
    writeFileSync(join(work, "README.md"), "app\n");
    git(work, "add", "README.md");
    git(work, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "base");
    git(work, "push", "-q", "origin", "main");
    const script = publishStepScript();

    const publish = (baseSha: string, branch: string, patchText: string) => {
      const patchPath = join(root, `${branch.replace(/\//g, "_")}-${baseSha.slice(0, 7)}.patch`);
      writeFileSync(patchPath, patchText);
      const output = join(root, `output-${Math.random().toString(16).slice(2)}`);
      writeFileSync(output, "");
      git(work, "fetch", "-q", "origin", "+refs/heads/*:refs/remotes/origin/*");
      const result = spawnSync("bash", ["-c", script], {
        cwd: work,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: root,
          BASE_SHA: baseSha,
          ISSUE_NUMBER: "250",
          PUBLISH_BRANCH: branch,
          SEALED_PATCH: patchPath,
          GITHUB_PUSH_TOKEN: "local-test-token",
          TRUSTED_PUBLISH_TOKEN: "",
          GITHUB_OUTPUT: output,
          RUNNER_TEMP: runnerTemp,
        },
      });
      const outputs = Object.fromEntries(
        readFileSync(output, "utf8").split("\n").filter(Boolean).map((line) => line.split("=", 2) as [string, string]),
      );
      return { status: result.status, stderr: result.stderr, outputs };
    };
    const remoteHead = (branch: string) =>
      git(work, "ls-remote", "--heads", "origin", `refs/heads/${branch}`).split(/\s+/)[0] ?? "";

    // slice 1: 이 변경 전 PUBLISH처럼 legacy issue-only branch에 공개되고 Human Merge된다.
    const base1 = git(work, "rev-parse", "HEAD");
    const slice1 = publish(base1, legacyPublishBranchName(250), newFilePatch("slice1.txt", "slice1"));
    assert.equal(slice1.status, 0, slice1.stderr);
    const slice1Head = slice1.outputs.published_head_sha!;
    git(work, "fetch", "-q", "origin");
    git(work, "push", "-q", "origin", `${slice1Head}:refs/heads/main`);
    const base2 = slice1Head;

    // slice 1 merge 뒤 main이 더 이동한다(실제 #250: Framework sync). 다음 slice의 base는 legacy branch head와 다르다.
    writeFileSync(join(work, "MAIN.md"), "moved\n");
    git(work, "checkout", "-q", "--detach", base2);
    git(work, "add", "MAIN.md");
    git(work, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "framework sync");
    const base3 = git(work, "rev-parse", "HEAD");
    git(work, "push", "-q", "origin", `${base3}:refs/heads/main`);
    // slice 2: 옛 issue-only identity로는 남아 있는 slice 1 branch 때문에 fail-closed 된다 (관측된 #250 장애).
    const patch2 = newFilePatch("slice2.txt", "slice2");
    const blocked = publish(base3, legacyPublishBranchName(250), patch2);
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /publish branch exists at an unexpected SHA; refusing non-fast-forward overwrite/);

    // 새 identity: 같은 Issue의 다음 slice는 다른 cycle branch로 publish된다.
    const legacyBefore = remoteHead(legacyPublishBranchName(250));
    const branch2 = cyclePublishBranchName(250, base3, sha256(Buffer.from(patch2)));
    const created = publish(base3, branch2, patch2);
    assert.equal(created.status, 0, created.stderr);
    assert.equal(created.outputs.publish_mode, "created");
    const slice2Head = created.outputs.published_head_sha!;
    assert.equal(remoteHead(branch2), slice2Head);
    assert.equal(git(work, "rev-parse", `${slice2Head}^`), base3);
    assert.equal(remoteHead(legacyPublishBranchName(250)), legacyBefore, "legacy branch must stay untouched");

    // 같은 cycle 재시도: 같은 branch의 exact head를 재사용한다.
    const retry = publish(base3, branch2, patch2);
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(retry.outputs.publish_mode, "reused");
    assert.equal(retry.outputs.published_head_sha, slice2Head);

    // 다른 cycle(같은 base, 다른 patch)은 다른 branch다.
    const patch3 = newFilePatch("slice3.txt", "slice3");
    assert.notEqual(cyclePublishBranchName(250, base3, sha256(Buffer.from(patch3))), branch2);

    // FIX: 새 cycle branch를 만들지 않고 source REVIEW branch 위에 fast-forward한다.
    const fix = publish(slice2Head, branch2, newFilePatch("fix.txt", "fix"));
    assert.equal(fix.status, 0, fix.stderr);
    assert.equal(fix.outputs.publish_mode, "created");
    assert.equal(git(work, "rev-parse", `${fix.outputs.published_head_sha}^`), slice2Head);
    assert.equal(remoteHead(branch2), fix.outputs.published_head_sha);

    // 다른 Issue의 branch 이름은 PUBLISH step에서 거부한다.
    const wrongIssue = publish(base3, cyclePublishBranchName(251, base3, sha256(Buffer.from(patch3))), patch3);
    assert.notEqual(wrongIssue.status, 0);
    assert.match(wrongIssue.stderr, /invalid publish branch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
