import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  createProductEvaluationOutputSchema,
  createProductEvaluationPrompt,
  createProductEvaluationReport,
  createProductSnapshot,
  decideImprovementIssue,
  isFrameworkOwnedPath,
  PRODUCT_EVALUATION_BUDGET,
  productEvaluationReportArtifactName,
  productSnapshotArtifactName,
  SELF_IMPROVEMENT_TITLE_PREFIX,
  verifyProductEvaluationReport,
  verifyProductSnapshot,
  type ExistingIssue,
  type ProductCycleIdentity,
  type ProductEvaluationReport,
  type ProductSnapshot,
  type RejectedCandidate,
} from "../src/self-improvement/product-evaluation.js";

const cycle: ProductCycleIdentity = {
  repository: "erpsarang/classic-paragraph-wit",
  requirementIssueNumber: 6,
  humanMergePullRequestNumber: 7,
  reviewedHeadSha: "6d819957a2c7f6cabd637c674c1fa4a8c1672bad",
  mergeCommitSha: "1252246a861cb8c7edf64488c40b6bfe438d69e7",
  deployedSha: "90eaf07d1b0e4a2c2f3f6a5b8c7d9e0f1a2b3c4d",
};

function write(root: string, path: string, content: string): void {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content, "utf8");
}

/** 배포된 App과 Framework distribution이 같은 repository에 있는 실제 구조를 만든다. */
function appFixture(extra: Record<string, string> = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "product-evaluation-")));

  write(root, "README.md", "# classic-paragraph-wit\n\n고전 한 문단과 위트를 추천하는 App입니다.\n");
  write(root, "index.html", "<!doctype html>\n<html lang=\"ko\"><body><main id=\"app\"></main></body></html>\n");
  write(root, "src/classics.js", "export const classics = [{ id: \"pride-and-prejudice\" }, { id: \"a-tale-of-two-cities\" }];\n");
  write(root, "src/recommendation.js", "export function getRecommendation() { return classics[0]; }\n");
  write(root, "src/web.js", "import { getRecommendation } from \"./recommendation.js\";\n");
  write(root, "package.json", "{\n  \"name\": \"classic-paragraph-wit\"\n}\n");
  write(root, "docs/github-pages.md", "# GitHub Pages에서 사용하기\n");

  // Framework distribution과 생성 파일은 제품 평가 대상이 아니다.
  write(root, ".github/workflows/plan.yml", "name: Read-only AI PLAN\n");
  write(root, "src/self-improvement/planner.ts", "export const planner = 1;\n");
  write(root, "policy/framework-distribution-ownership.v1.json", "{}\n");
  write(root, "FRAMEWORK.md", "- Framework source SHA: `" + "a".repeat(40) + "`\n");
  write(root, ".framework-runtime/package.json", "{}\n");
  write(root, "package-lock.json", "{ \"lockfileVersion\": 3 }\n");
  write(root, "test/app.test.js", "import test from \"node:test\";\n");

  for (const [path, content] of Object.entries(extra)) write(root, path, content);
  return root;
}

function snapshotPaths(snapshot: ProductSnapshot): string[] {
  return snapshot.files.map(({ path }) => path);
}

const evaluatorIdentity = {
  sourceRun: { runId: 35684111689, runAttempt: 1 },
  snapshotArtifact: {
    name: "product-snapshot-issue-6-pr-7",
    id: 10675837390,
    digest: `sha256:${"b".repeat(64)}`,
  },
  evaluator: {
    provider: "OpenAI",
    action: "openai/codex-action@v1",
    model: "action-default",
    reasoningEffort: "medium",
  },
} as const;

function rawEvaluation(
  snapshot: ProductSnapshot,
  candidates: readonly unknown[],
  observations: readonly unknown[] = [
    {
      id: "observation-01",
      statement: "추천 가능한 고전이 두 편뿐이라 다시 눌러도 같은 작품이 번갈아 나온다.",
      evidencePaths: ["src/classics.js"],
    },
  ],
): unknown {
  return {
    schemaVersion: 1,
    kind: "untrusted-product-evaluation",
    sourceSnapshotDigest: snapshot.snapshotDigest,
    observations,
    candidates,
  };
}

