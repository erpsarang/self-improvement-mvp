import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  excludedDocumentPaths,
  PLAN_DECISION_PACKET_HEADING,
  PLAN_DECISION_PACKET_MAX_BYTES,
  assertApprovablePlanArtifact,
  describePlanAuthorizeRejection,
  isPlanApprovable,
  planArtifactQuestions,
  planDecisionNextAction,
  renderPlanDecisionPacket,
  writeGithubOutput,
  type PlanDecisionInput,
} from "../src/self-improvement/plan-decision-packet.js";

const readyPlan: PlanDecisionInput = {
  summary: "재고 부족 주문에 가용재고와 부족 수량을 표시한다.\n판정 규칙은 바꾸지 않는다.",
  acceptanceCriteria: ["주문수량 10, 가용재고 3이면 부족 수량 7이 표시된다."],
  testStrategy: ["test/exception-stock-display.test.ts에서 CSV 열과 표 열을 검증한다."],
  questions: [],
  implementationScope: {
    ready: true,
    allowedPaths: ["src/order-csv.ts", "src/web-main.ts", "test/exception-stock-display.test.ts"],
    requiredChanges: ["createExceptionCsv에 재고 열을 옵션으로 추가한다."],
    forbiddenChanges: ["기존 판정 규칙 변경"],
    validationCommands: ["npm test"],
  },
};

const blockedPlan: PlanDecisionInput = {
  summary: "웹 렌더링 파일이 Context Pack에 없어 범위를 확정하지 못했다.",
  acceptanceCriteria: ["확정 불가"],
  testStrategy: ["확정 불가"],
  questions: ["웹 렌더링 파일의 exact path를 알려 주세요.", "다운로드 파일 형식도 바꿔야 하나요?"],
  implementationScope: { ready: false, allowedPaths: [], requiredChanges: [], forbiddenChanges: [], validationCommands: [] },
};

const wrapper = (plan: unknown, overrides: Record<string, unknown> = {}) => ({
  kind: "untrusted-plan",
  repository: "example/app",
  sha: "a".repeat(40),
  requirement: "요구",
  context: { digestAlgorithm: "sha256", digest: "b".repeat(64), evidence: [], totalBytes: 0 },
  plan: { approach: ["접근"], ...(plan as object), implementationScope: { contextPaths: [], ...(plan as PlanDecisionInput).implementationScope } },
  ...overrides,
});

test("ready=true PLAN의 Packet은 사람이 승인 판단에 필요한 항목을 모두 담는다", () => {
  const packet = renderPlanDecisionPacket(readyPlan);
  assert.ok(packet.startsWith(PLAN_DECISION_PACKET_HEADING));
  assert.match(packet, /\*\*준비 상태:\*\* `ready=true`/);
  assert.match(packet, /\*\*Blocking Question:\*\* 없음/);
  assert.match(packet, /AI가 이해한 목표:\*\*\n재고 부족 주문에 가용재고와 부족 수량을 표시한다\. 판정 규칙은 바꾸지 않는다\./);
  assert.match(packet, /구현 항목 \(requiredChanges\):\*\*\n- createExceptionCsv에 재고 열을 옵션으로 추가한다\./);
  for (const path of readyPlan.implementationScope.allowedPaths) assert.ok(packet.includes(`- \`${path}\``));
  assert.match(packet, /완료조건 \(acceptanceCriteria\):\*\*\n- 주문수량 10/);
  assert.match(packet, /테스트 계획 \(testStrategy\):\*\*\n- test\/exception-stock-display\.test\.ts/);
  assert.match(packet, /검증 명령 \(validationCommands[^)]*\):\*\*\n- `npm test`/);
  assert.match(packet, /금지 변경 \(forbiddenChanges\):\*\*\n- 기존 판정 규칙 변경/);
  assert.match(packet, /- 승인: 이 Issue에 정확히 `PLAN-승인` 댓글을 남깁니다/);
  assert.match(packet, /- 기각: 사유를 댓글로 남기고 Issue를 `not_planned`로 닫습니다/);
  assert.match(packet, /- 요구사항 보완 후 재PLAN:/);
  assert.match(packet, /승인 시 exact PLAN artifact와 provenance를 다시 검증하며, 이 댓글 자체는 authority가 아닙니다/);
  assert.doesNotMatch(packet, /승인할 수 없습니다/);
  assert.equal(isPlanApprovable(readyPlan), true);
});

