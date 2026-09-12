import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BOUNDED_FIX_OUTPUT_SCHEMA,
  boundedFixArtifactName,
  createBoundedFixPrompt,
  createBoundedFixRequest,
  createFixedCandidateChangeSet,
  verifyBoundedFixRequest,
  type BoundedFixRequest,
} from "../src/self-improvement/bounded-fix.js";
import { createImplementContextPack } from "../src/self-improvement/context-pack.js";
import { runDeterministicValidation } from "../src/self-improvement/deterministic-ci.js";
import { createImplementContract, type ApprovedPlanIdentity } from "../src/self-improvement/implement-contract.js";
import { createCandidateChangeSet } from "../src/self-improvement/single-pass-worker.js";

const identity: ApprovedPlanIdentity = {
  requirement: { issueNumber: 78, digest: "a".repeat(64) },
  repository: "erpsarang/self-improvement-mvp",
  targetSha: "b".repeat(40),
  plan: {
    runId: 7801,
    runAttempt: 1,
    artifact: { name: "plan-78", id: 201, digest: "c".repeat(64) },
    provenanceArtifact: { name: "plan-78-provenance", id: 202, digest: "d".repeat(64) },
  },
  approval: { commentId: 78001, approverUserId: 8370921 },
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bounded-fix-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/a.ts"), "export const value = 1;\n", "utf8");

  const contract = createImplementContract(identity, {
    allowedPaths: ["src/a.ts"],
    requiredChanges: ["value를 올바른 값으로 변경"],
    forbiddenChanges: ["다른 파일 변경 금지"],
    validationCommands: ["npm test"],
    maxFilesChanged: 1,
    maxContextBytes: 4096,
    maxPatchBytes: 4096,
  });
  const contextPack = createImplementContextPack(contract, root, identity.targetSha);
  const present = contextPack.files[0];
  if (!present || present.state !== "present") throw new Error("fixture file missing");

  const candidate = createCandidateChangeSet(contract, contextPack, {
    summary: "실패하도록 잘못된 값 사용",
    changes: [{
      path: "src/a.ts",
      operation: "modify",
      baseContentDigest: present.contentDigest,
      content: "export const value = broken;\n",
    }],
  });

  return { root, contract, contextPack, candidate, present };
}

test("deterministic CI PASS에서는 FIX 요청을 만들지 않는다", () => {
  const { root, contract, contextPack, candidate } = fixture();
  try {
    const validation = runDeterministicValidation(contract, contextPack, candidate, root, identity.targetSha, {
      executor: () => ({ status: 0, signal: null, stdout: "ok", stderr: "" }),
    });
    assert.equal(validation.status, "PASS");
    assert.throws(() => createBoundedFixRequest(contract, contextPack, candidate, validation), /requires failed deterministic validation/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FAIL에서는 exact identity와 최소 실패 증빙으로 FIX request를 고정한다", () => {
  const { root, contract, contextPack, candidate } = fixture();
  try {
    const validation = runDeterministicValidation(contract, contextPack, candidate, root, identity.targetSha, {
      executor: () => ({ status: 1, signal: null, stdout: "test failed", stderr: "x".repeat(20_000) }),
    });
    const request = createBoundedFixRequest(contract, contextPack, candidate, validation);

    assert.equal(request.fixAttempt, 1);
    assert.equal(request.maxFixAttempts, 1);
    assert.equal(request.contractDigest, contract.contractDigest);
    assert.equal(request.contextDigest, contextPack.contextDigest);
    assert.equal(request.candidateDigest, candidate.candidateDigest);
    assert.equal(request.validationEvidenceDigest, validation.evidenceDigest);
    assert.equal(request.failure.raw, "npm test");
    assert.match(request.failure.stderr, /\[truncated\]$/);
    assert.ok(Buffer.byteLength(request.failure.stderr, "utf8") < 9 * 1024);
    assert.match(request.fixRequestDigest, /^[0-9a-f]{64}$/);
    assert.match(boundedFixArtifactName(contract, candidate), /bounded-fix-issue-78/);
    assert.doesNotThrow(() => verifyBoundedFixRequest(request, contract, contextPack, candidate, validation));

    const prompt = createBoundedFixPrompt(request, contract, contextPack, candidate, validation);
    assert.match(prompt, /한 번 수정/);
    assert.match(prompt, /repository, GitHub, 파일시스템, 네트워크를 탐색/);
    assert.match(prompt, /스스로 테스트하거나 반복 수정/);
    assert.match(prompt, new RegExp(request.fixRequestDigest));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FIX request 위변조를 fail-closed 한다", () => {
  const { root, contract, contextPack, candidate } = fixture();
  try {
    const validation = runDeterministicValidation(contract, contextPack, candidate, root, identity.targetSha, {
      executor: () => ({ status: 2, signal: null, stdout: "", stderr: "compile error" }),
    });
    const request = createBoundedFixRequest(contract, contextPack, candidate, validation);
    const forged = {
      ...request,
      failure: { ...request.failure, stderr: "forged" },
    } as BoundedFixRequest;
    assert.throws(() => verifyBoundedFixRequest(forged, contract, contextPack, candidate, validation), /digest or canonical shape mismatch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bounded FIX 결과도 기존 candidate 경계를 재사용하고 content-identical FIX는 거부한다", () => {
  const { root, contract, contextPack, candidate, present } = fixture();
  try {
    const validation = runDeterministicValidation(contract, contextPack, candidate, root, identity.targetSha, {
      executor: () => ({ status: 1, signal: null, stdout: "", stderr: "failed" }),
    });
    const request = createBoundedFixRequest(contract, contextPack, candidate, validation);

    const fixed = createFixedCandidateChangeSet(request, contract, contextPack, candidate, validation, {
      summary: "실패 원인을 수정",
      changes: [{
        path: "src/a.ts",
        operation: "modify",
        baseContentDigest: present.contentDigest,
        content: "export const value = 2;\n",
      }],
    });
    assert.notEqual(fixed.candidateDigest, candidate.candidateDigest);
    assert.equal(fixed.changes[0]?.path, "src/a.ts");

    assert.throws(() => createFixedCandidateChangeSet(request, contract, contextPack, candidate, validation, {
      summary: "말만 바꾸고 내용은 동일",
      changes: candidate.changes,
    }), /unchanged candidate content/);

    assert.throws(() => createFixedCandidateChangeSet(request, contract, contextPack, candidate, validation, {
      summary: "범위 밖 파일 시도",
      changes: [{ path: "outside.ts", operation: "create", baseContentDigest: null, content: "x" }],
    }), /outside allowedPaths/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bounded FIX output schema는 기존 single-pass candidate schema와 동일하다", () => {
  assert.deepEqual(BOUNDED_FIX_OUTPUT_SCHEMA.properties.changes.items.properties.operation.enum, ["modify", "create"]);
});