const diversityCandidate = {
  title: "추천 가능한 고전 작품 수를 늘린다",
  problem: "지금은 고전이 두 편뿐이라 다른 고전 추천을 눌러도 같은 작품만 번갈아 나옵니다.",
  desiredOutcome: "여러 번 눌러도 새로운 작품이 나오도록 공개된 고전을 더 담고 싶습니다.",
  acceptanceExample: "연속으로 다섯 번 눌렀을 때 서로 다른 작품이 표시됩니다.",
  constraint: "기존 작품명, 저자, 문단, 위트 네 항목 표시는 그대로 유지합니다.",
  scopePaths: ["src/classics.js", "test/app.test.js"],
  evidencePaths: ["src/classics.js", "src/recommendation.js"],
  confidence: "high",
} as const;

function reportWith(snapshot: ProductSnapshot, candidates: readonly unknown[]): ProductEvaluationReport {
  return createProductEvaluationReport(snapshot, rawEvaluation(snapshot, candidates), evaluatorIdentity);
}

test("제품 snapshot은 App 제품 파일만 담고 Framework distribution을 제외한다", () => {
  const snapshot = createProductSnapshot(cycle, appFixture());
  verifyProductSnapshot(snapshot);

  assert.deepEqual(snapshotPaths(snapshot), [
    "docs/github-pages.md",
    "index.html",
    "package.json",
    "README.md",
    "src/classics.js",
    "src/recommendation.js",
    "src/web.js",
  ]);

  for (const path of snapshotPaths(snapshot)) assert.equal(isFrameworkOwnedPath(path), false);
  assert.equal(snapshot.repository, cycle.repository);
  assert.equal(snapshot.deployedCycle.mergeCommitSha, cycle.mergeCommitSha);
  // 평가 대상은 특정 PR의 트리가 아니라 지금 배포된 default branch다.
  assert.equal(snapshot.deployedCycle.deployedSha, cycle.deployedSha);
  assert.equal(snapshot.fileCount, snapshot.files.length);
  assert.equal(
    snapshot.totalSnapshotBytes,
    snapshot.files.reduce((sum, file) => sum + file.byteLength, 0),
  );
});

test("Framework 소유 경로 판단은 workflow, 런타임, policy, 매니페스트를 모두 포함한다", () => {
  for (const path of [
    ".github/workflows/plan.yml",
    "src/self-improvement/planner.ts",
    "policy/framework-distribution-ownership.v1.json",
    "FRAMEWORK.md",
    ".framework-runtime/package.json",
    "test/self-improvement/plan-implement-worker-recovery.test.ts",
  ]) {
    assert.equal(isFrameworkOwnedPath(path), true, path);
  }
  for (const path of ["src/classics.js", "index.html", "README.md", "docs/github-pages.md", "test/app.test.js"]) {
    assert.equal(isFrameworkOwnedPath(path), false, path);
  }
});

test("같은 merge commit 내용은 항상 같은 snapshot digest를 만든다", () => {
  const first = createProductSnapshot(cycle, appFixture());
  const second = createProductSnapshot(cycle, appFixture());
  assert.equal(first.snapshotDigest, second.snapshotDigest);
  assert.equal(
    productSnapshotArtifactName(first),
    `product-snapshot-issue-6-pr-7-${first.snapshotDigest}`,
  );
  assert.equal(
    productEvaluationReportArtifactName(first, 42, 1),
    "product-evaluation-issue-6-pr-7-42-attempt-1",
  );
});

test("snapshot 내용이 바뀌면 digest 검증이 fail-closed 한다", () => {
  const snapshot = createProductSnapshot(cycle, appFixture());
  const tampered = {
    ...snapshot,
    files: snapshot.files.map((file) =>
      file.path === "src/classics.js" ? { ...file, content: `${file.content}// 조작\n` } : file,
    ),
  };
  assert.throws(() => verifyProductSnapshot(tampered), /content digest mismatch/);
});

test("예산을 넘는 파일과 symlink는 snapshot에서 빠지고 omittedPaths에 남는다", () => {
  const root = appFixture({
    "src/huge.js": `// ${"x".repeat(PRODUCT_EVALUATION_BUDGET.maxFileBytes)}\n`,
  });
  symlinkSync(join(root, "README.md"), join(root, "src/linked.md"));

  const snapshot = createProductSnapshot(cycle, root);
  verifyProductSnapshot(snapshot);
  assert.equal(snapshotPaths(snapshot).includes("src/huge.js"), false);
  assert.deepEqual(snapshot.omittedPaths, ["src/huge.js"]);
  assert.equal(snapshotPaths(snapshot).includes("src/linked.md"), false);
});