test("ready=false 또는 blocking question이 있으면 승인 불가와 질문 내용을 사람이 직접 볼 수 있다", () => {
  const packet = renderPlanDecisionPacket(blockedPlan);
  assert.match(packet, /\*\*준비 상태:\*\* `ready=false` — \*\*이 PLAN은 승인할 수 없습니다\.\*\*/);
  assert.match(packet, /`PLAN-승인`을 남겨도 PLAN_AUTHORIZE가 fail-closed로 거부합니다/);
  assert.match(packet, /\*\*Blocking Question \(2개, 사람이 답해야 함\):\*\*\n1\. 웹 렌더링 파일의 exact path를 알려 주세요\.\n2\. 다운로드 파일 형식도 바꿔야 하나요\?/);
  assert.match(packet, /변경 예상 파일[^\n]*\n- 미확정 \(ready=false\)/);
  assert.match(packet, /- 승인: 지금은 불가합니다/);
  assert.equal(isPlanApprovable(blockedPlan), false);

  // schema상 불가능하지만 ready=true에 질문이 남은 경우도 승인 불가로 표시한다.
  const inconsistent = { ...readyPlan, questions: ["남은 질문"] };
  assert.equal(isPlanApprovable(inconsistent), false);
  assert.match(renderPlanDecisionPacket(inconsistent), /이 PLAN은 승인할 수 없습니다\.\*\* Blocking Question이 남아 있습니다/);
});

test("HumanStatus 다음 행동 문구는 승인 가능 여부에 따라 달라진다", () => {
  assert.match(planDecisionNextAction(true), /허용하면 정확히 `PLAN-승인` 댓글/);
  assert.match(planDecisionNextAction(false), /이 PLAN은 승인할 수 없습니다/);
  assert.notEqual(planDecisionNextAction(true), planDecisionNextAction(false));
});

test("크기 상한을 넘으면 문장을 자르지 않고 섹션 단위로 생략하되 판단 필수 항목은 남긴다", () => {
  const long = "가".repeat(1500);
  const huge: PlanDecisionInput = {
    ...readyPlan,
    summary: long,
    acceptanceCriteria: Array.from({ length: 8 }, () => long),
    testStrategy: Array.from({ length: 8 }, () => long),
    implementationScope: {
      ...readyPlan.implementationScope,
      requiredChanges: Array.from({ length: 8 }, () => long),
      forbiddenChanges: Array.from({ length: 8 }, () => long),
    },
  };
  const full = renderPlanDecisionPacket(huge, { maxBytes: Number.MAX_SAFE_INTEGER });
  assert.ok(Buffer.byteLength(full, "utf8") > PLAN_DECISION_PACKET_MAX_BYTES);
  const bounded = renderPlanDecisionPacket(huge);
  assert.ok(Buffer.byteLength(bounded, "utf8") <= PLAN_DECISION_PACKET_MAX_BYTES);
  assert.match(bounded, /댓글 크기 제한으로 .* 섹션을 생략했습니다\. 전체 내용은 PLAN artifact의 PLAN\.md를 확인하세요\./);
  assert.match(bounded, /\*\*준비 상태:\*\* `ready=true`/);
  assert.match(bounded, /\*\*Blocking Question:\*\* 없음/);
  for (const path of readyPlan.implementationScope.allowedPaths) assert.ok(bounded.includes(`- \`${path}\``));
  assert.match(bounded, /- `npm test`/);
  assert.match(bounded, /\*\*사람의 선택지:\*\*/);
  // 가장 덜 중요한 testStrategy부터 생략된다.
  assert.doesNotMatch(bounded, /테스트 계획 \(testStrategy\)/);
  const partial = renderPlanDecisionPacket(huge, { maxBytes: Buffer.byteLength(full, "utf8") - 1 });
  assert.doesNotMatch(partial, /테스트 계획 \(testStrategy\)/);
  assert.match(partial, /완료조건 \(acceptanceCriteria\)/);
  // 상한 안이면 아무것도 생략하지 않는다.
  assert.doesNotMatch(renderPlanDecisionPacket(readyPlan), /섹션을 생략했습니다/);
});

