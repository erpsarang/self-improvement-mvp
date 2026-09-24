import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

function contract(overrides: Partial<{ allowedPaths: readonly string[]; contextPaths: readonly string[]; maxContextBytes: number }> = {}) {
  return createImplementContract(identity, {
    allowedPaths: overrides.allowedPaths ?? ["src/a.ts", "src/new.ts"],
    contextPaths: overrides.contextPaths ?? [],
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

test("allowedPaths와 read-only contextPaths의 exact UTF-8 문맥을 deterministic Context Pack으로 고정한다", () => {
  const root = tempRepo();
  try {
    writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n", "utf8");
    writeFileSync(join(root, "src/reference.ts"), "export const ref = 2;\n", "utf8");
    writeFileSync(join(root, "unrelated.txt"), "절대 포함되면 안 됨", "utf8");
    const c = contract({ contextPaths: ["src/reference.ts"] });

    const first = createImplementContextPack(c, root, identity.targetSha);
    const second = createImplementContextPack(c, root, identity.targetSha);

    assert.deepEqual(first, second);
    assert.deepEqual(first.files.map(({ path }) => path), ["src/a.ts", "src/new.ts", "src/reference.ts"]);
    assert.equal(first.files.find(({ path }) => path === "src/a.ts")?.state, "present");
    assert.equal(first.files.find(({ path }) => path === "src/new.ts")?.state, "missing");
    assert.equal(first.files.find(({ path }) => path === "src/reference.ts")?.state, "present");
    assert.equal(first.totalContextBytes, Buffer.byteLength("export const a = 1;\nexport const ref = 2;\n", "utf8"));
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

test("missing/symlink/non-UTF-8 read-only context를 거부한다", () => {
  const root = tempRepo();
  try {
    const missingContext = contract({ allowedPaths: ["src/new.ts"], contextPaths: ["src/missing-reference.ts"] });
    assert.throws(() => createImplementContextPack(missingContext, root, identity.targetSha), /contextPath must exist/);

    writeFileSync(join(root, "outside.ts"), "secret\n", "utf8");
    symlinkSync(join(root, "outside.ts"), join(root, "src/link.ts"));
    const symlinkContract = contract({ allowedPaths: ["src/new.ts"], contextPaths: ["src/link.ts"] });
    assert.throws(() => createImplementContextPack(symlinkContract, root, identity.targetSha), /symlink/);

    writeFileSync(join(root, "src/binary.bin"), Buffer.from([0xff, 0xfe, 0xfd]));
    const binaryContract = contract({ allowedPaths: ["src/new.ts"], contextPaths: ["src/binary.bin"] });
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
    assert.throws(() => verifyImplementContextPack(forgedPath as unknown as ImplementContextPack, c), /exactly match allowedPaths plus contextPaths/);

    const other = contract({ maxContextBytes: 2048 });
    assert.throws(() => verifyImplementContextPack(pack, other), /contract identity mismatch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 승인된 PLAN evidence 발췌 (self-improvement-mvp #244 Handoff run 35976744079) ----

function excerptEvidence(path: string, fullText: string, startOffset: number, length: number) {
  const content = fullText.slice(startOffset, startOffset + length);
  return {
    path,
    startOffset,
    content,
    contentDigest: createHash("sha256").update(content, "utf8").digest("hex"),
  };
}

test("contextPaths 전체 파일이 예산 안이면 evidence가 있어도 Context Pack은 바이트 단위로 기존과 같다", () => {
  const root = tempRepo();
  try {
    writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n", "utf8");
    const reference = "// 한글 주석: 문자 인덱스와 byte 오프셋이 달라진다\nexport const ref = 2;\n";
    writeFileSync(join(root, "src/reference.ts"), reference, "utf8");
    const c = contract({ contextPaths: ["src/reference.ts"], maxContextBytes: 4096 });
    const evidence = [excerptEvidence("src/reference.ts", reference, reference.indexOf("export"), 20)];

    const plain = createImplementContextPack(c, root, identity.targetSha);
    const withEvidence = createImplementContextPack(c, root, identity.targetSha, { approvedPlanEvidence: evidence });
    assert.deepEqual(withEvidence, plain);
    assert.ok(withEvidence.files.every((file) => file.state !== "excerpt"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("예산을 넘으면 read-only contextPath만 승인된 PLAN evidence 발췌로 바뀌고 allowedPaths는 전체 파일로 남는다", () => {
  const root = tempRepo();
  try {
    const big = `// 참고 파일 앞부분 (한글 포함)\n${"x".repeat(3000)}\n      - uses: openai/codex-action@v1\n        with:\n          effort: medium\n${"y".repeat(3000)}\n`;
    writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n", "utf8");
    writeFileSync(join(root, "src/big-reference.ts"), big, "utf8");
    const c = contract({ contextPaths: ["src/big-reference.ts"], maxContextBytes: 2048 });
    const start = big.indexOf("      - uses");
    const evidence = [excerptEvidence("src/big-reference.ts", big, start, big.indexOf("effort: medium") + "effort: medium".length - start)];

    // evidence 없이는 예산 초과로 fail-closed, 임의로 파일을 버리지 않는다.
    assert.throws(() => createImplementContextPack(c, root, identity.targetSha), /exceeds maxContextBytes; read-only contextPaths without approved PLAN evidence: src\/big-reference\.ts/);

    const pack = createImplementContextPack(c, root, identity.targetSha, { approvedPlanEvidence: evidence });
    assert.doesNotThrow(() => verifyImplementContextPack(pack, c));
    const a = pack.files.find((file) => file.path === "src/a.ts");
    const ref = pack.files.find((file) => file.path === "src/big-reference.ts");
    assert.equal(a?.state, "present");
    assert.equal(ref?.state, "excerpt");
    if (ref?.state !== "excerpt") throw new Error("unreachable");
    // Worker는 Planner가 본 발췌를 그대로 보고, 전체 파일 digest로 exact SHA에 묶인다.
    assert.equal(ref.content, evidence[0]!.content);
    assert.equal(ref.startOffset, start);
    assert.equal(ref.contentDigest, evidence[0]!.contentDigest);
    assert.equal(ref.sourceByteLength, Buffer.byteLength(big, "utf8"));
    assert.equal(ref.sourceContentDigest, createHash("sha256").update(big, "utf8").digest("hex"));
    assert.equal(big.slice(ref.startOffset, ref.startOffset + ref.content.length), ref.content);
    assert.ok(pack.totalContextBytes <= 2048);

    // 같은 입력이면 같은 pack (deterministic).
    assert.deepEqual(createImplementContextPack(c, root, identity.targetSha, { approvedPlanEvidence: evidence }), pack);

    // allowedPath는 evidence가 있어도 발췌가 되지 않는다: 쓰기 권한은 전체 파일이 필요하다.
    const writable = contract({ allowedPaths: ["src/big-reference.ts"], contextPaths: [], maxContextBytes: 2048 });
    assert.throws(() => createImplementContextPack(writable, root, identity.targetSha, { approvedPlanEvidence: evidence }), /exceeds maxContextBytes even with approved PLAN evidence excerpts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("frozen 파일과 맞지 않거나 위조된 PLAN evidence는 발췌로 쓰지 않고 fail-closed 한다", () => {
  const root = tempRepo();
  try {
    const big = `${"x".repeat(3000)}\nexport const ref = 2;\n`;
    writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n", "utf8");
    writeFileSync(join(root, "src/big-reference.ts"), big, "utf8");
    const c = contract({ contextPaths: ["src/big-reference.ts"], maxContextBytes: 1024 });
    const good = excerptEvidence("src/big-reference.ts", big, 3001, 21);

    // 승인 이후 파일이 바뀐 경우와 같은 slice 불일치.
    assert.throws(
      () => createImplementContextPack(c, root, identity.targetSha, { approvedPlanEvidence: [{ ...good, startOffset: 3000 }] }),
      /approved PLAN evidence does not match frozen base file/,
    );
    // content와 digest가 어긋난 evidence.
    assert.throws(
      () => createImplementContextPack(c, root, identity.targetSha, { approvedPlanEvidence: [{ ...good, contentDigest: "0".repeat(64) }] }),
      /approved PLAN evidence is invalid/,
    );
    // 같은 path가 두 번.
    assert.throws(
      () => createImplementContextPack(c, root, identity.targetSha, { approvedPlanEvidence: [good, good] }),
      /must be unique/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verifier는 발췌를 read-only contextPath에서만 받고 allowedPath 발췌·identity 위변조를 거부한다", () => {
  const root = tempRepo();
  try {
    const big = `${"x".repeat(3000)}\nexport const ref = 2;\n`;
    writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n", "utf8");
    writeFileSync(join(root, "src/big-reference.ts"), big, "utf8");
    const c = contract({ contextPaths: ["src/big-reference.ts"], maxContextBytes: 1024 });
    const pack = createImplementContextPack(c, root, identity.targetSha, { approvedPlanEvidence: [excerptEvidence("src/big-reference.ts", big, 3001, 21)] });
    const clone = () => JSON.parse(JSON.stringify(pack)) as ImplementContextPack;
    const rebuild = (mutate: (files: Array<Record<string, unknown>>) => void) => {
      const forged = clone() as unknown as { files: Array<Record<string, unknown>>; totalContextBytes: number; contextDigest: string; digestAlgorithm: "sha256"; schemaVersion: 1; kind: string; contractDigest: string; repository: string; baseSha: string };
      mutate(forged.files);
      const { digestAlgorithm: _a, contextDigest: _d, ...payload } = forged;
      forged.contextDigest = createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
      return forged as unknown as ImplementContextPack;
    };

    // allowedPath(src/a.ts)를 excerpt로 바꾼 pack: 쓰기 권한 파일의 발췌는 금지.
    const excerptOnAllowed = rebuild((files) => {
      const a = files.find((file) => file.path === "src/a.ts")!;
      a.state = "excerpt"; a.startOffset = 0; a.sourceByteLength = a.byteLength; a.sourceContentDigest = a.contentDigest;
    });
    assert.throws(() => verifyImplementContextPack(excerptOnAllowed, c), /only allowed for read-only contextPaths/);

    // 전체 파일보다 큰 sourceByteLength 같은 identity 위조.
    const badIdentity = rebuild((files) => {
      const ref = files.find((file) => file.path === "src/big-reference.ts")!;
      ref.sourceByteLength = 1;
    });
    assert.throws(() => verifyImplementContextPack(badIdentity, c), /excerpt identity is invalid/);

    // 발췌 내용 위조는 digest에서 걸린다.
    const forgedContent = clone() as unknown as { files: Array<Record<string, unknown>> };
    forgedContent.files.find((file) => file.path === "src/big-reference.ts")!["content"] = "forged";
    assert.throws(() => verifyImplementContextPack(forgedContent as unknown as ImplementContextPack, c), /file digest mismatch/);

    // 알 수 없는 state.
    const unknownState = rebuild((files) => { files[0]!.state = "partial"; });
    assert.throws(() => verifyImplementContextPack(unknownState, c), /unsupported Context Pack file state|digest/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