test("제품 파일이 많아도 README와 화면을 먼저 담고 나머지는 omittedPaths로 남긴다", () => {
  const extra: Record<string, string> = {};
  for (let index = 0; index < 40; index += 1) {
    extra[`src/module-${String(index).padStart(2, "0")}.js`] = `export const module${index} = ${index};\n`;
  }
  const snapshot = createProductSnapshot(cycle, appFixture(extra));
  verifyProductSnapshot(snapshot);

  assert.equal(snapshot.fileCount, PRODUCT_EVALUATION_BUDGET.maxFiles);
  assert.equal(snapshotPaths(snapshot).includes("README.md"), true);
  assert.equal(snapshotPaths(snapshot).includes("index.html"), true);
  assert.equal(snapshot.omittedPaths.length > 0, true);
  assert.equal(snapshot.totalSnapshotBytes <= PRODUCT_EVALUATION_BUDGET.maxTotalBytes, true);
});

test("prompt와 output schema는 exact snapshot에 결합되고 후보를 1개로 제한한다", () => {
  const snapshot = createProductSnapshot(cycle, appFixture());
  const prompt = createProductEvaluationPrompt(snapshot);
  assert.match(prompt, /read-only AI Product Evaluator/);
  assert.match(prompt, /candidates는 최대 1개입니다/);
  assert.match(prompt, /개발 프로세스, CI, 테스트 전략, workflow, 리뷰 방식, 배포 자동화는 평가 대상이 아닙니다/);
  assert.match(prompt, new RegExp(snapshot.snapshotDigest));
  assert.doesNotMatch(prompt, /self-improvement\/planner\.ts/);

  const schema = createProductEvaluationOutputSchema(snapshot) as {
    properties: {
      sourceSnapshotDigest: { type: string; const: string };
      candidates: { maxItems: number; items: { properties: { evidencePaths: Record<string, unknown> } } };
    };
  };
  assert.deepEqual(schema.properties.sourceSnapshotDigest, {
    type: "string",
    const: snapshot.snapshotDigest,
  });
  assert.equal(schema.properties.candidates.maxItems, 1);
  assert.deepEqual(schema.properties.candidates.items.properties.evidencePaths, {
    type: "array",
    minItems: 1,
    items: { type: "string", enum: snapshotPaths(snapshot) },
  });
  // Codex structured output이 지원하지 않는 keyword는 사용하지 않는다.
  assert.equal(JSON.stringify(schema).includes("uniqueItems"), false);
});

test("trusted finalize는 한 cycle에 2개 이상의 후보를 거부한다", () => {
  const snapshot = createProductSnapshot(cycle, appFixture());
  assert.throws(
    () => reportWith(snapshot, [diversityCandidate, { ...diversityCandidate, title: "두 번째 후보" }]),
    /at most one candidate per cycle/,
  );
});

test("trusted finalize는 Framework 경로를 개선 범위로 삼는 후보를 거부한다", () => {
  const snapshot = createProductSnapshot(cycle, appFixture());
  for (const scopePath of [
    ".github/workflows/learn.yml",
    "src/self-improvement/learn-report.ts",
    "policy/framework-distribution-ownership.v1.json",
    "FRAMEWORK.md",
  ]) {
    assert.throws(
      () => reportWith(snapshot, [{ ...diversityCandidate, scopePaths: [scopePath] }]),
      /must not target Framework-owned paths/,
      scopePath,
    );
  }
});

test("trusted finalize는 snapshot 밖의 근거와 탈출 경로를 거부한다", () => {
  const snapshot = createProductSnapshot(cycle, appFixture());
  assert.throws(
    () => reportWith(snapshot, [{ ...diversityCandidate, evidencePaths: ["src/self-improvement/planner.ts"] }]),
    /references a path outside the product snapshot/,
  );
  assert.throws(
    () => reportWith(snapshot, [{ ...diversityCandidate, scopePaths: ["../other-repo/src/app.js"] }]),
    /unsafe path segment/,
  );
});

test("trusted finalize는 스스로 태그를 붙인 제목과 알 수 없는 필드를 거부한다", () => {
  const snapshot = createProductSnapshot(cycle, appFixture());
  assert.throws(
    () => reportWith(snapshot, [{ ...diversityCandidate, title: "[업무 요구] 고전을 더 넣자" }]),
    /must not carry its own bracket tag/,
  );
  assert.throws(
    () => reportWith(snapshot, [{ ...diversityCandidate, priority: 1 }]),
    /contains unsupported fields: priority/,
  );
});

