import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  createPlanPrompt,
  PLAN_ADDITIONAL_EVIDENCE_MAX_FILES,
  PLAN_READ_TOOLS_MARKER,
  PLAN_SCHEMA,
  selectPlanContext,
  validatePlan,
  type PlanContextPack,
} from "../src/self-improvement/planner.js";
import { renderPlanDecisionPacket } from "../src/self-improvement/plan-decision-packet.js";

// docs/architecture.md 4장 "PLAN의 격리된 읽기 도구"(#375): Pack 밖 근거는 최대 8개,
// trusted가 PLAN target exact SHA에서 다시 읽어 확장 evidence로 고정하고, 읽기 도구 실행이 아니면 거부한다.

const ORDER_CSV = "export function supplyRiskCsv(rows) { return rows.join(\"\\n\"); }\n";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "planner-additional-evidence-"));
  const target = join(root, "target");
  const output = join(root, "output");
  mkdirSync(target);
  mkdirSync(output);
  mkdirSync(join(target, "src"));
  writeFileSync(join(target, "src", "orders.ts"), "export const orders = [];\n");
  writeFileSync(join(target, "README.md"), "Order list\n");
  writeFileSync(join(target, "src", "order-csv.ts"), ORDER_CSV);
  return { root, target, output };
}

function packWithoutCsv(target: string): PlanContextPack {
  const context = selectPlanContext("orders 주문 목록", target, "example/orders", "a".repeat(40), { maxFiles: 1 });
  assert.equal(context.files.length, 1);
  assert.notEqual(context.files[0]!.path, "src/order-csv.ts");
  return context;
}

function planWith(context: PlanContextPack, additionalEvidence: unknown[], extra: Record<string, unknown> = {}) {
  return {
    summary: "공급 위험 CSV를 화면 목록과 맞춘다",
    additionalEvidence,
    analysis: [
      { evidenceId: context.files[0]!.evidenceId, finding: "Pack 안 파일" },
      ...additionalEvidence.map((entry) => ({ evidenceId: (entry as { evidenceId: string }).evidenceId, finding: "Pack 밖 파일" })),
    ],
    approach: ["CSV 출력 함수를 고친다"],
    changeCandidates: ["src/order-csv.ts 변경"],
    acceptanceCriteria: ["CSV와 화면이 같다"],
    testStrategy: ["CSV 테스트를 추가한다"],
    questions: [],
    implementationScope: {
      ready: true,
      allowedPaths: ["src/order-csv.ts"],
      contextPaths: [],
      requiredChanges: ["CSV 출력 함수를 고친다"],
      forbiddenChanges: [],
      validationCommands: ["npm test"],
    },
    ...extra,
  };
}

