import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createImplementContextPack } from "../src/self-improvement/context-pack.js";
import { createImplementContract, requirementSnapshotDigest, type ApprovedPlanIdentity } from "../src/self-improvement/implement-contract.js";
import { acceptPlanWorkerOutput, createWorkerEditRepairPrompt, type PlanImplementWorkerBundle } from "../src/self-improvement/plan-implement-worker.js";
import { PLAN_IMPLEMENT_MAX_CONTEXT_BYTES, validatePlan, type PlanContextPack } from "../src/self-improvement/planner.js";
import {
  createSinglePassPrompt,
  IMPLEMENT_PROMPT_INLINE_MAX_BYTES,
  IMPLEMENT_READ_TOOLS_MARKER,
  promptContextPack,
  repairWorkspaceRule,
} from "../src/self-improvement/single-pass-worker.js";

// Framework #368 3단계: trusted Context Pack은 원문 전체를 384KB까지 보관하고,
// Worker prompt에는 96KB까지만 원문을 싣는다. 넘치는 큰 파일은 /work 참조가 되고 prompt 첫 줄에 표시가 붙는다.
// 관측: App #307 PLAN run 37259255800 (119,258B > 96,000B), App #289 (106,198B).

const requirementSnapshot = { title: "기준 CSV의 추가 열을 무시한다", body: "필수 열 외의 열은 판정에 쓰지 않는다." } as const;
const identity: ApprovedPlanIdentity = {
  requirement: { issueNumber: 307, digest: requirementSnapshotDigest(requirementSnapshot) },
  repository: "erpsarang/sales-order-exception-analyzer",
  targetSha: "b".repeat(40),
  plan: {
    runId: 37259767765,
    runAttempt: 1,
    artifact: { name: "plan-307", id: 101, digest: "c".repeat(64) },
    provenanceArtifact: { name: "plan-307-provenance", id: 102, digest: "d".repeat(64) },
  },
  approval: { commentId: 5987637097, approverUserId: 8370921 },
};

function line(head: string, bytes: number): string {
  return `${head}\n//${"x".repeat(bytes - head.length - 4)}\n`;
}

function fixture(sizes: { web: number; csv: number; reference: number }) {
  const root = mkdtempSync(join(tmpdir(), "implement-read-tools-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/web-main.ts"), line("export const web = 1;", sizes.web));
  writeFileSync(join(root, "src/csv.ts"), line("export const csv = 1;", sizes.csv));
  writeFileSync(join(root, "src/reference.ts"), line("export const reference = 1;", sizes.reference));
  const contract = createImplementContract(identity, {
    allowedPaths: ["src/csv.ts", "src/web-main.ts"],
    contextPaths: ["src/reference.ts"],
    requiredChanges: ["추가 열을 무시한다"],
    forbiddenChanges: ["주문 CSV 규칙을 바꾸지 않는다"],
    validationCommands: ["npm test"],
    maxFilesChanged: 2,
    maxContextBytes: PLAN_IMPLEMENT_MAX_CONTEXT_BYTES,
    maxPatchBytes: 64_000,
  }, requirementSnapshot);
  const pack = createImplementContextPack(contract, root, identity.targetSha);
  return { root, contract, pack };
}

test("상한: 원문 보관은 384KB, prompt에 싣는 원문은 96KB다", () => {
  assert.equal(PLAN_IMPLEMENT_MAX_CONTEXT_BYTES, 384_000);
  assert.equal(IMPLEMENT_PROMPT_INLINE_MAX_BYTES, 96_000);
  assert.equal(IMPLEMENT_READ_TOOLS_MARKER, "<!-- ai-dev-framework:IMPLEMENT_READ_TOOLS required -->");
});