test("검증된 report는 canonical 모양과 digest로 다시 검증된다", () => {
  const snapshot = createProductSnapshot(cycle, appFixture());
  const report = reportWith(snapshot, [diversityCandidate]);
  verifyProductEvaluationReport(report, snapshot);

  assert.equal(report.kind, "untrusted-product-evaluation-report");
  assert.equal(report.candidate?.title, diversityCandidate.title);
  assert.equal(report.source.snapshot.snapshotDigest, snapshot.snapshotDigest);
  assert.equal(report.evaluator.action, "openai/codex-action@v1");

  const tampered = {
    ...report,
    candidate: report.candidate === null ? null : { ...report.candidate, title: "조작된 제목" },
  };
  assert.throws(() => verifyProductEvaluationReport(tampered, snapshot), /digest or canonical shape mismatch/);
});

test("후보가 없으면 Issue를 만들지 않는다", () => {
  const snapshot = createProductSnapshot(cycle, appFixture());
  const decision = decideImprovementIssue(reportWith(snapshot, []), []);
  assert.equal(decision.action, "skip");
  assert.match(decision.action === "skip" ? decision.reason : "", /명백한 개선 후보를 찾지 못했습니다/);
});

test("열린 Improvement Candidate Issue가 있으면 새 후보를 쌓지 않는다", () => {
  const snapshot = createProductSnapshot(cycle, appFixture());
  const report = reportWith(snapshot, [diversityCandidate]);
  const existing: ExistingIssue[] = [
    { number: 9, title: `${SELF_IMPROVEMENT_TITLE_PREFIX} 전혀 다른 개선`, state: "open" },
  ];
  const decision = decideImprovementIssue(report, existing);
  assert.equal(decision.action, "skip");
  assert.match(decision.action === "skip" ? decision.reason : "", /이미 열린 Improvement Candidate Issue가 있습니다: #9/);
});

test("같은 제목이 닫힌 Issue로 이미 있으면 중복 생성하지 않는다", () => {
  const snapshot = createProductSnapshot(cycle, appFixture());
  const report = reportWith(snapshot, [diversityCandidate]);
  const existing: ExistingIssue[] = [
    { number: 11, title: `${SELF_IMPROVEMENT_TITLE_PREFIX}   추천 가능한 고전 작품 수를   늘린다 `, state: "closed" },
  ];
  const decision = decideImprovementIssue(report, existing);
  assert.equal(decision.action, "skip");
  assert.match(decision.action === "skip" ? decision.reason : "", /같은 제목의 Issue가 이미 있습니다: #11/);
});

test("중복이 없으면 업무 요구 서식과 provenance를 갖춘 Improvement Candidate Issue를 만든다", () => {
  const snapshot = createProductSnapshot(cycle, appFixture());
  const report = reportWith(snapshot, [diversityCandidate]);
  const existing: ExistingIssue[] = [
    { number: 6, title: "[업무 요구] 고전의 위트를 바꾸고 싶다", state: "closed" },
    { number: 9, title: `${SELF_IMPROVEMENT_TITLE_PREFIX} 지난 사이클 후보`, state: "closed" },
  ];
  const decision = decideImprovementIssue(report, existing);
  assert.equal(decision.action, "create");
  if (decision.action !== "create") return;

  assert.equal(decision.title, `${SELF_IMPROVEMENT_TITLE_PREFIX} 추천 가능한 고전 작품 수를 늘린다`);
  // 자동 생성 Issue는 [업무 요구] 접두사를 쓰지 않으므로 PLAN이 자동으로 시작되지 않는다.
  assert.equal(decision.title.startsWith("[업무 요구]"), false);

  for (const heading of [
    "## 어떤 업무가 불편한가요?",
    "## 어떻게 바뀌면 좋겠나요?",
    "## 잘 되었다고 판단할 수 있는 예",
    "## 지켜야 할 사항",
    "## 예상 변경 범위",
    "## 근거로 읽은 제품 파일",
  ]) {
    assert.equal(decision.body.includes(heading), true, heading);
  }
  assert.match(
    decision.body,
    new RegExp(
      `<!-- ai-dev-framework:PRODUCT_IMPROVEMENT cycle-issue=6 cycle-pr=7 snapshot=${snapshot.snapshotDigest} -->`,
    ),
  );
  assert.match(decision.body, /### HumanStatus: IMPROVEMENT_CANDIDATE/);
  assert.match(decision.body, /PLAN-승인 이후에만 구현이 시작됩니다/);
  assert.match(decision.body, /최종 Merge는 Human-only입니다/);
  assert.match(decision.body, new RegExp(`Product Evaluation report SHA-256: \`${report.reportDigest}\``));
  assert.match(decision.body, new RegExp(`평가한 배포 SHA: \`${cycle.deployedSha}\``));
});

const rejectedTranslation: RejectedCandidate = {
  issueNumber: 11,
  title: `${SELF_IMPROVEMENT_TITLE_PREFIX} 추천 문단에 한국어 번역을 함께 제공하기`,
  reason: "public domain 원문만 싣고 번역은 사용하지 않는다는 제품 방침을 유지한다.",
};

test("사람이 기각한 후보는 snapshot에 canonical하게 담기고 digest에 반영된다", () => {
  const root = appFixture();
  const plain = createProductSnapshot(cycle, root);
  const withRejected = createProductSnapshot(cycle, root, [
    { issueNumber: 4, title: "  오래된 기각 후보 ", reason: "" },
    rejectedTranslation,
  ]);
  verifyProductSnapshot(withRejected);

  assert.deepEqual(plain.rejectedCandidates, []);
  assert.notEqual(plain.snapshotDigest, withRejected.snapshotDigest);
  // 최신 Issue가 먼저 오고 접두사와 공백은 정리된다.
  assert.deepEqual(withRejected.rejectedCandidates, [
    { issueNumber: 11, title: "추천 문단에 한국어 번역을 함께 제공하기", reason: rejectedTranslation.reason },
    { issueNumber: 4, title: "오래된 기각 후보", reason: "" },
  ]);
});

test("기각 후보가 조작되면 snapshot 검증이 fail-closed 한다", () => {
  const snapshot = createProductSnapshot(cycle, appFixture(), [rejectedTranslation]);
  const reordered = { ...snapshot, rejectedCandidates: [{ ...snapshot.rejectedCandidates[0]!, reason: "조작" }] };
  assert.throws(() => verifyProductSnapshot(reordered), /digest mismatch|not canonical/);
});

test("기각 후보 입력은 예산과 모양을 결정적으로 강제한다", () => {
  const root = appFixture();
  assert.throws(
    () => createProductSnapshot(cycle, root, Array.from({ length: PRODUCT_EVALUATION_BUDGET.maxRejectedCandidates + 1 }, (_, index) => ({
      issueNumber: index + 1, title: `후보 ${index}`, reason: "",
    }))),
    /exceeds maxRejectedCandidates/,
  );
  assert.throws(
    () => createProductSnapshot(cycle, root, [rejectedTranslation, { ...rejectedTranslation }]),
    /issueNumbers must be unique/,
  );
  assert.throws(
    () => createProductSnapshot(cycle, root, [{ ...rejectedTranslation, reason: "x".repeat(PRODUCT_EVALUATION_BUDGET.maxStatementBytes + 1) }]),
    /reason exceeds maxStatementBytes/,
  );
  assert.throws(
    () => createProductSnapshot(cycle, root, [{ ...rejectedTranslation, title: `${SELF_IMPROVEMENT_TITLE_PREFIX}   ` }]),
    /title must be non-empty/,
  );
});

test("prompt는 기각된 후보를 다시 제안하지 말라고 명시한다", () => {
  const empty = createProductEvaluationPrompt(createProductSnapshot(cycle, appFixture()));
  assert.match(empty, /# 이미 기각된 후보 \(다시 제안 금지\)\n없음/);

  const prompt = createProductEvaluationPrompt(createProductSnapshot(cycle, appFixture(), [rejectedTranslation]));
  assert.match(prompt, /다른 표현, 부분 적용, 우회 방식으로 다시 제안하지 마십시오/);
  assert.match(prompt, /- #11 추천 문단에 한국어 번역을 함께 제공하기 — 기각 사유: public domain 원문만/);
});

test("기각된 후보와 같은 제목은 닫힌 Issue여도 결정적으로 다시 만들지 않는다", () => {
  const snapshot = createProductSnapshot(cycle, appFixture(), [rejectedTranslation]);
  const report = reportWith(snapshot, [{ ...diversityCandidate, title: "추천 문단에 한국어 번역을 함께 제공하기" }]);
  const decision = decideImprovementIssue(report, [
    { number: 11, title: rejectedTranslation.title, state: "closed" },
  ]);
  assert.equal(decision.action, "skip");
  assert.match(decision.action === "skip" ? decision.reason : "", /같은 제목의 Issue가 이미 있습니다: #11/);
});
