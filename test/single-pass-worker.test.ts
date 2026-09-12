import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createImplementContextPack } from "../src/self-improvement/context-pack.js";
import { createImplementContract, type ApprovedPlanIdentity } from "../src/self-improvement/implement-contract.js";
import {
  createCandidateChangeSet,
  createSinglePassPrompt,
  verifyCandidateChangeSet,
  WORKER_OUTPUT_SCHEMA,
  type CandidateChangeSet,
} from "../src/self-improvement/single-pass-worker.js";

const identity: ApprovedPlanIdentity = {
  requirement: { issueNumber: 72, digest: "a".repeat(64) },
  repository: "erpsarang/self-improvement-mvp",
  targetSha: "b".repeat(40),
  plan: {
    runId: 3001,
    runAttempt: 1,
    artifact: { name: "plan-72", id: 101, digest: "c".repeat(64) },
    provenanceArtifact: { name: "plan-72-provenance", id: 102, digest: "d".repeat(64) },
  },
  approval: { commentId: 9001, approverUserId: 8370921 },
};

function makeContract(overrides: Partial<{ maxFilesChanged: number; maxPatchBytes: number }> = {}) {
  return createImplementContract(identity, {
    allowedPaths: ["src/a.ts", "src/new.ts"],
    requiredChanges: ["기존 파일을 수정하고 필요한 신규 파일만 생성한다"],
    forbiddenChanges: ["repository-wide 탐색 금지", "Auto Merge 금지"],
    validationCommands: ["npm test"],
    maxFilesChanged: overrides.maxFilesChanged ?? 2,
    maxContextBytes: 4096,
    maxPatchBytes: overrides.maxPatchBytes ?? 4096,
  });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "single-pass-worker-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n", "utf8");
  const contract = makeContract();
  const contextPack = createImplementContextPack(contract, root, identity.targetSha);
  const present = contextPack.files.find(({ path }) => path === "src/a.ts");
  if (!present || present.state !== "present") throw new Error("fixture present file missing");
  return { root, contract, contextPack, present };
}

test("Contract + Context Pack만으로 single-pass prompt와 bounded candidate를 만든다", () => {
  const { root, contract, contextPack, present } = fixture();
  try {
    const prompt = createSinglePassPrompt(contract, contextPack);
    assert.match(prompt, /한 번의 후보 변경안만/);
    assert.match(prompt, /repository, GitHub, 파일시스템, 네트워크를 탐색/);
    assert.match(prompt, new RegExp(contract.contractDigest));
    assert.match(prompt, new RegExp(contextPack.contextDigest));

    const candidate = createCandidateChangeSet(contract, contextPack, {
      summary: "허용된 두 파일만 변경",
      changes: [
        { path: "src/new.ts", operation: "create", baseContentDigest: null, content: "export const n = 2;\n" },
        { path: "src/a.ts", operation: "modify", baseContentDigest: present.contentDigest, content: "export const a = 2;\n" },
      ],
    });

    assert.deepEqual(candidate.changes.map(({ path }) => path), ["src/a.ts", "src/new.ts"]);
    assert.equal(candidate.contractDigest, contract.contractDigest);
    assert.equal(candidate.contextDigest, contextPack.contextDigest);
    assert.match(candidate.candidateDigest, /^[0-9a-f]{64}$/);
    assert.doesNotThrow(() => verifyCandidateChangeSet(candidate, contract, contextPack));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("allowedPaths 밖 변경과 duplicate path를 거부한다", () => {
  const { root, contract, contextPack, present } = fixture();
  try {
    assert.throws(() => createCandidateChangeSet(contract, contextPack, {
      summary: "범위 밖",
      changes: [{ path: "secret.txt", operation: "create", baseContentDigest: null, content: "x" }],
    }), /outside allowedPaths/);

    assert.throws(() => createCandidateChangeSet(contract, contextPack, {
      summary: "중복",
      changes: [
        { path: "src/a.ts", operation: "modify", baseContentDigest: present.contentDigest, content: "one" },
        { path: "src/a.ts", operation: "modify", baseContentDigest: present.contentDigest, content: "two" },
      ],
    }), /paths must be unique/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("present/missing 상태와 operation/base digest가 맞지 않으면 fail-closed 한다", () => {
  const { root, contract, contextPack, present } = fixture();
  try {
    assert.throws(() => createCandidateChangeSet(contract, contextPack, {
      summary: "digest 위조",
      changes: [{ path: "src/a.ts", operation: "modify", baseContentDigest: "e".repeat(64), content: "changed" }],
    }), /base content digest mismatch/);

    assert.throws(() => createCandidateChangeSet(contract, contextPack, {
      summary: "present를 create",
      changes: [{ path: "src/a.ts", operation: "create", baseContentDigest: null, content: "changed" }],
    }), /present path must use modify/);

    assert.throws(() => createCandidateChangeSet(contract, contextPack, {
      summary: "missing을 modify",
      changes: [{ path: "src/new.ts", operation: "modify", baseContentDigest: present.contentDigest, content: "changed" }],
    }), /missing path must use create/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("파일 수와 output byte budget을 Worker 밖 Trusted validator가 강제한다", () => {
  const root = mkdtempSync(join(tmpdir(), "single-pass-budget-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/a.ts"), "a\n", "utf8");

    const oneFileContract = makeContract({ maxFilesChanged: 1 });
    const context = createImplementContextPack(oneFileContract, root, identity.targetSha);
    const present = context.files.find(({ path }) => path === "src/a.ts");
    if (!present || present.state !== "present") throw new Error("present missing");
    assert.throws(() => createCandidateChangeSet(oneFileContract, context, {
      summary: "too many",
      changes: [
        { path: "src/a.ts", operation: "modify", baseContentDigest: present.contentDigest, content: "aa\n" },
        { path: "src/new.ts", operation: "create", baseContentDigest: null, content: "new\n" },
      ],
    }), /exceeds maxFilesChanged/);

    const tinyContract = makeContract({ maxPatchBytes: 3 });
    const tinyContext = createImplementContextPack(tinyContract, root, identity.targetSha);
    assert.throws(() => createCandidateChangeSet(tinyContract, tinyContext, {
      summary: "too large",
      changes: [{ path: "src/new.ts", operation: "create", baseContentDigest: null, content: "1234" }],
    }), /exceeds maxPatchBytes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate 위변조와 no-op을 거부하고 output schema에는 delete가 없다", () => {
  const { root, contract, contextPack, present } = fixture();
  try {
    assert.deepEqual(WORKER_OUTPUT_SCHEMA.properties.changes.items.properties.operation.enum, ["modify", "create"]);
    assert.throws(() => createCandidateChangeSet(contract, contextPack, {
      summary: "no-op",
      changes: [{ path: "src/a.ts", operation: "modify", baseContentDigest: present.contentDigest, content: present.content }],
    }), /no-op/);

    const candidate = createCandidateChangeSet(contract, contextPack, {
      summary: "정상 후보",
      changes: [{ path: "src/a.ts", operation: "modify", baseContentDigest: present.contentDigest, content: "export const a = 3;\n" }],
    });
    const forged = { ...candidate, summary: "위변조" } as CandidateChangeSet;
    assert.throws(() => verifyCandidateChangeSet(forged, contract, contextPack), /digest or canonical shape mismatch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