test("원문이 96KB 안이면 prompt는 지금과 같다 (표시 없음, 탐색 금지 규칙 유지, Context Pack 그대로)", () => {
  const { root, contract, pack } = fixture({ web: 30_000, csv: 20_000, reference: 10_000 });
  try {
    assert.deepEqual(promptContextPack(pack), { view: pack, referenced: [] });
    const prompt = createSinglePassPrompt(contract, pack, { requireCompletion: true });
    assert.ok(prompt.startsWith("당신은 bounded IMPLEMENT Worker입니다."));
    assert.ok(!prompt.includes(IMPLEMENT_READ_TOOLS_MARKER));
    assert.match(prompt, /- repository, GitHub, 파일시스템, 네트워크를 탐색하거나 추가 파일을 요청하지 마세요\./);
    assert.ok(prompt.includes(`CONTEXT PACK:\n${JSON.stringify(pack)}\n`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("원문이 96KB를 넘으면 큰 present 파일부터 /work 참조로 바꾸고 첫 줄에 표시를 붙인다 (App #307 모양)", () => {
  const { root, contract, pack } = fixture({ web: 70_000, csv: 40_000, reference: 10_000 });
  try {
    assert.ok(pack.totalContextBytes > IMPLEMENT_PROMPT_INLINE_MAX_BYTES, "trusted pack은 원문 120KB를 그대로 보관한다");
    const { view, referenced } = promptContextPack(pack);
    assert.deepEqual(referenced, ["src/web-main.ts"], "가장 큰 파일 하나만 빼면 50KB로 맞는다");
    const web = (view as { files: Array<Record<string, unknown>> }).files.find((file) => file.path === "src/web-main.ts")!;
    const original = pack.files.find((file) => file.path === "src/web-main.ts")!;
    assert.equal(original.state, "present");
    assert.deepEqual(web, {
      path: "src/web-main.ts",
      state: "present",
      byteLength: original.byteLength,
      digestAlgorithm: "sha256",
      contentDigest: (original as { contentDigest: string }).contentDigest,
      content: null,
      readWith: "/work/src/web-main.ts",
    });
    const csv = (view as { files: Array<Record<string, unknown>> }).files.find((file) => file.path === "src/csv.ts")!;
    assert.equal(typeof csv.content, "string", "작은 파일은 원문 그대로 싣는다");

    const prompt = createSinglePassPrompt(contract, pack, { requireCompletion: true });
    assert.equal(prompt.split("\n", 1)[0], IMPLEMENT_READ_TOOLS_MARKER);
    assert.ok(!prompt.includes("탐색하거나 추가 파일을 요청하지 마세요"));
    assert.match(prompt, /\/work/);
    assert.match(prompt, /Read/);
    assert.match(prompt, /content가 null인 present 파일/);
    assert.ok(!prompt.includes(readFileSync(join(root, "src/web-main.ts"), "utf8")), "참조로 바꾼 파일 원문은 prompt에 없다");
    assert.ok(Buffer.byteLength(prompt, "utf8") < IMPLEMENT_PROMPT_INLINE_MAX_BYTES + 20_000);
    assert.equal(createSinglePassPrompt(contract, pack, { requireCompletion: true }), prompt, "같은 입력이면 같은 prompt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("참조로 바꾼 파일의 edit도 trusted pack 원문에 대조해 검증한다", () => {
  const { root, pack } = fixture({ web: 70_000, csv: 40_000, reference: 10_000 });
  try {
    const web = pack.files.find((file) => file.path === "src/web-main.ts") as { contentDigest: string };
    const proposal = acceptPlanWorkerOutput({
      summary: "참조 파일 수정",
      complete: true,
      changes: [{ path: "src/web-main.ts", operation: "modify", baseContentDigest: web.contentDigest, content: null, edits: [{ oldText: "export const web = 1;", newText: "export const web = 2;" }] }],
    }, pack);
    assert.ok(proposal.changes[0]!.content!.startsWith("export const web = 2;\n"));
    assert.throws(() => acceptPlanWorkerOutput({
      summary: "읽지 않고 추측한 edit",
      complete: true,
      changes: [{ path: "src/web-main.ts", operation: "modify", baseContentDigest: web.contentDigest, content: null, edits: [{ oldText: "export const web = 9;", newText: "x" }] }],
    }, pack), /oldText not found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repair prompt는 원래 prompt의 표시를 이어받아 /work 읽기를 허용하고, 표시가 없으면 지금과 같다", () => {
  assert.deepEqual(repairWorkspaceRule("당신은 bounded IMPLEMENT Worker입니다.\n..."), {
    prefix: "",
    rule: "- repository, GitHub, 파일시스템, 네트워크를 탐색하거나 추가 파일을 요청하지 마세요.",
  });
  const marked = repairWorkspaceRule(`${IMPLEMENT_READ_TOOLS_MARKER}\n당신은 bounded IMPLEMENT Worker입니다.`);
  assert.equal(marked.prefix, `${IMPLEMENT_READ_TOOLS_MARKER}\n`);
  assert.match(marked.rule, /\/work/);
  assert.ok(!marked.rule.includes("탐색하거나 추가 파일을 요청하지 마세요"));

  const failure = { schemaVersion: 1 as const, kind: "worker-edit-application-failure" as const, code: "OLD_TEXT_NOT_FOUND" as const, path: "src/web-main.ts", editNumber: 1, message: "not found", rawOutput: {} };
  const markedPrompt = createWorkerEditRepairPrompt({ prompt: `${IMPLEMENT_READ_TOOLS_MARKER}\n원래 prompt` } as unknown as PlanImplementWorkerBundle, failure, 1);
  assert.equal(markedPrompt.split("\n", 1)[0], IMPLEMENT_READ_TOOLS_MARKER, "executor는 repair request도 첫 줄로 판단한다");
  assert.ok(!markedPrompt.includes("탐색하거나 추가 파일을 요청하지 마세요"));
  const plainPrompt = createWorkerEditRepairPrompt({ prompt: "원래 prompt" } as unknown as PlanImplementWorkerBundle, failure, 1);
  assert.ok(plainPrompt.startsWith("당신은 bounded IMPLEMENT repair Worker입니다."));
  assert.match(plainPrompt, /탐색하거나 추가 파일을 요청하지 마세요/);
});

test("PLAN 검증은 수정 대상 원문 합을 384KB까지 허용한다 (App #307의 119,258B는 통과)", () => {
  const root = mkdtempSync(join(tmpdir(), "plan-read-tools-budget-"));
  try {
    mkdirSync(join(root, "src"));
    const sha = "a".repeat(40);
    const write = (path: string, bytes: number) => writeFileSync(join(root, path), line(`export const v = "${path}";`, bytes));
    write("src/web-main.ts", 80_000);
    write("src/csv.ts", 40_000);
    write("src/huge-a.ts", 200_000);
    write("src/huge-b.ts", 200_000);
    const files = ["src/web-main.ts", "src/csv.ts", "src/huge-a.ts", "src/huge-b.ts"].map((path, index) => {
      const content = readFileSync(join(root, path), "utf8").slice(0, 18_000);
      return { evidenceId: `E${index + 1}`, path, startOffset: 0, byteLength: Buffer.byteLength(content, "utf8"), digestAlgorithm: "sha256" as const, contentDigest: createHash("sha256").update(content, "utf8").digest("hex"), content };
    });
    const payload = { schemaVersion: 1 as const, kind: "trusted-plan-context-pack" as const, repository: "example/orders", sha, files, totalBytes: files.reduce((sum, file) => sum + file.byteLength, 0) };
    const context = { ...payload, digestAlgorithm: "sha256", contextDigest: createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex") } as PlanContextPack;
    const plan = (allowedPaths: string[]) => ({
      summary: "기준 CSV 추가 열을 무시한다",
      analysis: [{ evidenceId: "E1", finding: "안내 문구" }],
      approach: ["헤더 검사를 바꾼다"],
      changeCandidates: allowedPaths.map((path) => `${path} 변경`),
      acceptanceCriteria: ["추가 열이 있어도 분석된다"],
      testStrategy: ["npm test"],
      questions: [],
      implementationScope: { ready: true, allowedPaths, contextPaths: [], requiredChanges: ["헤더 검사를 바꾼다"], forbiddenChanges: ["주문 CSV 규칙 유지"], validationCommands: ["npm test"] },
    });
    assert.doesNotThrow(() => validatePlan(plan(["src/web-main.ts", "src/csv.ts"]), root, context), "120KB는 원문 보관 상한 안이다");
    assert.throws(() => validatePlan(plan(["src/huge-a.ts", "src/huge-b.ts"]), root, context), /exceeds IMPLEMENT Context budget: \d+B > 384000B/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