test("assertApprovablePlanArtifact는 Handoff와 같은 기준으로 승인 가능 여부를 판정하고 질문을 돌려준다", () => {
  const expected = { repository: "example/app", targetSha: "a".repeat(40) };
  const approved = assertApprovablePlanArtifact(wrapper(readyPlan), expected);
  assert.equal(approved.implementationScope.ready, true);
  assert.deepEqual(approved.implementationScope.allowedPaths, readyPlan.implementationScope.allowedPaths);
  assert.deepEqual(planArtifactQuestions(wrapper(readyPlan)), []);

  // 거부 댓글에 실을 질문은 검증 전에 읽을 수 있어야 한다 (검증은 질문이 있으면 던진다).
  assert.deepEqual(planArtifactQuestions(wrapper(blockedPlan)), blockedPlan.questions);
  assert.deepEqual(planArtifactQuestions({ plan: { questions: ["q", 1, null] } }), ["q"]);
  assert.deepEqual(planArtifactQuestions("garbage"), []);
  assert.throws(() => assertApprovablePlanArtifact(wrapper(blockedPlan), expected), /approved PLAN still has blocking questions/);
  assert.throws(
    () => assertApprovablePlanArtifact(wrapper({ ...readyPlan, implementationScope: { ...readyPlan.implementationScope, ready: false } }), expected),
    /approved PLAN implementationScope is not ready/,
  );
  assert.throws(() => assertApprovablePlanArtifact(wrapper(readyPlan, { sha: "f".repeat(40) }), expected), /PLAN artifact SHA mismatch/);
  assert.throws(() => assertApprovablePlanArtifact(wrapper(readyPlan, { repository: "other/app" }), expected), /PLAN artifact repository mismatch/);
  assert.throws(() => assertApprovablePlanArtifact(wrapper(readyPlan, { kind: "trusted-plan" }), expected), /PLAN artifact kind is invalid/);
  assert.throws(() => assertApprovablePlanArtifact("not an object", expected), /PLAN artifact must be an object/);
});

test("거부 사유는 사람이 행동할 수 있는 문장으로 바뀌고 원문은 detail에 남는다", () => {
  const notReady = describePlanAuthorizeRejection(new Error("approved PLAN still has blocking questions"), blockedPlan.questions);
  assert.match(notReady.reason, /아직 구현 준비 상태가 아닙니다/);
  assert.match(notReady.nextAction, /Issue 본문을 보완한 뒤 PLAN을 다시 받거나/);
  assert.equal(notReady.detail, "approved PLAN still has blocking questions");
  assert.deepEqual(notReady.questions, blockedPlan.questions);
  assert.match(describePlanAuthorizeRejection(new Error("approved PLAN implementationScope is not ready")).reason, /아직 구현 준비 상태가 아닙니다/);

  const stale = describePlanAuthorizeRejection(new Error("current target SHA mismatch; re-plan required"));
  assert.match(stale.reason, /default branch가 이동했습니다/);
  assert.match(stale.nextAction, /PLAN을 다시 받으세요/);

  const changed = describePlanAuthorizeRejection(new Error("current requirement digest mismatch; re-plan required"));
  assert.match(changed.reason, /Issue 제목 또는 본문이 바뀌었습니다/);

  assert.match(describePlanAuthorizeRejection(new Error("no valid PLAN provenance exists before this approval")).reason, /유효한 PLAN이 없습니다/);
  assert.match(describePlanAuthorizeRejection(new Error("PLAN approval must come from a human GitHub user")).reason, /사람 GitHub 계정만/);

  const unknown = describePlanAuthorizeRejection(new Error("GitHub API 500 for /repos/x"));
  assert.match(unknown.reason, /trusted PLAN_AUTHORIZE 검증이 실패했습니다/);
  assert.equal(unknown.detail, "GitHub API 500 for /repos/x");
  assert.equal(describePlanAuthorizeRejection("plain string").detail, "plain string");
});

