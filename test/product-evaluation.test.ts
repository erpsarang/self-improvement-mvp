import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  createProductDiscoverySubscriptionIdentity,
  createProductEvaluationOutputSchema,
  createProductEvaluationPrompt,
  createProductEvaluationReport,
  createProductSnapshot,
  decideImprovementIssue,
  isFrameworkOwnedPath,
  NO_CANDIDATE,
  PRODUCT_EVALUATION_BUDGET,
  productEvaluationReportArtifactName,
  renderDiscoveryResultComment,
  SELF_IMPROVEMENT_TITLE_PREFIX,
  verifyProductEvaluationReport,
  verifyProductSnapshot,
  type ExistingIssue,
  type ProductDiscoveryTarget,
  type ProductEvaluationReport,
  type ProductSnapshot,
  type RejectedCandidate,
  AUTO_DISCOVERY_MIN_INTERVAL_HOURS,
  AUTO_DISCOVERY_MIN_MERGES,
  decideAutoDiscovery,
} from "../src/self-improvement/product-evaluation.js";

const target: ProductDiscoveryTarget = {
  repository: "erpsarang/classic-paragraph-wit",
  discoveryIssueNumber: 40,
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

  // Framework distribution, 테스트, 생성 파일은 제품 평가 대상이 아니다.
  write(root, ".github/workflows/plan.yml", "name: Read-only AI PLAN\n");
  write(root, "src/self-improvement/planner.ts", "export const planner = 1;\n");
  write(root, "policy/framework-distribution-ownership.v1.json", "{}\n");
  write(root, "FRAMEWORK.md", "- Framework source SHA: `" + "a".repeat(40) + "`\n");
  write(root, ".framework-runtime/package.json", "{}\n");
  write(root, "package-lock.json", "{ \"lockfileVersion\": 3 }\n");
  write(root, "test/app.test.js", "import test from \"node:test\";\n");
  write(root, "src/web.test.js", "import test from \"node:test\";\n");

  for (const [path, content] of Object.entries(extra)) write(root, path, content);
  return root;
}

function snapshotPaths(snapshot: ProductSnapshot): string[] {
  return snapshot.files.map(({ path }) => path);
}

const evaluatorIdentity = {
  sourceRun: { runId: 36121809205, runAttempt: 1 },
  snapshotArtifact: {
    name: "product-discovery-request-90eaf07d1b0e4a2c2f3f6a5b8c7d9e0f1a2b3c4d-36121809205-attempt-1",
    id: 10675837390,
    digest: `sha256:${"b".repeat(64)}`,
  },
  evaluator: {
    provider: "claude-max-subscription",
    action: "erpsarang/subscription-ai-executor/product-evaluation-poller.yml",
    model: "opus",
    reasoningEffort: "medium",
  },
} as const;

const comparisons = [
  {
    id: "c1",
    area: "추천 작품 목록",
    summary: "추천 가능한 고전이 두 편뿐이라 다시 눌러도 같은 작품이 번갈아 나온다.",
    userImpact: "high",
    usageFrequency: "high",
    visionFit: "high",
    defect: false,
    recentlyChanged: false,
    evidencePaths: ["src/classics.js"],
  },
  {
    id: "c2",
    area: "첫 화면 안내",
    summary: "첫 화면에 무엇을 누르면 되는지 안내가 없다.",
    userImpact: "medium",
    usageFrequency: "high",
    visionFit: "medium",
    defect: false,
    recentlyChanged: true,
    evidencePaths: ["index.html"],
  },
  {
    id: "c3",
    area: "배포 안내 문서",
    summary: "GitHub Pages 안내가 짧다.",
    userImpact: "low",
    usageFrequency: "low",
    visionFit: "low",
    defect: false,
    recentlyChanged: false,
    evidencePaths: ["docs/github-pages.md"],
  },
] as const;

const notSelectedForC1 = [
  { id: "c2", reason: "최근 변경된 화면 영역이고 결함이 아니라 순위를 낮췄습니다." },
  { id: "c3", reason: "사용자가 거의 보지 않는 문서라 영향이 작습니다." },
] as const;

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

function rawDiscovery(snapshot: ProductSnapshot, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    kind: "untrusted-product-discovery",
    sourceSnapshotDigest: snapshot.snapshotDigest,
    comparisons,
    selectedId: "c1",
    notSelected: notSelectedForC1,
    candidates: [diversityCandidate],
    ...overrides,
  };
}

