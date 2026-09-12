import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createImplementContextPack } from "../src/self-improvement/context-pack.js";
import {
  applyCandidateToExactBase,
  createValidationPlan,
  parseValidationCommand,
  runDeterministicValidation,
  verifyDeterministicValidationResult,
} from "../src/self-improvement/deterministic-ci.js";
import { createImplementContract, type ApprovedPlanIdentity } from "../src/self-improvement/implement-contract.js";
import { createCandidateChangeSet } from "../src/self-improvement/single-pass-worker.js";

const identity: ApprovedPlanIdentity = {
  requirement: { issueNumber: 76, digest: "a".repeat(64) },
  repository: "erpsarang/self-improvement-mvp",
  targetSha: "b".repeat(40),
  plan: {
    runId: 4001,
    runAttempt: 1,
    artifact: { name: "plan-76", id: 201, digest: "c".repeat(64) },
    provenanceArtifact: { name: "plan-76-provenance", id: 202, digest: "d".repeat(64) },
  },
  approval: { commentId: 9101, approverUserId: 8370921 },
};

function fixture(commands: readonly string[] = ["npm test", "npm run build"]) {
  const root = mkdtempSync(join(tmpdir(), "deterministic-ci-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n", "utf8");

  const contract = createImplementContract(identity, {
    allowedPaths: ["src/a.ts", "src/new.ts"],
    requiredChanges: ["허용된 파일만 변경"],
    forbiddenChanges: ["다른 파일 변경 금지"],
    validationCommands: commands,
    maxFilesChanged: 2,
    maxContextBytes: 4096,
    maxPatchBytes: 4096,
  });
  const contextPack = createImplementContextPack(contract, root, identity.targetSha);
  const present = contextPack.files.find(({ path }) => path === "src/a.ts");
  if (!present || present.state !== "present") throw new Error("fixture present file missing");
  const candidate = createCandidateChangeSet(contract, contextPack, {
    summary: "기존 파일 수정과 신규 파일 생성",
    changes: [
      { path: "src/a.ts", operation: "modify", baseContentDigest: present.contentDigest, content: "export const a = 2;\n" },
      { path: "src/new.ts", operation: "create", baseContentDigest: null, content: "export const n = 1;\n" },
    ],
  });
  return { root, contract, contextPack, candidate };
}

test("validated candidate를 exact base에만 적용한다", () => {
  const { root, contract, contextPack, candidate } = fixture();
  try {
    const applied = applyCandidateToExactBase(contract, contextPack, candidate, root, identity.targetSha);
    assert.deepEqual(applied, ["src/a.ts", "src/new.ts"]);
    assert.equal(readFileSync(join(root, "src/a.ts"), "utf8"), "export const a = 2;\n");
    assert.equal(readFileSync(join(root, "src/new.ts"), "utf8"), "export const n = 1;\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("base SHA 또는 live base content가 달라지면 fail-closed 한다", () => {
  const first = fixture();
  try {
    assert.throws(
      () => applyCandidateToExactBase(first.contract, first.contextPack, first.candidate, first.root, "e".repeat(40)),
      /base SHA mismatch/,
    );
  } finally {
    rmSync(first.root, { recursive: true, force: true });
  }

  const second = fixture();
  try {
    writeFileSync(join(second.root, "src/a.ts"), "changed outside candidate\n", "utf8");
    assert.throws(
      () => applyCandidateToExactBase(second.contract, second.contextPack, second.candidate, second.root, identity.targetSha),
      /base content changed since Context Pack/,
    );
  } finally {
    rmSync(second.root, { recursive: true, force: true });
  }
});

test("validation command는 shell 문법과 허용되지 않은 executable을 거부한다", () => {
  assert.deepEqual(parseValidationCommand("npm test -- smoke"), {
    raw: "npm test -- smoke",
    executable: "npm",
    args: ["test", "--", "smoke"],
  });
  assert.throws(() => parseValidationCommand("npm test; rm -rf ."), /forbidden shell syntax/);
  assert.throws(() => parseValidationCommand("bash test.sh"), /executable is not allowed/);
  assert.throws(() => parseValidationCommand("npm"), /must include a subcommand/);
});

test("validationCommands를 순서 보존된 argv plan으로 만든다", () => {
  const { root, contract } = fixture(["npm test", "npm run build"]);
  try {
    assert.deepEqual(createValidationPlan(contract), [
      { raw: "npm test", executable: "npm", args: ["test"] },
      { raw: "npm run build", executable: "npm", args: ["run", "build"] },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CI PASS를 구조화하고 provenance digest로 봉인한다", () => {
  const { root, contract, contextPack, candidate } = fixture();
  try {
    const calls: string[] = [];
    const result = runDeterministicValidation(contract, contextPack, candidate, root, identity.targetSha, {
      commandTimeoutMs: 1000,
      executor: (executable, args, cwd, timeoutMs) => {
        calls.push(`${executable} ${args.join(" ")} @ ${cwd} / ${timeoutMs}`);
        return { status: 0, signal: null, stdout: "ok\n", stderr: "" };
      },
    });

    assert.equal(result.status, "PASS");
    assert.equal(result.commands.length, 2);
    assert.deepEqual(result.appliedPaths, ["src/a.ts", "src/new.ts"]);
    assert.match(result.evidenceDigest, /^[0-9a-f]{64}$/);
    assert.equal(calls.length, 2);
    assert.doesNotThrow(() => verifyDeterministicValidationResult(result));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("첫 command 실패 시 fail-fast하고 뒤 command를 실행하지 않는다", () => {
  const { root, contract, contextPack, candidate } = fixture();
  try {
    let calls = 0;
    const result = runDeterministicValidation(contract, contextPack, candidate, root, identity.targetSha, {
      executor: () => {
        calls += 1;
        return { status: 1, signal: null, stdout: "", stderr: "test failed" };
      },
    });

    assert.equal(result.status, "FAIL");
    assert.equal(result.commands.length, 1);
    assert.equal(result.commands[0]?.stderr, "test failed");
    assert.equal(calls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
