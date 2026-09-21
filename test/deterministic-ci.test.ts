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
      { raw: "npm ci --ignore-scripts", executable: "npm", args: ["ci", "--ignore-scripts"] },
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
    assert.equal(result.commands.length, 3);
    assert.deepEqual(result.appliedPaths, ["src/a.ts", "src/new.ts"]);
    assert.match(result.evidenceDigest, /^[0-9a-f]{64}$/);
    assert.equal(calls.length, 3);
    assert.doesNotThrow(() => verifyDeterministicValidationResult(result));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate 적용 뒤 dependency preflight를 가장 먼저 실행한다", () => {
  const root = mkdtempSync(join(tmpdir(), "deterministic-ci-package-"));
  try {
    writeFileSync(join(root, "package.json"), "{\n  \"name\": \"demo\",\n  \"version\": \"1.0.0\"\n}\n", "utf8");
    const contract = createImplementContract(identity, {
      allowedPaths: ["package.json"],
      requiredChanges: ["dependency 변경"],
      forbiddenChanges: [],
      validationCommands: ["npm test"],
      maxFilesChanged: 1,
      maxContextBytes: 4096,
      maxPatchBytes: 4096,
    });
    const contextPack = createImplementContextPack(contract, root, identity.targetSha);
    const present = contextPack.files.find(({ path }) => path === "package.json");
    if (!present || present.state !== "present") throw new Error("package.json context missing");
    const candidate = createCandidateChangeSet(contract, contextPack, {
      summary: "Vite dependency 추가",
      changes: [{
        path: "package.json",
        operation: "modify",
        baseContentDigest: present.contentDigest,
        content: "{\n  \"name\": \"demo\",\n  \"version\": \"1.0.0\",\n  \"devDependencies\": { \"vite\": \"^6.0.0\" }\n}\n",
      }],
    });

    let calls = 0;
    const result = runDeterministicValidation(contract, contextPack, candidate, root, identity.targetSha, {
      executor: (executable, args, cwd) => {
        calls += 1;
        assert.equal(readFileSync(join(cwd, "package.json"), "utf8").includes("\"vite\""), true);
        assert.equal(executable, "npm");
        assert.deepEqual(args, ["ci", "--ignore-scripts"]);
        return { status: 1, signal: null, stdout: "", stderr: "lock mismatch" };
      },
    });

    assert.equal(result.status, "FAIL");
    assert.equal(result.commands.length, 1);
    assert.equal(result.commands[0]?.raw, "npm ci --ignore-scripts");
    assert.equal(calls, 1);
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


const BOOTSTRAP_LOG_LIMIT = 32 * 1024;
const BOOTSTRAP_LOG_MARKER = "\n...[truncated middle]...\n";
const BOOTSTRAP_AVAILABLE_BYTES = BOOTSTRAP_LOG_LIMIT - Buffer.byteLength(BOOTSTRAP_LOG_MARKER, "utf8");
const BOOTSTRAP_HEAD_BYTES = Math.floor(BOOTSTRAP_AVAILABLE_BYTES / 4);
const BOOTSTRAP_TAIL_BYTES = BOOTSTRAP_AVAILABLE_BYTES - BOOTSTRAP_HEAD_BYTES;

function validateBoundedLogs(stdout: string, stderr: string) {
  const { root, contract, contextPack, candidate } = fixture(["npm test"]);
  try {
    return runDeterministicValidation(contract, contextPack, candidate, root, identity.targetSha, {
      executor: () => ({ status: 1, signal: null, stdout, stderr }),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("긴 deterministic CI 로그는 32KiB 안에서 head와 failure tail을 함께 보존한다", () => {
  const short = "short log\n";
  const shortResult = validateBoundedLogs(short, short);
  assert.equal(shortResult.commands[0]?.stdout, short);
  assert.equal(shortResult.commands[0]?.stderr, short);

  const head = "START OF CI\n";
  const tail = "\nnot ok 150 - regression\nAssertionError: expected true\n# tests 150\n# pass 149\n# fail 1\n";
  const long = head + "m".repeat(40 * 1024) + tail;
  const result = validateBoundedLogs(long, long);

  for (const stream of [result.commands[0]?.stdout, result.commands[0]?.stderr]) {
    assert.ok(stream);
    assert.ok(stream.startsWith(head));
    assert.ok(stream.includes(BOOTSTRAP_LOG_MARKER));
    assert.ok(stream.endsWith(tail));
    assert.equal(Buffer.byteLength(stream, "utf8"), BOOTSTRAP_LOG_LIMIT);
  }
});

test("UTF-8 clipping 경계에서 multi-byte 문자를 깨뜨리지 않는다", () => {
  for (const character of ["é", "한", "🙂"]) {
    const width = Buffer.byteLength(character, "utf8");
    for (let offset = 0; offset < width; offset += 1) {
      const head = "H".repeat(BOOTSTRAP_HEAD_BYTES - offset);
      const tail = "T".repeat(BOOTSTRAP_TAIL_BYTES - (width - offset));
      const input = head + character + "m".repeat(40 * 1024) + character + tail;
      const expected = head + BOOTSTRAP_LOG_MARKER + (offset === 0 ? character : "") + tail;
      const result = validateBoundedLogs(input, input);

      for (const stream of [result.commands[0]?.stdout, result.commands[0]?.stderr]) {
        assert.equal(stream, expected);
        assert.equal(stream?.includes("\ufffd"), false);
        assert.ok(Buffer.byteLength(stream ?? "", "utf8") <= BOOTSTRAP_LOG_LIMIT);
      }
    }
  }
});

test("bounded log representation과 evidence digest는 deterministic하게 결합된다", () => {
  const { root, contract, contextPack, candidate } = fixture(["npm test"]);
  const input = "HEAD\n" + "m".repeat(40 * 1024) + "\nnot ok 150\nAssertionError\n# fail 1\n";

  const run = (stdout: string, stderr: string) => {
    writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n", "utf8");
    rmSync(join(root, "src/new.ts"), { force: true });
    return runDeterministicValidation(contract, contextPack, candidate, root, identity.targetSha, {
      executor: () => ({ status: 1, signal: null, stdout, stderr }),
    });
  };

  try {
    const first = run(input, input);
    const second = run(input, input);
    assert.deepEqual(second, first);
    assert.equal(second.evidenceDigest, first.evidenceDigest);

    const omittedIndex = BOOTSTRAP_HEAD_BYTES + 1000;
    const middleChanged = input.slice(0, omittedIndex) + "x" + input.slice(omittedIndex + 1);
    assert.equal(run(middleChanged, middleChanged).evidenceDigest, first.evidenceDigest);

    assert.notEqual(run(input + "tail change", input).evidenceDigest, first.evidenceDigest);
    assert.notEqual(run(input, input + "tail change").evidenceDigest, first.evidenceDigest);

    const tampered = {
      ...first,
      commands: first.commands.map((command) => ({ ...command, stdout: command.stdout + "tampered" })),
    };
    assert.throws(() => verifyDeterministicValidationResult(tampered), /evidence digest mismatch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