const noneSelection = {
  selectedId: NO_CANDIDATE,
  notSelected: [
    { id: "c1", reason: "작품 수는 README가 말하는 한 문단 추천에 충분합니다." },
    { id: "c2", reason: "최근 바뀐 화면입니다." },
    { id: "c3", reason: "영향이 작습니다." },
  ],
  candidates: [],
};

function reportWith(snapshot: ProductSnapshot, overrides: Record<string, unknown> = {}): ProductEvaluationReport {
  return createProductEvaluationReport(snapshot, rawDiscovery(snapshot, overrides), evaluatorIdentity);
}

test("snapshot은 테스트를 뺀 제품 source 전체와 README를 담고 Framework distribution을 제외한다", () => {
  const snapshot = createProductSnapshot(target, appFixture());
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
  assert.equal(snapshot.repository, target.repository);
  // 평가 대상은 특정 PR이 아니라 실행 시점의 기본 브랜치 SHA다.
  assert.deepEqual(snapshot.discovery, { issueNumber: 40, deployedSha: target.deployedSha });
  assert.deepEqual(snapshot.budget, { maxTotalBytes: 131_072 });
  assert.equal(snapshot.fileCount, snapshot.files.length);
  assert.equal(snapshot.totalSnapshotBytes, snapshot.files.reduce((sum, file) => sum + file.byteLength, 0));
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

test("같은 배포 내용과 이력은 항상 같은 snapshot digest를 만들고 report 이름은 SHA와 run으로 정한다", () => {
  const first = createProductSnapshot(target, appFixture());
  const second = createProductSnapshot(target, appFixture());
  assert.equal(first.snapshotDigest, second.snapshotDigest);
  assert.equal(
    productEvaluationReportArtifactName(first, 42, 1),
    `product-evaluation-report-${target.deployedSha}-42-attempt-1`,
  );
});

test("snapshot 내용이 바뀌면 digest 검증이 fail-closed 한다", () => {
  const snapshot = createProductSnapshot(target, appFixture());
  const tampered = {
    ...snapshot,
    files: snapshot.files.map((file) =>
      file.path === "src/classics.js" ? { ...file, content: `${file.content}// 조작\n` } : file,
    ),
  };
  assert.throws(() => verifyProductSnapshot(tampered), /content digest mismatch/);
});

test("파일별 한도와 파일 수 한도 없이 큰 파일과 많은 파일을 전체 한도 안에서 통째로 담는다", () => {
  // 예전 파일별 한도(16,384B)와 파일 수 한도(24개)를 넘는 입력이다.
  const big = `export const web = 1;\n${"// 화면 로직\n".repeat(2_000)}`;
  assert.ok(Buffer.byteLength(big, "utf8") > 16_384);
  const extra: Record<string, string> = { "src/web-main.ts": big };
  for (let index = 0; index < 40; index += 1) {
    extra[`src/module-${String(index).padStart(2, "0")}.js`] = `export const module${index} = ${index};\n`;
  }
  const snapshot = createProductSnapshot(target, appFixture(extra));
  verifyProductSnapshot(snapshot);

  assert.ok(snapshot.fileCount > 24);
  assert.equal(snapshot.files.find((file) => file.path === "src/web-main.ts")?.content, big);
  assert.deepEqual(snapshot.omittedPaths, []);
});

test("전체 한도를 넘는 파일과 symlink만 빠지고, README가 먼저 담긴다", () => {
  const root = appFixture({
    "src/huge.js": `// ${"x".repeat(PRODUCT_EVALUATION_BUDGET.maxTotalBytes)}\n`,
    // 혼자서는 전체 한도 안이지만, 먼저 담긴 README·화면·src 뒤에는 남은 예산을 넘는다.
    "src/zz-large.js": `// ${"y".repeat(PRODUCT_EVALUATION_BUDGET.maxTotalBytes - 100)}\n`,
  });
  symlinkSync(join(root, "README.md"), join(root, "src/linked.md"));

  const snapshot = createProductSnapshot(target, root);
  verifyProductSnapshot(snapshot);
  assert.equal(snapshotPaths(snapshot).includes("README.md"), true);
  assert.equal(snapshotPaths(snapshot).includes("src/linked.md"), false);
  // README, 화면, src를 먼저 담고 남은 예산을 넘는 파일만 빠진다. 뒤의 작은 파일은 계속 담긴다.
  assert.deepEqual(snapshot.omittedPaths, ["src/huge.js", "src/zz-large.js"]);
  assert.equal(snapshotPaths(snapshot).includes("docs/github-pages.md"), true);
  assert.ok(snapshot.totalSnapshotBytes <= PRODUCT_EVALUATION_BUDGET.maxTotalBytes);
});

const rejectedTranslation: RejectedCandidate = {
  issueNumber: 11,
  title: `${SELF_IMPROVEMENT_TITLE_PREFIX} 추천 문단에 한국어 번역을 함께 제공하기`,
  reason: "public domain 원문만 싣고 번역은 사용하지 않는다는 제품 방침을 유지한다.",
};

test("최근 이력(완료한 요구, 기각된 후보, 최근 변경 경로)은 canonical하게 담기고 digest에 반영된다", () => {
  const root = appFixture();
  const plain = createProductSnapshot(target, root);
  const withHistory = createProductSnapshot(target, root, {
    completedRequirements: [
      { issueNumber: 6, title: "[업무 요구] 고전의 위트를 바꾸고 싶다" },
      { issueNumber: 30, title: "  공유 버튼 추가  " },
    ],
    rejectedCandidates: [{ issueNumber: 4, title: "  오래된 기각 후보 ", reason: "" }, rejectedTranslation],
    recentChangedPaths: [
      "src/web.js",
      ".github/workflows/plan.yml",
      "test/app.test.js",
      "src/self-improvement/planner.ts",
      "index.html",
      "src/web.js",
      "../escape.js",
    ],
  });
  verifyProductSnapshot(withHistory);

  assert.deepEqual(plain.history, { completedRequirements: [], rejectedCandidates: [], recentChangedPaths: [] });
  assert.notEqual(plain.snapshotDigest, withHistory.snapshotDigest);
  assert.deepEqual(withHistory.history, {
    completedRequirements: [
      { issueNumber: 30, title: "공유 버튼 추가" },
      { issueNumber: 6, title: "[업무 요구] 고전의 위트를 바꾸고 싶다" },
    ],
    // 최신 Issue가 먼저 오고 접두사와 공백은 정리된다.
    rejectedCandidates: [
      { issueNumber: 11, title: "추천 문단에 한국어 번역을 함께 제공하기", reason: rejectedTranslation.reason },
      { issueNumber: 4, title: "오래된 기각 후보", reason: "" },
    ],
    // Framework, 테스트, 이상한 경로는 버리고 제품 경로만 남긴다.
    recentChangedPaths: ["index.html", "src/web.js"],
  });
});

test("이력이 조작되면 snapshot 검증이 fail-closed 한다", () => {
  const snapshot = createProductSnapshot(target, appFixture(), { rejectedCandidates: [rejectedTranslation] });
  const tampered = {
    ...snapshot,
    history: { ...snapshot.history, rejectedCandidates: [{ ...snapshot.history.rejectedCandidates[0]!, reason: "조작" }] },
  };
  assert.throws(() => verifyProductSnapshot(tampered), /digest mismatch|not canonical/);
});

test("이력 입력은 예산과 모양을 결정적으로 강제한다", () => {
  const root = appFixture();
  assert.throws(
    () => createProductSnapshot(target, root, {
      rejectedCandidates: Array.from({ length: PRODUCT_EVALUATION_BUDGET.maxRejectedCandidates + 1 }, (_, index) => ({
        issueNumber: index + 1, title: `후보 ${index}`, reason: "",
      })),
    }),
    /exceeds maxRejectedCandidates/,
  );
  assert.throws(
    () => createProductSnapshot(target, root, {
      completedRequirements: Array.from({ length: PRODUCT_EVALUATION_BUDGET.maxCompletedRequirements + 1 }, (_, index) => ({
        issueNumber: index + 1, title: `요구 ${index}`,
      })),
    }),
    /exceeds maxCompletedRequirements/,
  );
  assert.throws(
    () => createProductSnapshot(target, root, { rejectedCandidates: [rejectedTranslation, { ...rejectedTranslation }] }),
    /issueNumbers must be unique/,
  );
  assert.throws(
    () => createProductSnapshot(target, root, { rejectedCandidates: [{ ...rejectedTranslation, reason: "x".repeat(PRODUCT_EVALUATION_BUDGET.maxStatementBytes + 1) }] }),
    /reason exceeds maxStatementBytes/,
  );
  assert.throws(
    () => createProductSnapshot(target, root, { rejectedCandidates: [{ ...rejectedTranslation, title: `${SELF_IMPROVEMENT_TITLE_PREFIX}   ` }] }),
    /title must be non-empty/,
  );
  assert.throws(
    () => createProductSnapshot(target, root, { completedRequirements: [{ issueNumber: 1, title: "x".repeat(PRODUCT_EVALUATION_BUDGET.maxTitleBytes + 1) }] }),
    /exceeds maxTitleBytes/,
  );
  assert.throws(() => createProductSnapshot(target, root, { recentChangedPaths: [42] }), /must contain strings/);

  const many = Array.from({ length: 100 }, (_, index) => `src/file-${String(index).padStart(3, "0")}.js`);
  const snapshot = createProductSnapshot(target, root, { recentChangedPaths: many });
  // 최근(앞)부터 예산만큼만 담는다.
  assert.deepEqual(snapshot.history.recentChangedPaths, many.slice(0, PRODUCT_EVALUATION_BUDGET.maxRecentChangedPaths));
});

test("prompt는 후보 3개 비교, 1위 1개, 고르지 않은 이유, 최근 변경 영역 순위 낮춤과 NONE을 지시한다", () => {
  const snapshot = createProductSnapshot(target, appFixture(), {
    completedRequirements: [{ issueNumber: 30, title: "공유 버튼 추가" }],
    rejectedCandidates: [rejectedTranslation],
    recentChangedPaths: ["src/web.js"],
  });
  const prompt = createProductEvaluationPrompt(snapshot);
  assert.match(prompt, /read-only AI Product Discovery/);
  assert.match(prompt, /서로 다른 제품 영역.*후보 3개/);
  assert.match(prompt, /사용자 영향\(userImpact\), 사용 빈도\(usageFrequency\), README가 말하는 제품 비전/);
  assert.match(prompt, /recentlyChanged를 true로 적고 순위를 낮춥니다\. 단, 사용자가 겪는 결함\(defect: true\)은 예외입니다/);
  assert.match(prompt, /1위 1개만 selectedId로 고르고/);
  assert.match(prompt, /고르지 않은 2개는 notSelected에 이유를 적습니다/);
  assert.match(prompt, /selectedId를 NONE으로 하고 candidates는 빈 배열/);
  assert.match(prompt, /개발 프로세스, CI, 테스트 전략, workflow, 리뷰 방식, 배포 자동화는 평가 대상이 아닙니다/);
  assert.match(prompt, /# 완료한 요구 \(다시 제안 금지\)\n- #30 공유 버튼 추가/);
  assert.match(prompt, /- #11 추천 문단에 한국어 번역을 함께 제공하기 — 기각 사유: public domain 원문만/);
  assert.match(prompt, /# 최근 변경 경로 \(이 영역의 후보는 결함이 아니면 순위를 낮춤\)\n- src\/web\.js/);
  assert.match(prompt, new RegExp(snapshot.snapshotDigest));
  assert.doesNotMatch(prompt, /self-improvement\/planner\.ts/);

  const empty = createProductEvaluationPrompt(createProductSnapshot(target, appFixture()));
  assert.match(empty, /# 완료한 요구 \(다시 제안 금지\)\n없음/);
  assert.match(empty, /# 이미 기각된 후보 \(다시 제안 금지\)\n없음/);
});

test("output schema는 exact snapshot에 결합되고 후보 3개 비교와 최대 1개 제안을 요구한다", () => {
  const snapshot = createProductSnapshot(target, appFixture());
  const schema = createProductEvaluationOutputSchema(snapshot) as {
    required: string[];
    properties: Record<string, Record<string, unknown>> & {
      comparisons: { minItems: number; maxItems: number; items: { properties: Record<string, unknown> } };
      candidates: { maxItems: number; items: { properties: { evidencePaths: Record<string, unknown> } } };
    };
  };
  assert.deepEqual(schema.properties.sourceSnapshotDigest, { type: "string", const: snapshot.snapshotDigest });
  assert.deepEqual(schema.properties.schemaVersion, { type: "integer", const: 2 });
  assert.equal(schema.properties.comparisons.minItems, 3);
  assert.equal(schema.properties.comparisons.maxItems, 3);
  assert.deepEqual(schema.properties.comparisons.items.properties.id, { type: "string", enum: ["c1", "c2", "c3"] });
  assert.deepEqual(schema.properties.selectedId, { type: "string", enum: ["c1", "c2", "c3", "NONE"] });
  assert.equal(schema.properties.candidates.maxItems, 1);
  assert.deepEqual(schema.properties.candidates.items.properties.evidencePaths, {
    type: "array",
    minItems: 1,
    items: { type: "string", enum: snapshotPaths(snapshot) },
  });
  // Private executor validator가 지원하는 keyword만 쓴다.
  const allowed = new Set([
    "type", "additionalProperties", "required", "properties", "items", "minItems", "maxItems",
    "minLength", "maxLength", "pattern", "enum", "const", "anyOf", "description", "$schema",
  ]);
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (typeof node !== "object" || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "properties") {
        Object.values(value as object).forEach(visit);
        continue;
      }
      assert.ok(allowed.has(key), `unsupported schema keyword: ${key}`);
      visit(value);
    }
  };
  visit(schema);
});

test("trusted finalize는 후보 3개 비교와 선택이 서로 맞을 때만 받는다", () => {
  const snapshot = createProductSnapshot(target, appFixture());
  assert.throws(() => reportWith(snapshot, { comparisons: comparisons.slice(0, 2) }), /exactly 3 candidates/);
  assert.throws(
    () => reportWith(snapshot, { comparisons: [comparisons[0], comparisons[1], { ...comparisons[2], id: "c2" }] }),
    /comparison ids must be unique/,
  );
  assert.throws(
    () => reportWith(snapshot, { comparisons: [comparisons[0], { ...comparisons[1], area: "  추천   작품 목록 " }, comparisons[2]] }),
    /different areas/,
  );
  assert.throws(() => reportWith(snapshot, { selectedId: "c4" }), /selectedId is invalid/);
  // 고르지 않은 후보 전부에 이유가 있어야 한다.
  assert.throws(() => reportWith(snapshot, { notSelected: [notSelectedForC1[0]] }), /every candidate that was not selected/);
  assert.throws(
    () => reportWith(snapshot, { notSelected: [{ id: "c1", reason: "x" }, notSelectedForC1[1]] }),
    /every candidate that was not selected/,
  );
  assert.throws(() => reportWith(snapshot, { candidates: [] }), /exactly one proposal/);
  assert.throws(
    () => reportWith(snapshot, { candidates: [diversityCandidate, { ...diversityCandidate, title: "두 번째 후보" }] }),
    /at most one candidate per run/,
  );
  assert.throws(() => reportWith(snapshot, { ...noneSelection, candidates: [diversityCandidate] }), /NONE selection must not carry a candidate/);
  assert.throws(
    () => reportWith(snapshot, { comparisons: [{ ...comparisons[0], userImpact: "very-high" }, comparisons[1], comparisons[2]] }),
    /userImpact is unsupported/,
  );
  assert.throws(
    () => reportWith(snapshot, { comparisons: [{ ...comparisons[0], defect: "no" }, comparisons[1], comparisons[2]] }),
    /defect must be a boolean/,
  );
  assert.throws(() => reportWith(snapshot, { schemaVersion: 1 }), /unsupported product discovery schema/);
});

test("trusted finalize는 Framework 경로를 개선 범위로 삼는 후보를 거부한다", () => {
  const snapshot = createProductSnapshot(target, appFixture());
  for (const scopePath of [
    ".github/workflows/learn.yml",
    "src/self-improvement/learn-report.ts",
    "policy/framework-distribution-ownership.v1.json",
    "FRAMEWORK.md",
  ]) {
    assert.throws(
      () => reportWith(snapshot, { candidates: [{ ...diversityCandidate, scopePaths: [scopePath] }] }),
      /must not target Framework-owned paths/,
      scopePath,
    );
  }
});

test("trusted finalize는 snapshot 밖의 근거와 탈출 경로를 거부한다", () => {
  const snapshot = createProductSnapshot(target, appFixture());
  assert.throws(
    () => reportWith(snapshot, { candidates: [{ ...diversityCandidate, evidencePaths: ["src/self-improvement/planner.ts"] }] }),
    /references a path outside the product snapshot/,
  );
  assert.throws(
    () => reportWith(snapshot, { comparisons: [{ ...comparisons[0], evidencePaths: ["test/app.test.js"] }, comparisons[1], comparisons[2]] }),
    /references a path outside the product snapshot/,
  );
  assert.throws(
    () => reportWith(snapshot, { candidates: [{ ...diversityCandidate, scopePaths: ["../other-repo/src/app.js"] }] }),
    /unsafe path segment/,
  );
});

test("trusted finalize는 폴더 표기(끝의 /)를 받아들이되 안전하지 않은 경로는 계속 거부한다", () => {
  const snapshot = createProductSnapshot(target, appFixture());
  const report = reportWith(snapshot, {
    candidates: [{ ...diversityCandidate, scopePaths: ["src/classics.js", "test/"] }],
  });
  assert.deepEqual(report.candidate?.scopePaths, ["src/classics.js", "test/"]);
  for (const scopePath of ["test//", "/", "//", "../test/", "./test/", "/test/", "test\\"]) {
    assert.throws(
      () => reportWith(snapshot, { candidates: [{ ...diversityCandidate, scopePaths: [scopePath] }] }),
      /unsafe path segment|repository-relative path/,
      scopePath,
    );
  }
  for (const scopePath of [".github/", "src/self-improvement/", "policy/"]) {
    assert.throws(
      () => reportWith(snapshot, { candidates: [{ ...diversityCandidate, scopePaths: [scopePath] }] }),
      /must not target Framework-owned paths/,
      scopePath,
    );
  }
});

test("trusted finalize는 스스로 태그를 붙인 제목과 알 수 없는 필드를 거부한다", () => {
  const snapshot = createProductSnapshot(target, appFixture());
  assert.throws(
    () => reportWith(snapshot, { candidates: [{ ...diversityCandidate, title: "[업무 요구] 고전을 더 넣자" }] }),
    /must not carry its own bracket tag/,
  );
  assert.throws(
    () => reportWith(snapshot, { candidates: [{ ...diversityCandidate, priority: 1 }] }),
    /contains unsupported fields: priority/,
  );
  assert.throws(() => reportWith(snapshot, { observations: [] }), /contains unsupported fields: observations/);
});

test("검증된 report는 canonical 모양과 digest로 다시 검증된다", () => {
  const snapshot = createProductSnapshot(target, appFixture());
  // AI가 순서를 섞어 내도 canonical 순서로 고정된다.
  const report = reportWith(snapshot, {
    comparisons: [comparisons[2], comparisons[0], comparisons[1]],
    notSelected: [notSelectedForC1[1], notSelectedForC1[0]],
  });
  verifyProductEvaluationReport(report, snapshot);

  assert.equal(report.kind, "untrusted-product-evaluation-report");
  assert.deepEqual(report.comparisons.map(({ id }) => id), ["c1", "c2", "c3"]);
  assert.deepEqual(report.selection, { selectedId: "c1", notSelected: notSelectedForC1 });
  assert.equal(report.candidate?.title, diversityCandidate.title);
  assert.deepEqual(report.discovery, snapshot.discovery);

  const tampered = {
    ...report,
    selection: { ...report.selection, selectedId: "c2" },
  };
  assert.throws(() => verifyProductEvaluationReport(tampered, snapshot), /canonical shape mismatch|every candidate/);
  const retitled = { ...report, candidate: report.candidate === null ? null : { ...report.candidate, title: "조작된 제목" } };
  assert.throws(() => verifyProductEvaluationReport(retitled, snapshot), /digest or canonical shape mismatch/);
});

test("셋 다 가치가 낮아 NONE이면 Issue를 만들지 않고 결과 comment에 세 이유를 남긴다", () => {
  const snapshot = createProductSnapshot(target, appFixture());
  const report = reportWith(snapshot, noneSelection);
  verifyProductEvaluationReport(report, snapshot);
  assert.equal(report.candidate, null);

  const decision = decideImprovementIssue(report, []);
  assert.equal(decision.action, "skip");
  assert.match(decision.action === "skip" ? decision.reason : "", /3개 모두 가치가 낮아 NONE/);

  const comment = renderDiscoveryResultComment(report, decision);
  assert.match(comment, /^<!-- ai-dev-framework:PRODUCT_DISCOVERY_RESULT run=36121809205 run-attempt=1 snapshot=[0-9a-f]{64} -->/);
  assert.match(comment, /1위 없음\(NONE\)/);
  for (const { id } of noneSelection.notSelected) assert.match(comment, new RegExp(`^- ${id} \\(`, "m"));
  assert.match(comment, /Improvement Candidate Issue를 만들지 않았습니다: 비교한 후보 3개 모두/);
});

test("열린 Improvement Candidate Issue가 있으면 새 후보를 쌓지 않는다", () => {
  const snapshot = createProductSnapshot(target, appFixture());
  const report = reportWith(snapshot);
  const existing: ExistingIssue[] = [
    { number: 9, title: `${SELF_IMPROVEMENT_TITLE_PREFIX} 전혀 다른 개선`, state: "open" },
    // Discovery 기록 Issue는 Improvement Candidate가 아니다.
    { number: 40, title: "[Product Discovery] 실행 기록", state: "open" },
  ];
  const decision = decideImprovementIssue(report, existing);
  assert.equal(decision.action, "skip");
  assert.match(decision.action === "skip" ? decision.reason : "", /이미 열린 Improvement Candidate Issue가 있습니다: #9/);
});

test("같은 제목이 닫힌 Issue로 이미 있으면 중복 생성하지 않는다", () => {
  const snapshot = createProductSnapshot(target, appFixture(), { rejectedCandidates: [rejectedTranslation] });
  const report = reportWith(snapshot);
  const decision = decideImprovementIssue(report, [
    { number: 11, title: `${SELF_IMPROVEMENT_TITLE_PREFIX}   추천 가능한 고전 작품 수를   늘린다 `, state: "closed" },
  ]);
  assert.equal(decision.action, "skip");
  assert.match(decision.action === "skip" ? decision.reason : "", /같은 제목의 Issue가 이미 있습니다: #11/);
});

test("중복이 없으면 업무 요구 서식, 후보 비교, Discovery provenance를 갖춘 Issue를 만든다", () => {
  const snapshot = createProductSnapshot(target, appFixture());
  const report = reportWith(snapshot);
  const existing: ExistingIssue[] = [
    { number: 6, title: "[업무 요구] 고전의 위트를 바꾸고 싶다", state: "closed" },
    { number: 40, title: "[Product Discovery] 실행 기록", state: "open" },
  ];
  const decision = decideImprovementIssue(report, existing);
  assert.equal(decision.action, "create");
  if (decision.action !== "create") return;

  assert.equal(decision.title, `${SELF_IMPROVEMENT_TITLE_PREFIX} 추천 가능한 고전 작품 수를 늘린다`);
  // 자동 생성 Issue는 [업무 요구] 접두사를 쓰지 않으므로 PLAN이 issues 이벤트로 시작되지 않는다.
  assert.equal(decision.title.startsWith("[업무 요구]"), false);
  for (const heading of [
    "## 어떤 업무가 불편한가요?",
    "## 어떻게 바뀌면 좋겠나요?",
    "## 잘 되었다고 판단할 수 있는 예",
    "## 지켜야 할 사항",
    "## 예상 변경 범위",
    "## 근거로 읽은 제품 파일",
    "## 비교한 후보",
    "## 고르지 않은 후보와 이유",
  ]) {
    assert.equal(decision.body.includes(heading), true, heading);
  }
  assert.match(
    decision.body,
    new RegExp(`^<!-- ai-dev-framework:PRODUCT_IMPROVEMENT discovery-issue=40 discovery-run=36121809205 snapshot=${snapshot.snapshotDigest} -->`),
  );
  assert.match(decision.body, /\| \*\*c1 \(1위\)\*\* \| 추천 작품 목록 \|/);
  assert.match(decision.body, /- c2 \(첫 화면 안내\): 최근 변경된 화면 영역이고/);
  assert.match(decision.body, /### HumanStatus: IMPROVEMENT_CANDIDATE/);
  assert.match(decision.body, /PLAN-승인 이후에만 구현이 시작됩니다/);
  assert.match(decision.body, /최종 Merge는 Human-only입니다/);
  assert.match(decision.body, new RegExp(`Product Evaluation report SHA-256: \`${report.reportDigest}\``));
  assert.match(decision.body, new RegExp(`평가한 배포 SHA: \`${target.deployedSha}\``));
  assert.match(decision.body, /claude-max-subscription \/ .* \/ opus \/ effort medium/);

  const comment = renderDiscoveryResultComment(report, decision);
  assert.match(comment, /- 1위: c1 \(추천 작품 목록\) — 추천 가능한 고전 작품 수를 늘린다/);
  assert.match(comment, /Improvement Candidate Issue를 만듭니다: \[Self-Improvement\] 추천 가능한 고전 작품 수를 늘린다/);
});

test("AI 문장의 줄바꿈과 | 문자는 비교 표를 깨지 않는다", () => {
  const snapshot = createProductSnapshot(target, appFixture());
  const report = reportWith(snapshot, {
    comparisons: [{ ...comparisons[0], summary: "첫 줄 | 표 문자\n둘째 줄" }, comparisons[1], comparisons[2]],
  });
  const decision = decideImprovementIssue(report, []);
  assert.equal(decision.action, "create");
  if (decision.action !== "create") return;
  assert.match(decision.body, /첫 줄 \\\| 표 문자 둘째 줄/);
});

test("Discovery subscription identity는 exact snapshot, 배포 SHA, Discovery Issue, 이 run과 opus에 묶인다", () => {
  const snapshot = createProductSnapshot(target, appFixture());
  // Private product_evaluation_bridge의 trusted-product-discovery-request 계약과 field가 정확히 같다.
  assert.deepEqual(createProductDiscoverySubscriptionIdentity(snapshot, { runId: 901, runAttempt: 1 }), {
    schemaVersion: 1,
    kind: "trusted-product-discovery-request",
    repository: "erpsarang/classic-paragraph-wit",
    issueNumber: 40,
    baseSha: target.deployedSha,
    snapshotDigest: snapshot.snapshotDigest,
    worker: { runId: 901, runAttempt: 1 },
    model: "opus",
  });
  assert.throws(() => createProductDiscoverySubscriptionIdentity(snapshot, { runId: 0, runAttempt: 1 }), /worker\.runId/);
  // 위변조된 snapshot으로는 요청을 만들지 않는다.
  assert.throws(() => createProductDiscoverySubscriptionIdentity({ ...snapshot, fileCount: snapshot.fileCount + 1 }, { runId: 901, runAttempt: 1 }));
});

const gateBase = {
  enabled: true,
  mergedSinceLast: 3,
  openCandidateCount: 0,
  lastDiscoveryAt: "2026-10-09T00:00:00.000Z",
  now: "2026-10-10T09:00:00.000Z",
  runInFlight: false,
} as const;

test("자동 Discovery는 조건을 모두 만족할 때만 시작한다 (#383)", () => {
  assert.deepEqual(decideAutoDiscovery(gateBase), { action: "dispatch" });
  // 한 번도 돌지 않은 저장소도 Merge가 충분히 쌓였으면 시작한다.
  assert.deepEqual(decideAutoDiscovery({ ...gateBase, lastDiscoveryAt: null }), { action: "dispatch" });
  assert.equal(AUTO_DISCOVERY_MIN_MERGES, 3);
  assert.equal(AUTO_DISCOVERY_MIN_INTERVAL_HOURS, 24);
});

test("자동 Discovery는 꺼져 있거나 비용 상한에 걸리면 이유와 함께 시작하지 않는다 (#383)", () => {
  const skipReason = (overrides: Record<string, unknown>): string => {
    const decision = decideAutoDiscovery({ ...gateBase, ...overrides } as never);
    assert.equal(decision.action, "skip");
    return decision.action === "skip" ? decision.reason : "";
  };
  assert.match(skipReason({ enabled: false }), /AUTO_PRODUCT_DISCOVERY/);
  assert.match(skipReason({ runInFlight: true }), /이미 실행 중/);
  assert.match(skipReason({ openCandidateCount: 1 }), /\[Self-Improvement\] Issue가 열려/);
  assert.match(skipReason({ mergedSinceLast: 2 }), /Human Merge가 2건/);
  assert.match(skipReason({ mergedSinceLast: 0, lastDiscoveryAt: null }), /Human Merge가 0건/);
  // 24시간이 되기 직전에는 시작하지 않고, 정확히 24시간이 지나면 시작한다.
  assert.match(skipReason({ lastDiscoveryAt: "2026-10-09T09:00:00.001Z" }), /24시간/);
  assert.deepEqual(decideAutoDiscovery({ ...gateBase, lastDiscoveryAt: "2026-10-09T09:00:00.000Z" }), { action: "dispatch" });
  // 시계가 어긋나 마지막 시작이 미래로 보여도 시작하지 않는다.
  assert.match(skipReason({ lastDiscoveryAt: "2026-10-11T00:00:00.000Z" }), /24시간/);
});

test("자동 Discovery 판단은 잘못된 입력을 조용히 넘기지 않고 거부한다 (#383)", () => {
  for (const overrides of [
    { mergedSinceLast: -1 },
    { mergedSinceLast: 1.5 },
    { openCandidateCount: "0" },
    { now: "어제" },
    { lastDiscoveryAt: "not-a-date" },
    { enabled: "on" },
    { runInFlight: undefined },
  ]) {
    assert.throws(() => decideAutoDiscovery({ ...gateBase, ...overrides } as never), /auto discovery/, JSON.stringify(overrides));
  }
});
