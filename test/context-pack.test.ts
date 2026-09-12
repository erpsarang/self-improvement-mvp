import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  contextPackArtifactName,
  createImplementContextPack,
  verifyImplementContextPack,
  type ImplementContextPack,
} from "../src/self-improvement/context-pack.js";
import { createImplementContract, type ApprovedPlanIdentity } from "../src/self-improvement/implement-contract.js";

const identity: ApprovedPlanIdentity = {
  requirement: { issueNumber: 62, digest: "a".repeat(64) },
  repository: "erpsarang/self-improvement-mvp",
  targetSha: "b".repeat(40),
  plan: {
    runId: 1234,
    runAttempt: 1,
    artifact: { name: "plan-62", id: 7, digest: "c".repeat(64) },
    provenanceArtifact: { name: "plan-62-provenance", id: 8, digest: "d".repeat(64) },
  },
  approval: { commentId: 9001, approverUserId: 8370921 },
};

function contract(overrides: Partial<{ allowedPaths: readonly string[]; maxContextBytes: number }> = {}) {
  return createImplementContract(identity, {
    allowedPaths: overrides.allowedPaths ?? ["src/a.ts", "src/new.ts"],
    requiredChanges: ["bounded patch를 만든다"],
    forbiddenChanges: ["Auto Merge 금지"],
    validationCommands: ["npm test"],
    maxFilesChanged: (overrides.allowedPaths ?? ["src/a.ts", "src/new.ts"]).length,
    maxContextBytes: overrides.maxContextBytes ?? 1024,
    maxPatchBytes: 4096,
  });
}

function tempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "context-pack-"));
  mkdirSync(join(root, "src"));
  return root;
}

test("allowedPaths의 exact UTF-8 문맥만 deterministic Context Pack으로 고정한다", () => {
  const root = tempRepo();
  try {
    writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n", "utf8");
    writeFileSync(join(root, "unrelated.txt"), "절대 포함되면 안 됨", "utf8");
    const c = contract();

    const first = createImplementContextPack(c, root, identity.targetSha);
    const second = createImplementContextPack(c, root, identity.targetSha);

    assert.deepEqual(first, second);
    assert.deepEqual(first.files.map(({ path }) => path), ["src/a.ts", "src/new.ts"]);
    assert.equal(first.files[0]?.state, "present");
    assert.equal(first.files[1]?.state, "missing");
    assert.equal(first.totalContextBytes, Buffer.byteLength("export const a = 1;\n", "utf8"));
    assert.doesNotThrow(() => verifyImplementContextPack(first, c));
    assert.match(contextPackArtifactName(c), new RegExp(`^implement-context-issue-62-contract-${c.contractDigest}$`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("observed checkout SHA가 Contract baseSha와 다르면 fail-closed 한다", () => {
  const root = tempRepo();
  try {
    const c = contract();
    assert.throws(() => createImplementContextPack(c, root, "e".repeat(40)), /base SHA mismatch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Context Pack byte budget을 넘는 입력은 AI에 전달되기 전에 차단한다", () => {
  const root = tempRepo();
  try {
    writeFileSync(join(root, "src/a.ts"), "1234567890", "utf8");
    const c = contract({ allowedPaths: ["src/a.ts"], maxContextBytes: 5 });
    assert.throws(() => createImplementContextPack(c, root, identity.targetSha), /exceeds maxContextBytes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("symlink와 non-UTF-8 binary context를 거부한다", () => {
  const root = tempRepo();
  try {
    writeFileSync(join(root, "outside.ts"), "secret\n", "utf8");
    symlinkSync(join(root, "outside.ts"), join(root, "src/link.ts"));
    const symlinkContract = contract({ allowedPaths: ["src/link.ts"] });
    assert.throws(() => createImplementContextPack(symlinkContract, root, identity.targetSha), /symlink/);

    writeFileSync(join(root, "src/binary.bin"), Buffer.from([0xff, 0xfe, 0xfd]));
    const binaryContract = contract({ allowedPaths: ["src/binary.bin"] });
    assert.throws(() => createImplementContextPack(binaryContract, root, identity.targetSha), /UTF-8/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Context Pack content/identity 위변조와 allowedPaths 밖 파일을 거부한다", () => {
  const root = tempRepo();
  try {
    writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n", "utf8");
    const c = contract();
    const pack = createImplementContextPack(c, root, identity.targetSha);

    const forgedContent = JSON.parse(JSON.stringify(pack)) as { files: Array<Record<string, unknown>> };
    forgedContent.files[0]!["content"] = "forged";
    assert.throws(() => verifyImplementContextPack(forgedContent as unknown as ImplementContextPack, c), /file digest mismatch/);

    const forgedPath = JSON.parse(JSON.stringify(pack)) as { files: Array<Record<string, unknown>> };
    forgedPath.files[0]!["path"] = "secret.txt";
    assert.throws(() => verifyImplementContextPack(forgedPath as unknown as ImplementContextPack, c), /exactly match allowedPaths/);

    const other = contract({ maxContextBytes: 2048 });
    assert.throws(() => verifyImplementContextPack(pack, other), /contract identity mismatch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