test("writeGithubOutput은 한 줄 값과 여러 줄 값을 GitHub Actions 형식으로 기록한다", () => {
  const root = mkdtempSync(join(tmpdir(), "plan-decision-output-"));
  try {
    const outputPath = join(root, "output");
    writeGithubOutput(outputPath, "plan_ready", "true");
    writeGithubOutput(outputPath, "decision_packet", "line 1\nline 2\n\nline 4");
    const content = readFileSync(outputPath, "utf8");
    assert.match(content, /^plan_ready=true\n/);
    const heredoc = /decision_packet<<(ghadelim_[0-9a-f]{32})\nline 1\nline 2\n\nline 4\n\1\n$/.exec(content);
    assert.ok(heredoc, content);
    assert.throws(() => writeGithubOutput(outputPath, "bad-name", "x"), /invalid GITHUB_OUTPUT name/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const withForbidden = (forbiddenChanges: string[], allowedPaths = readyPlan.implementationScope.allowedPaths): PlanDecisionInput => ({
  ...readyPlan,
  implementationScope: { ...readyPlan.implementationScope, allowedPaths: [...allowedPaths], forbiddenChanges },
});

test("문서 수정을 금지 목록으로 제외한 PLAN은 승인 전에 그 사실을 고정 문장으로 알린다 (#402)", () => {
  // transportation_guide Issue 16의 PLAN이 실제로 낸 금지 문장이다.
  const packet = renderPlanDecisionPacket(withForbidden(["package.json과 README.md를 수정하지 않는다."]));
  assert.match(packet, /\*\*문서 수정 제외 안내:\*\* 이 PLAN은 `README\.md`의 수정을 이번 범위에서 제외했습니다\./);
  assert.match(packet, /문서를 고치는 사이클이 한 번 더 필요할 수 있습니다/);
  assert.match(packet, /실제로 어긋나는지는 판단하지 않습니다/);
  // 금지 변경 섹션 뒤, 사람의 선택지 앞에 놓인다.
  assert.ok(packet.indexOf("금지 변경 (forbiddenChanges)") < packet.indexOf("문서 수정 제외 안내"));
  assert.ok(packet.indexOf("문서 수정 제외 안내") < packet.indexOf("사람의 선택지"));
  // 안내는 표시 전용이다: 승인 가능 여부를 바꾸지 않는다.
  assert.equal(isPlanApprovable(withForbidden(["README.md 수정 금지"])), true);
});

test("문서가 allowedPaths에 있거나 문서 금지가 없으면 안내를 만들지 않는다", () => {
  assert.doesNotMatch(renderPlanDecisionPacket(readyPlan), /문서 수정 제외 안내/);
  assert.doesNotMatch(
    renderPlanDecisionPacket(withForbidden(["README.md의 다른 절을 바꾸지 않는다"], ["README.md", "src/order-csv.ts"])),
    /문서 수정 제외 안내/,
  );
  assert.doesNotMatch(renderPlanDecisionPacket(withForbidden(["package.json을 수정하지 않는다", "기존 판정 규칙 변경"])), /문서 수정 제외 안내/);
  // ready=false PLAN에는 범위가 비어 있어 안내가 없다.
  assert.doesNotMatch(renderPlanDecisionPacket(blockedPlan), /문서 수정 제외 안내/);
});

test("excludedDocumentPaths는 문서 경로와 docs 디렉터리 표기를 뽑고 allowedPaths가 덮은 것은 뺀다", () => {
  const scope = (forbiddenChanges: string[], allowedPaths: string[] = []) => ({ forbiddenChanges, allowedPaths });
  assert.deepEqual(excludedDocumentPaths(scope(["package.json과 README.md를 수정하지 않는다."])), ["README.md"]);
  assert.deepEqual(excludedDocumentPaths(scope(["docs/usage.md, docs/architecture.md는 손대지 않는다"])), ["docs/usage.md", "docs/architecture.md"]);
  assert.deepEqual(excludedDocumentPaths(scope(["docs/ 아래 문서를 수정하지 않는다"])), ["docs/"]);
  assert.deepEqual(excludedDocumentPaths(scope(["docs/ 아래 문서를 수정하지 않는다"], ["docs/usage.md"])), []);
  assert.deepEqual(excludedDocumentPaths(scope(["README.md 수정 금지", "README.md 재확인"])), ["README.md"]);
  assert.deepEqual(excludedDocumentPaths(scope(["src/app.ts 수정 금지", "package.json 변경 금지"])), []);
  const many = Array.from({ length: 9 }, (_, index) => `docs/doc${index}.md`).join(" ");
  assert.equal(excludedDocumentPaths(scope([many])).length, 5);
});

test("문서 제외 안내는 크기 상한 때문에 생략되지 않는다", () => {
  const huge = withForbidden(["README.md 수정 금지"]);
  const packet = renderPlanDecisionPacket({ ...huge, summary: "가".repeat(30_000), testStrategy: ["나".repeat(30_000)] });
  assert.match(packet, /문서 수정 제외 안내/);
});