test("schema와 prompt가 Pack 밖 근거 최대 8개와 읽기 도구 지원 표시를 담는다", () => {
  const f = fixture();
  try {
    assert.equal(PLAN_ADDITIONAL_EVIDENCE_MAX_FILES, 8);
    assert.equal(PLAN_SCHEMA.properties.additionalEvidence.maxItems, 8);
    // 선택 필드다. 도구 없는 PLAN이 빠뜨려도 executor schema 검사에서 실패하지 않는다.
    assert.ok(!PLAN_SCHEMA.required.includes("additionalEvidence"));
    assert.equal(PLAN_SCHEMA.properties.additionalEvidence.items.properties.evidenceId.pattern, "^X[1-8]$");
    const analysisId = new RegExp(PLAN_SCHEMA.properties.analysis.items.properties.evidenceId.pattern);
    for (const id of ["E1", "E12", "X1", "X8"]) assert.ok(analysisId.test(id), id);
    for (const id of ["X0", "X9", "E0", "Y1"]) assert.ok(!analysisId.test(id), id);
    assert.equal(PLAN_READ_TOOLS_MARKER, "<!-- ai-dev-framework:PLAN_READ_TOOLS supported -->");
    const prompt = createPlanPrompt("orders 주문 목록", packWithoutCsv(f.target));
    assert.equal(prompt.split("\n", 1)[0], PLAN_READ_TOOLS_MARKER);
    assert.match(prompt, /additionalEvidence는 빈 배열 \[\]로 반환하세요/);
    assert.match(prompt, /evidenceId X1부터 차례로\(최대 8개\)/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("읽기 도구 실행이면 Pack 밖 파일을 exact SHA에서 다시 읽어 digest와 함께 확장 evidence로 고정한다", () => {
  const f = fixture();
  try {
    const context = packWithoutCsv(f.target);
    const plan = validatePlan(planWith(context, [{ evidenceId: "X1", path: "src/order-csv.ts" }]), f.target, context, { readTools: true });
    const digest = createHash("sha256").update(ORDER_CSV).digest("hex");
    assert.deepEqual(plan.additionalEvidence, [{
      evidenceId: "X1",
      path: "src/order-csv.ts",
      byteLength: Buffer.byteLength(ORDER_CSV),
      digestAlgorithm: "sha256",
      contentDigest: digest,
    }]);
    const analysis = plan.analysis as Array<{ evidenceId: string; path: string; contentDigest: string }>;
    assert.deepEqual(analysis[1], { evidenceId: "X1", path: "src/order-csv.ts", contentDigest: digest, finding: "Pack 밖 파일" });
    // 확장 evidence에 있는 기존 파일은 allowedPaths에 들어갈 수 있다.
    assert.deepEqual((plan.implementationScope as { allowedPaths: string[] }).allowedPaths, ["src/order-csv.ts"]);
    const packet = renderPlanDecisionPacket(plan as never);
    assert.match(packet, /AI가 Context Pack 밖에서 근거로 삼은 파일/);
    assert.match(packet, /X1 `src\/order-csv\.ts`/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("읽기 도구 실행이 아니면 Pack 밖 근거와 그것에 기댄 allowedPaths를 거부한다", () => {
  const f = fixture();
  try {
    const context = packWithoutCsv(f.target);
    assert.throws(
      () => validatePlan(planWith(context, [{ evidenceId: "X1", path: "src/order-csv.ts" }]), f.target, context),
      /requires an executor run with isolated read tools/,
    );
    assert.throws(
      () => validatePlan(planWith(context, [{ evidenceId: "X1", path: "src/order-csv.ts" }]), f.target, context, { readTools: false }),
      /requires an executor run with isolated read tools/,
    );
    // 빈 additionalEvidence나 필드가 없는 기존 형식은 지금과 같다. Pack 밖 기존 파일은 allowedPaths에 들 수 없다.
    assert.throws(() => validatePlan(planWith(context, []), f.target, context), /outside bounded PLAN context/);
    const legacy = planWith(context, []) as Record<string, unknown>;
    delete legacy.additionalEvidence;
    (legacy.implementationScope as { allowedPaths: string[] }).allowedPaths = [context.files[0]!.path];
    legacy.changeCandidates = [`${context.files[0]!.path} 변경`];
    assert.deepEqual(validatePlan(legacy, f.target, context).additionalEvidence, []);
    // X-id를 밝히지 않고 analysis에서만 쓰면 Pack 밖 근거로 보지 않는다.
    assert.throws(
      () => validatePlan({ ...planWith(context, []), analysis: [{ evidenceId: "X1", finding: "근거" }] }, f.target, context, { readTools: true }),
      /outside bounded PLAN context/,
    );
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("Pack 밖 근거는 경로 규칙·순서·상한을 하나라도 어기면 PLAN 전체를 거부한다", () => {
  const f = fixture();
  try {
    const context = packWithoutCsv(f.target);
    mkdirSync(join(f.target, ".git"));
    writeFileSync(join(f.target, ".git", "config"), "[core]\n");
    writeFileSync(join(f.target, "image.bin"), Buffer.from([0, 1, 2, 3]));
    symlinkSync("src/order-csv.ts", join(f.target, "link.ts"));
    mkdirSync(join(f.target, "linked-dir-target"));
    writeFileSync(join(f.target, "linked-dir-target", "a.ts"), "export {};\n");
    symlinkSync("linked-dir-target", join(f.target, "linked-dir"));
    const reject = (entries: unknown[], pattern: RegExp) =>
      assert.throws(() => validatePlan(planWith(context, entries, {
        implementationScope: { ready: false, allowedPaths: [], contextPaths: [], requiredChanges: [], forbiddenChanges: [], validationCommands: [] },
        questions: ["확인 필요"],
      }), f.target, context, { readTools: true }), pattern);
    reject([{ evidenceId: "X1", path: "src/missing.ts" }], /does not exist at frozen target SHA/);
    reject([{ evidenceId: "X1", path: "../outside.ts" }], /Unsafe PLAN additionalEvidence path/);
    reject([{ evidenceId: "X1", path: "/etc/passwd" }], /Unsafe PLAN additionalEvidence path/);
    reject([{ evidenceId: "X1", path: ".git/config" }], /inside \.git/);
    reject([{ evidenceId: "X1", path: "src" }], /not a regular file/);
    reject([{ evidenceId: "X1", path: "link.ts" }], /not a regular file/);
    reject([{ evidenceId: "X1", path: "linked-dir/a.ts" }], /resolves outside its exact location/);
    reject([{ evidenceId: "X1", path: "image.bin" }], /not UTF-8 text/);
    reject([{ evidenceId: "X1", path: context.files[0]!.path }], /already in Context Pack/);
    reject([{ evidenceId: "X2", path: "src/order-csv.ts" }], /X1\.\.Xn in order/);
    reject([{ evidenceId: "X1", path: "src/order-csv.ts" }, { evidenceId: "X2", path: "src/order-csv.ts" }], /Duplicate PLAN additionalEvidence path/);
    reject([{ evidenceId: "X1", path: "src/order-csv.ts", quote: "x" }], /Invalid PLAN additionalEvidence fields/);
    const nine = Array.from({ length: 9 }, (_, index) => {
      writeFileSync(join(f.target, "src", `extra-${index}.ts`), "export {};\n");
      return { evidenceId: `X${index + 1}`, path: `src/extra-${index}.ts` };
    });
    reject(nine, /exceeds budget/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("planner-handler artifact는 PLAN_EXECUTOR_READ_TOOLS=true일 때만 Pack 밖 근거를 받아 PLAN.json·PLAN.md에 남긴다", () => {
  const f = fixture();
  try {
    const requirement = join(f.output, "requirement.md");
    writeFileSync(requirement, "orders 주문 목록");
    const run = (command: string, extra: Record<string, string> = {}) => spawnSync(process.execPath, ["--import", "tsx", resolve("src/self-improvement/planner-handler.ts"), command], {
      env: { ...process.env, PLAN_TARGET: f.target, PLAN_OUTPUT: f.output, PLAN_REQUIREMENT: requirement, PLAN_REPOSITORY: "example/orders", PLAN_SHA: "a".repeat(40), ...extra },
      encoding: "utf8",
    });
    const prepared = run("prepare");
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(readFileSync(join(f.output, "prompt.md"), "utf8").split("\n", 1)[0], PLAN_READ_TOOLS_MARKER);
    const preparedContext = JSON.parse(readFileSync(join(f.output, "PLAN-context.json"), "utf8")) as PlanContextPack;
    // 요구에 "CSV"라는 말이 없어 src/order-csv.ts는 Pack에 들지 않는다(App #310의 order-csv.ts와 같은 모양).
    const outsidePath = "src/order-csv.ts";
    assert.ok(!preparedContext.files.some((file) => file.path === outsidePath));
    const raw = {
      ...planWith(preparedContext, [{ evidenceId: "X1", path: outsidePath }]),
      changeCandidates: [`${preparedContext.files[0]!.path} 변경`],
      implementationScope: {
        ready: true,
        allowedPaths: [preparedContext.files[0]!.path],
        contextPaths: [],
        requiredChanges: ["변경한다"],
        forbiddenChanges: [],
        validationCommands: ["npm test"],
      },
    };
    writeFileSync(join(f.output, "raw-plan.json"), JSON.stringify(raw));

    const rejected = run("artifact");
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /requires an executor run with isolated read tools/);
    assert.notEqual(run("artifact", { PLAN_EXECUTOR_READ_TOOLS: "yes" }).status, 0);

    const accepted = run("artifact", { PLAN_EXECUTOR_READ_TOOLS: "true" });
    assert.equal(accepted.status, 0, accepted.stderr);
    const artifact = JSON.parse(readFileSync(join(f.output, "PLAN.json"), "utf8"));
    // Handoff가 검사하는 wrapper 키는 그대로다.
    assert.deepEqual(Object.keys(artifact).sort(), ["context", "kind", "plan", "repository", "requirement", "sha"]);
    assert.equal(artifact.plan.additionalEvidence[0].path, outsidePath);
    assert.match(readFileSync(join(f.output, "PLAN.md"), "utf8"), /AI가 Context Pack 밖에서 근거로 삼은 파일/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("plan.yml은 PLAN_RESULT marker의 tools=read만 읽기 도구 실행으로 넘기고, 격리 PLAN 시간만큼 기다린다", () => {
  const workflow = readFileSync(resolve(".github/workflows/plan.yml"), "utf8");
  assert.match(workflow, /model=\(opus\|sonnet\)\(\?: tools=\(read\)\)\? encoding=gzip-base64 -->/);
  assert.match(workflow, /core\.setOutput\('read_tools', match\[11\] === 'read' \? 'true' : 'false'\)/);
  assert.match(workflow, /PLAN_EXECUTOR_READ_TOOLS: \$\{\{ steps\.wait\.outputs\.read_tools \}\}/);
  assert.match(workflow, /- name: Wait for subscription PLAN result\n        id: wait\n/);
  assert.match(workflow, /for \(let poll = 0; poll < 90; poll \+= 1\)/);
  assert.match(workflow, /  resolve:\n    needs: \[plan, request\]\n    runs-on: ubuntu-latest\n(?:    #[^\n]*\n)*    timeout-minutes: 18\n/);
});
