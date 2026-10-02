import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PLAN_IMPLEMENT_MAX_CONTEXT_BYTES,
  trimReadOnlyContextToBudget,
  validatePlan,
  type PlanContextPack,
} from "../src/self-improvement/planner.js";

const SHA = "a".repeat(40);

/** 크기를 정확히 맞춘 파일로 App #289(run 37018711973)과 같은 모양을 만든다. */
function fixture(): { target: string; context: PlanContextPack } {
  const root = mkdtempSync(join(tmpdir(), "planner-context-trim-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "test"));
  const write = (path: string, head: string, bytes: number) =>
    writeFileSync(join(root, path), `${head}\n//${"x".repeat(bytes - head.length - 4)}\n`);
  write("src/order-csv.ts", "export const csv = 1;", 40_000);
  write("test/order-csv.test.ts", "import { csv } from '../src/order-csv.js'; void csv;", 30_000);
  write("src/web-main.ts", "export const web = 1;", 30_000);
  write("src/batch.ts", "export const batch = 1;", 10_000);
  write("src/note.ts", "export const note = 1;", 5_000);

  const files = ["src/order-csv.ts", "test/order-csv.test.ts"].map((path, index) => {
    // 실제 Context Pack처럼 파일 앞부분 발췌만 담는다(파일당 20,000B 상한). 수정 대상은 IMPLEMENT에서 전체 크기로 계산된다.
    const content = readFileSync(join(root, path), "utf8").slice(0, 18_000);
    return {
      evidenceId: `E${index + 1}`, path, startOffset: 0, byteLength: Buffer.byteLength(content, "utf8"),
      digestAlgorithm: "sha256" as const, contentDigest: createHash("sha256").update(content, "utf8").digest("hex"), content,
    };
  });
  const payload = {
    schemaVersion: 1 as const, kind: "trusted-plan-context-pack" as const, repository: "example/orders", sha: SHA,
    files, totalBytes: files.reduce((sum, file) => sum + file.byteLength, 0),
  };
  const context = { ...payload, digestAlgorithm: "sha256", contextDigest: createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex") } as PlanContextPack;
  return { target: root, context };
}

function readyPlan(contextPaths: readonly string[], extra: Record<string, unknown> = {}) {
  return {
    summary: "공급 위험 CSV를 7열로 바꾼다",
    analysis: [{ evidenceId: "E1", finding: "CSV 생성 위치" }],
    approach: ["src/order-csv.ts의 공급 위험 CSV 생성을 바꾼다"],
    changeCandidates: ["src/order-csv.ts 변경", "test/order-csv.test.ts 변경"],
    acceptanceCriteria: ["헤더가 7열이다"],
    testStrategy: ["test/order-csv.test.ts 기대값을 갱신한다"],
    questions: [],
    implementationScope: {
      ready: true,
      allowedPaths: ["src/order-csv.ts", "test/order-csv.test.ts"],
      contextPaths: [...contextPaths],
      requiredChanges: ["src/order-csv.ts의 헤더를 7열로 바꾼다"],
      forbiddenChanges: ["판정 로직을 바꾸지 않는다"],
      validationCommands: ["npm test"],
    },
    ...extra,
  };
}

test("예산을 넘으면 PLAN이 언급하지 않은 읽기 전용 참고 파일을 큰 것부터 빼서 맞춘다 (App #289 run 37018711973)", () => {
  const { target, context } = fixture();
  // 40,000 + 30,000 (수정) + 30,000 + 10,000 + 5,000 (참고) = 115,000B > 96,000B
  const raw = readyPlan(["src/batch.ts", "src/web-main.ts", "src/note.ts"]);
  assert.throws(() => validatePlan(raw, target, context), /exceeds IMPLEMENT Context budget: 115000B > 96000B/);

  const { plan, removed } = trimReadOnlyContextToBudget(target, context, raw);
  assert.deepEqual(removed, ["src/web-main.ts"], "가장 큰 참고 파일 하나만 빼면 85,000B로 맞는다");
  const scope = validatePlan(plan, target, context).implementationScope as { allowedPaths: string[]; contextPaths: string[] };
  assert.deepEqual(scope.allowedPaths, ["src/order-csv.ts", "test/order-csv.test.ts"], "쓰기 범위는 줄이지 않는다");
  assert.deepEqual(scope.contextPaths, ["src/batch.ts", "src/note.ts"], "나머지 참고 파일과 순서는 그대로다");
  assert.deepEqual(trimReadOnlyContextToBudget(target, context, plan), { plan, removed: [] }, "예산 안이면 손대지 않는다");
});

test("PLAN이 언급한 참고 파일은 빼지 않고, 그래도 넘으면 손대지 않아 fail-closed를 유지한다", () => {
  const { target, context } = fixture();
  // web-main.ts를 testStrategy에서 언급하므로 뺄 수 없다. batch.ts(10,000B)를 빼도 105,000B라 그대로 둔다.
  const raw = readyPlan(["src/batch.ts", "src/web-main.ts"], {
    testStrategy: ["test/order-csv.test.ts 기대값을 갱신하고 src/web-main.ts의 화면 정렬과 같은지 확인한다"],
  });
  assert.deepEqual(trimReadOnlyContextToBudget(target, context, raw), { plan: raw, removed: [] });
  assert.throws(() => validatePlan(raw, target, context), /exceeds IMPLEMENT Context budget/);
});

test("ready가 아니거나 모양이 틀린 PLAN, 없는 참고 경로는 건드리지 않는다", () => {
  const { target, context } = fixture();
  const notReady = { ...readyPlan(["src/web-main.ts"]), implementationScope: { ...readyPlan([]).implementationScope, ready: false } };
  assert.deepEqual(trimReadOnlyContextToBudget(target, context, notReady), { plan: notReady, removed: [] });
  const missing = readyPlan(["src/web-main.ts", "src/missing.ts"]);
  assert.deepEqual(trimReadOnlyContextToBudget(target, context, missing), { plan: missing, removed: [] });
  const unsafe = readyPlan(["../outside.ts", "src/web-main.ts"]);
  assert.deepEqual(trimReadOnlyContextToBudget(target, context, unsafe), { plan: unsafe, removed: [] });
  assert.deepEqual(trimReadOnlyContextToBudget(target, context, null), { plan: null, removed: [] });
  assert.equal(PLAN_IMPLEMENT_MAX_CONTEXT_BYTES, 96_000);
});
