import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

/**
 * Product Discovery는 사람이 실행할 때만 지금 배포된 App을 제품 관점에서 한 번 살펴보고,
 * 서로 다른 영역의 후보 3개를 비교해 1위가 충분히 가치 있을 때만 Improvement Candidate Issue를 만든다.
 *
 * LEARN이 "개발 cycle이 어떻게 흘렀는가"를 본다면 이 stage는 "배포된 제품이 사용자에게
 * 충분한가"를 본다. 두 stage는 입력도 산출물도 공유하지 않는다.
 *
 * 경계:
 * - 한 실행당 Improvement Candidate 최대 1개 (trusted 검증이 구조적으로 제한한다)
 * - 기존 Issue와 중복이면 생성 금지 (trusted control-plane이 결정적으로 판단한다)
 * - Framework 자체 개선 후보는 생성 금지 (snapshot에 Framework 파일이 없고 scope도 거부한다)
 * - 생성한 Issue는 proposal이다. read-only PLAN은 자동으로 한 번 제안되지만 구현은 사람의 PLAN-승인 이후에만 시작된다
 */

export const SELF_IMPROVEMENT_TITLE_PREFIX = "[Self-Improvement]";

export const PRODUCT_EVALUATION_BUDGET = Object.freeze({
  // 파일별 한도와 파일 수 한도는 없다. 제품 source 전체를 이 전체 한도 안에서 담는다.
  maxTotalBytes: 131_072,
  maxStatementBytes: 1_024,
  maxScopePaths: 8,
  maxTitleBytes: 160,
  maxReportBytes: 32_768,
  maxRejectedCandidates: 16,
  maxCompletedRequirements: 16,
  maxRecentChangedPaths: 64,
});

/** 비교할 후보 수와 id. AI는 서로 다른 영역의 후보를 정확히 이만큼 비교한다. */
const COMPARISON_IDS: readonly string[] = ["c1", "c2", "c3"];
/** 세 후보 모두 가치가 낮을 때의 선택 값. */
export const NO_CANDIDATE = "NONE";

/** Framework distribution이 소유하는 경로. 제품 평가 대상도, 개선 범위도 될 수 없다. */
const FRAMEWORK_OWNED_PREFIXES = Object.freeze([
  ".framework-runtime/",
  ".github/",
  "policy/",
  "src/self-improvement/",
  "test/self-improvement/",
]);

const FRAMEWORK_OWNED_FILES = Object.freeze(["FRAMEWORK.md"]);

const PRODUCT_TEXT_EXTENSIONS = Object.freeze([
  ".css",
  ".htm",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".svg",
  ".ts",
  ".tsx",
  ".txt",
]);

/** 내용이 제품 가치를 설명하지 않는 생성 파일. */
const GENERATED_FILES = Object.freeze([
  "npm-shrinkwrap.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

const SHA256 = /^[0-9a-f]{64}$/;
const SHA256_WITH_PREFIX = /^sha256:([0-9a-f]{64})$/;
const GIT_SHA = /^[0-9a-f]{40,64}$/;
const CONFIDENCES: readonly string[] = ["high", "medium", "low"];
const LEVELS: readonly string[] = ["high", "medium", "low"];

const RAW_KEYS = new Set([
  "schemaVersion",
  "kind",
  "sourceSnapshotDigest",
  "comparisons",
  "selectedId",
  "notSelected",
  "candidates",
]);
const COMPARISON_KEYS = new Set([
  "id",
  "area",
  "summary",
  "userImpact",
  "usageFrequency",
  "visionFit",
  "defect",
  "recentlyChanged",
  "evidencePaths",
]);
const NOT_SELECTED_KEYS = new Set(["id", "reason"]);
const PROPOSAL_KEYS = new Set([
  "title",
  "problem",
  "desiredOutcome",
  "acceptanceExample",
  "constraint",
  "scopePaths",
  "evidencePaths",
  "confidence",
]);

export type ProductEvaluationConfidence = "high" | "medium" | "low";
export type ProductComparisonLevel = "high" | "medium" | "low";

/** Discovery 실행 대상. trusted workflow가 실행 시점에 고정한다. */
export interface ProductDiscoveryTarget {
  readonly repository: string;
  /** subscription 교환 comment와 Discovery 결과를 남기는 Discovery 전용 Issue. */
  readonly discoveryIssueNumber: number;
  /** 실행 시점의 App 기본 브랜치 SHA. snapshot 내용을 이 SHA에서 읽는다. */
  readonly deployedSha: string;
}

/** 사람이 not_planned로 닫은 Improvement Candidate. 같은 문제를 다른 표현으로 다시 제안하지 않게 한다. */
export interface RejectedCandidate {
  readonly issueNumber: number;
  readonly title: string;
  readonly reason: string;
}

/** 완료(completed)로 닫힌 요구. 이미 끝난 일을 다시 제안하지 않게 한다. */
export interface CompletedRequirement {
  readonly issueNumber: number;
  readonly title: string;
}

/** trusted workflow가 GitHub에서 읽어 오는 최근 이력. 모양과 예산은 여기서 결정적으로 고정한다. */
export interface ProductHistoryInput {
  readonly completedRequirements?: readonly CompletedRequirement[];
  readonly rejectedCandidates?: readonly RejectedCandidate[];
  /** 최근 머지된 PR들이 바꾼 경로. 제품 snapshot 대상이 아닌 경로는 버린다. */
  readonly recentChangedPaths?: readonly unknown[];
}

export interface ProductHistory {
  readonly completedRequirements: readonly CompletedRequirement[];
  readonly rejectedCandidates: readonly RejectedCandidate[];
  readonly recentChangedPaths: readonly string[];
}

export interface ProductSnapshotFile {
  readonly path: string;
  readonly byteLength: number;
  readonly digestAlgorithm: "sha256";
  readonly contentDigest: string;
  readonly content: string;
}

export interface ProductSnapshotPayload {
  readonly schemaVersion: 2;
  readonly kind: "trusted-product-snapshot";
  readonly repository: string;
  readonly discovery: {
    readonly issueNumber: number;
    readonly deployedSha: string;
  };
  readonly budget: {
    readonly maxTotalBytes: number;
  };
  readonly files: readonly ProductSnapshotFile[];
  readonly omittedPaths: readonly string[];
  readonly history: ProductHistory;
  readonly fileCount: number;
  readonly totalSnapshotBytes: number;
}

export interface ProductSnapshot extends ProductSnapshotPayload {
  readonly digestAlgorithm: "sha256";
  readonly snapshotDigest: string;
}

/** AI가 비교한 후보 하나. 1위만 아래 proposal로 구체화된다. */
export interface ProductComparison {
  readonly id: string;
  readonly area: string;
  readonly summary: string;
  readonly userImpact: ProductComparisonLevel;
  readonly usageFrequency: ProductComparisonLevel;
  readonly visionFit: ProductComparisonLevel;
  readonly defect: boolean;
  readonly recentlyChanged: boolean;
  readonly evidencePaths: readonly string[];
}

export interface ProductNotSelected {
  readonly id: string;
  readonly reason: string;
}

export interface ProductSelection {
  /** 1위 후보 id. 셋 다 가치가 낮으면 NONE이다. */
  readonly selectedId: string;
  /** 고르지 않은 후보 전부와 그 이유. */
  readonly notSelected: readonly ProductNotSelected[];
}

export interface ProductImprovementProposal {
  readonly title: string;
  readonly problem: string;
  readonly desiredOutcome: string;
  readonly acceptanceExample: string;
  readonly constraint: string;
  readonly scopePaths: readonly string[];
  readonly evidencePaths: readonly string[];
  readonly confidence: ProductEvaluationConfidence;
}

export interface ProductEvaluationFinalizeIdentity {
  readonly sourceRun: {
    readonly runId: number;
    readonly runAttempt: number;
  };
  readonly snapshotArtifact: {
    readonly name: string;
    readonly id: number;
    readonly digest: string;
  };
  readonly evaluator: {
    readonly provider: string;
    readonly action: string;
    readonly model: string;
    readonly reasoningEffort: string;
  };
}

export interface ProductEvaluationReportPayload {
  readonly schemaVersion: 2;
  readonly kind: "untrusted-product-evaluation-report";
  readonly repository: string;
  readonly source: {
    readonly snapshot: {
      readonly snapshotDigest: string;
      readonly artifact: {
        readonly name: string;
        readonly id: number;
        readonly digest: string;
      };
      readonly sourceRun: {
        readonly runId: number;
        readonly runAttempt: number;
      };
    };
  };
  readonly discovery: ProductSnapshotPayload["discovery"];
  readonly evaluator: ProductEvaluationFinalizeIdentity["evaluator"];
  readonly comparisons: readonly ProductComparison[];
  readonly selection: ProductSelection;
  readonly candidate: ProductImprovementProposal | null;
}

export interface ProductEvaluationReport extends ProductEvaluationReportPayload {
  readonly digestAlgorithm: "sha256";
  readonly reportDigest: string;
}

export interface ExistingIssue {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "closed";
}

export type ImprovementIssueDecision =
  | { readonly action: "skip"; readonly reason: string }
  | { readonly action: "create"; readonly title: string; readonly body: string };

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertPositiveInteger(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function assertNonempty(name: string, value: string): string {
  if (!value.trim()) throw new Error(`${name} must be non-empty`);
  return value;
}

function normalizeSha256(name: string, value: string): string {
  if (SHA256.test(value)) return value;
  const prefixed = SHA256_WITH_PREFIX.exec(value);
  if (prefixed?.[1]) return prefixed[1];
  throw new Error(`${name} must be a lowercase SHA-256 digest`);
}

function asObject(name: string, value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(name: string, object: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  const unknown = Object.keys(object).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${name} contains unsupported fields: ${unknown.join(", ")}`);
}

function boundedText(name: string, value: unknown): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  assertNonempty(name, value);
  if (Buffer.byteLength(value, "utf8") > PRODUCT_EVALUATION_BUDGET.maxStatementBytes) {
    throw new Error(`${name} exceeds maxStatementBytes`);
  }
  return value;
}

/** 한 줄 짜리 짧은 이름(제목, 영역). */
function boundedLine(name: string, value: unknown): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const line = assertNonempty(name, value).trim();
  if (Buffer.byteLength(line, "utf8") > PRODUCT_EVALUATION_BUDGET.maxTitleBytes) {
    throw new Error(`${name} exceeds maxTitleBytes`);
  }
  if (/[\r\n]/.test(line)) throw new Error(`${name} must be a single line`);
  return line;
}

/** Framework distribution이 소유하는 경로인지 판단한다. 제품 평가와 개선 범위에서 모두 제외된다. */
export function isFrameworkOwnedPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  if (FRAMEWORK_OWNED_FILES.includes(normalized)) return true;
  return FRAMEWORK_OWNED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function isTestLike(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.startsWith("test/") || lower.startsWith("tests/") || /\.(test|spec)\.[^/]+$/.test(lower);
}

function hasProductTextExtension(path: string): boolean {
  const lower = path.toLowerCase();
  return PRODUCT_TEXT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** 제품 snapshot에 담을 수 있는 경로인지 판단한다. Framework, 테스트, 생성 파일은 제외한다. */
function isProductSnapshotPath(path: string): boolean {
  if (isFrameworkOwnedPath(path) || isTestLike(path)) return false;
  const segments = path.split("/");
  if (segments.some((segment) => segment.startsWith(".") || segment === "node_modules")) return false;
  const name = segments[segments.length - 1];
  if (name === undefined || GENERATED_FILES.includes(name)) return false;
  return hasProductTextExtension(path);
}

function isPlainRelativePath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.includes("\\") &&
    !/[\u0000-\u001f\u007f]/.test(path) &&
    !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

/** README, 화면, 제품 소스를 먼저 담아 전체 한도를 넘어도 제품의 핵심이 남도록 한다. */
function snapshotPriority(path: string): number {
  if (path === "README.md") return 0;
  if (path === "index.html") return 1;
  if (path.startsWith("src/")) return 2;
  if (!path.includes("/")) return 3;
  if (path.startsWith("docs/")) return 4;
  return 5;
}

/** 안전하지 않은 경로(탈출, symlink, 비정규 문자)를 fail-closed로 거부한다. */
function assertSafeRelativePath(name: string, path: string): string {
  if (typeof path !== "string" || !path.trim()) throw new Error(`${name} must be a non-empty path`);
  if (path.startsWith("/") || path.includes("\\") || isAbsolute(path)) {
    throw new Error(`${name} must be a repository-relative path: ${path}`);
  }
  if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${name} contains an unsafe path segment: ${path}`);
  }
  if (/[\u0000-\u001f\u007f]/.test(path)) throw new Error(`${name} contains control characters: ${path}`);
  return path;
}

function collectProductPaths(targetRoot: string): string[] {
  const realRoot = realpathSync(targetRoot);
  const paths: string[] = [];
  const walk = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const stat = lstatSync(absolute);
      // Symlink는 snapshot 밖을 가리킬 수 있으므로 읽지 않고 건너뛴다.
      if (stat.isSymbolicLink()) continue;
      const path = relative(realRoot, absolute).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        walk(absolute);
      } else if (entry.isFile() && isProductSnapshotPath(path)) {
        paths.push(path);
      }
    }
  };
  walk(realRoot);
  return paths;
}

function readSnapshotFile(realRoot: string, path: string): ProductSnapshotFile | null {
  const absolute = resolve(realRoot, path);
  const rel = relative(realRoot, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`product snapshot path escapes target root: ${path}`);
  }
  const bytes = readFileSync(absolute);
  if (bytes.byteLength > PRODUCT_EVALUATION_BUDGET.maxTotalBytes) return null;
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return {
    path,
    byteLength: bytes.byteLength,
    digestAlgorithm: "sha256",
    contentDigest: sha256(bytes),
    content,
  };
}

function normalizeTarget(target: ProductDiscoveryTarget): ProductDiscoveryTarget {
  assertNonempty("repository", target.repository);
  assertPositiveInteger("discoveryIssueNumber", target.discoveryIssueNumber);
  if (!GIT_SHA.test(target.deployedSha)) throw new Error("deployedSha must be a git SHA");
  return { ...target };
}

/** 기각 후보는 trusted control-plane이 GitHub에서 읽어 오며, 여기서 모양과 예산만 결정적으로 고정한다. */
function normalizeRejectedCandidates(value: readonly RejectedCandidate[]): RejectedCandidate[] {
  if (!Array.isArray(value)) throw new Error("rejectedCandidates must be an array");
  if (value.length > PRODUCT_EVALUATION_BUDGET.maxRejectedCandidates) {
    throw new Error("rejectedCandidates exceeds maxRejectedCandidates");
  }
  const normalized = value.map((entry) => {
    const item = asObject("rejected candidate", entry);
    assertExactKeys("rejected candidate", item, new Set(["issueNumber", "title", "reason"]));
    const issueNumber = assertPositiveInteger("rejected candidate issueNumber", item.issueNumber);
    if (typeof item.title !== "string") throw new Error("rejected candidate title must be a string");
    const rawTitle = item.title.startsWith(SELF_IMPROVEMENT_TITLE_PREFIX)
      ? item.title.slice(SELF_IMPROVEMENT_TITLE_PREFIX.length)
      : item.title;
    const title = boundedLine("rejected candidate title", rawTitle);
    if (typeof item.reason !== "string") throw new Error("rejected candidate reason must be a string");
    const reason = item.reason.trim();
    if (Buffer.byteLength(reason, "utf8") > PRODUCT_EVALUATION_BUDGET.maxStatementBytes) {
      throw new Error("rejected candidate reason exceeds maxStatementBytes");
    }
    return { issueNumber, title, reason };
  });
  const numbers = normalized.map(({ issueNumber }) => issueNumber);
  if (new Set(numbers).size !== numbers.length) throw new Error("rejected candidate issueNumbers must be unique");
  return normalized.sort((left, right) => right.issueNumber - left.issueNumber);
}

function normalizeCompletedRequirements(value: readonly CompletedRequirement[]): CompletedRequirement[] {
  if (!Array.isArray(value)) throw new Error("completedRequirements must be an array");
  if (value.length > PRODUCT_EVALUATION_BUDGET.maxCompletedRequirements) {
    throw new Error("completedRequirements exceeds maxCompletedRequirements");
  }
  const normalized = value.map((entry) => {
    const item = asObject("completed requirement", entry);
    assertExactKeys("completed requirement", item, new Set(["issueNumber", "title"]));
    return {
      issueNumber: assertPositiveInteger("completed requirement issueNumber", item.issueNumber),
      title: boundedLine("completed requirement title", item.title),
    };
  });
  const numbers = normalized.map(({ issueNumber }) => issueNumber);
  if (new Set(numbers).size !== numbers.length) throw new Error("completed requirement issueNumbers must be unique");
  return normalized.sort((left, right) => right.issueNumber - left.issueNumber);
}

/** 최근 변경 경로는 순위를 낮추는 힌트다. 제품 snapshot 대상 경로만 남기고 앞(최근)부터 예산만큼 담는다. */
function normalizeRecentChangedPaths(value: readonly unknown[]): string[] {
  if (!Array.isArray(value)) throw new Error("recentChangedPaths must be an array");
  if (!value.every((path) => typeof path === "string")) throw new Error("recentChangedPaths must contain strings");
  const paths = [...new Set(value.filter(isPlainRelativePath).filter(isProductSnapshotPath))];
  return paths
    .slice(0, PRODUCT_EVALUATION_BUDGET.maxRecentChangedPaths)
    .sort((left, right) => left.localeCompare(right));
}

function normalizeHistory(history: ProductHistoryInput): ProductHistory {
  const value = asObject("history", history);
  assertExactKeys("history", value, new Set(["completedRequirements", "rejectedCandidates", "recentChangedPaths"]));
  return {
    completedRequirements: normalizeCompletedRequirements(history.completedRequirements ?? []),
    rejectedCandidates: normalizeRejectedCandidates(history.rejectedCandidates ?? []),
    recentChangedPaths: normalizeRecentChangedPaths(history.recentChangedPaths ?? []),
  };
}

/**
 * 실행 시점 기본 브랜치의 제품 source 전체(테스트 제외)와 README, 최근 이력을 담은 snapshot을 만든다.
 * Framework 파일은 선택 자체에서 제외되므로 Discovery가 Framework를 볼 수 없다.
 * 바뀐 파일을 앞에 두지 않는다. 전체 한도를 넘는 파일만 omittedPaths로 남긴다.
 */
export function createProductSnapshot(
  target: ProductDiscoveryTarget,
  targetRoot: string,
  history: ProductHistoryInput = {},
): ProductSnapshot {
  const discovery = normalizeTarget(target);
  const normalizedHistory = normalizeHistory(history);
  const root = resolve(targetRoot);
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("product snapshot target root must be a real directory");
  }
  const realRoot = realpathSync(root);

  const candidates = collectProductPaths(realRoot).sort((left, right) => {
    const byPriority = snapshotPriority(left) - snapshotPriority(right);
    return byPriority !== 0 ? byPriority : left.localeCompare(right);
  });

  const files: ProductSnapshotFile[] = [];
  const omittedPaths: string[] = [];
  let totalSnapshotBytes = 0;

  for (const path of candidates) {
    const file = readSnapshotFile(realRoot, path);
    if (file === null || totalSnapshotBytes + file.byteLength > PRODUCT_EVALUATION_BUDGET.maxTotalBytes) {
      omittedPaths.push(path);
      continue;
    }
    files.push(file);
    totalSnapshotBytes += file.byteLength;
  }

  if (files.length === 0) throw new Error("product snapshot requires at least one product file");

  files.sort((left, right) => left.path.localeCompare(right.path));
  omittedPaths.sort((left, right) => left.localeCompare(right));

  const payload: ProductSnapshotPayload = {
    schemaVersion: 2,
    kind: "trusted-product-snapshot",
    repository: discovery.repository,
    discovery: {
      issueNumber: discovery.discoveryIssueNumber,
      deployedSha: discovery.deployedSha,
    },
    budget: { maxTotalBytes: PRODUCT_EVALUATION_BUDGET.maxTotalBytes },
    files,
    omittedPaths,
    history: normalizedHistory,
    fileCount: files.length,
    totalSnapshotBytes,
  };

  return { ...payload, digestAlgorithm: "sha256", snapshotDigest: sha256(JSON.stringify(payload)) };
}

export function verifyProductSnapshot(snapshot: ProductSnapshot): void {
  if (
    snapshot.schemaVersion !== 2 ||
    snapshot.kind !== "trusted-product-snapshot" ||
    snapshot.digestAlgorithm !== "sha256" ||
    !SHA256.test(snapshot.snapshotDigest)
  ) {
    throw new Error("unsupported product snapshot schema or digest");
  }
  if (snapshot.files.length !== snapshot.fileCount) throw new Error("product snapshot fileCount mismatch");
  if (JSON.stringify(normalizeHistory(snapshot.history)) !== JSON.stringify(snapshot.history)) {
    throw new Error("product snapshot history is not canonical");
  }
  const total = snapshot.files.reduce((sum, file) => sum + file.byteLength, 0);
  if (total !== snapshot.totalSnapshotBytes) throw new Error("product snapshot totalSnapshotBytes mismatch");
  if (total > PRODUCT_EVALUATION_BUDGET.maxTotalBytes) throw new Error("product snapshot exceeds maxTotalBytes");
  for (const file of snapshot.files) {
    if (!isProductSnapshotPath(file.path)) {
      throw new Error(`product snapshot contains a non-product path: ${file.path}`);
    }
    if (sha256(Buffer.from(file.content, "utf8")) !== file.contentDigest) {
      throw new Error(`product snapshot content digest mismatch: ${file.path}`);
    }
  }
  const {
    digestAlgorithm: _digestAlgorithm,
    snapshotDigest: _snapshotDigest,
    ...payload
  } = snapshot;
  if (sha256(JSON.stringify(payload)) !== snapshot.snapshotDigest) {
    throw new Error("product snapshot digest mismatch");
  }
}

export function productEvaluationReportArtifactName(
  snapshot: ProductSnapshot,
  runId: number,
  runAttempt: number,
): string {
  assertPositiveInteger("runId", runId);
  assertPositiveInteger("runAttempt", runAttempt);
  return `product-evaluation-report-${snapshot.discovery.deployedSha}-${runId}-attempt-${runAttempt}`;
}

function normalizeEvidencePaths(
  name: string,
  value: unknown,
  knownPaths: ReadonlySet<string>,
): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name} requires at least one snapshot path`);
  }
  const paths = value.map((entry) => {
    if (typeof entry !== "string") throw new Error(`${name} must contain strings`);
    if (!knownPaths.has(entry)) throw new Error(`${name} references a path outside the product snapshot: ${entry}`);
    return entry;
  });
  if (new Set(paths).size !== paths.length) throw new Error(`${name} must be unique`);
  return [...paths].sort((left, right) => left.localeCompare(right));
}

/** 개선 범위는 App 제품 경로여야 한다. Framework 경로를 제안하면 fail-closed로 거부한다. */
function normalizeScopePaths(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("candidate scopePaths requires at least one product path");
  }
  if (value.length > PRODUCT_EVALUATION_BUDGET.maxScopePaths) {
    throw new Error("candidate scopePaths exceeds maxScopePaths");
  }
  const paths = value.map((entry) => {
    if (typeof entry !== "string") throw new Error("candidate scopePaths must contain strings");
    const path = assertSafeRelativePath("candidate scopePaths", entry.trim());
    if (isFrameworkOwnedPath(path)) {
      throw new Error(`candidate scopePaths must not target Framework-owned paths: ${path}`);
    }
    return path;
  });
  if (new Set(paths).size !== paths.length) throw new Error("candidate scopePaths must be unique");
  return [...paths].sort((left, right) => left.localeCompare(right));
}

function normalizeTitle(value: unknown): string {
  const title = boundedLine("candidate title", value);
  // 접두사는 trusted control-plane만 붙인다.
  if (title.startsWith("[")) throw new Error("candidate title must not carry its own bracket tag");
  return title;
}

function normalizeLevel(name: string, value: unknown): ProductComparisonLevel {
  if (typeof value !== "string" || !LEVELS.includes(value)) throw new Error(`${name} is unsupported`);
  return value as ProductComparisonLevel;
}

function normalizeBoolean(name: string, value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function normalizeComparison(value: unknown, knownPaths: ReadonlySet<string>): ProductComparison {
  const item = asObject("comparison", value);
  assertExactKeys("comparison", item, COMPARISON_KEYS);
  if (typeof item.id !== "string" || !COMPARISON_IDS.includes(item.id)) throw new Error("comparison id is invalid");
  return {
    id: item.id,
    area: boundedLine("comparison area", item.area),
    summary: boundedText("comparison summary", item.summary),
    userImpact: normalizeLevel("comparison userImpact", item.userImpact),
    usageFrequency: normalizeLevel("comparison usageFrequency", item.usageFrequency),
    visionFit: normalizeLevel("comparison visionFit", item.visionFit),
    defect: normalizeBoolean("comparison defect", item.defect),
    recentlyChanged: normalizeBoolean("comparison recentlyChanged", item.recentlyChanged),
    evidencePaths: normalizeEvidencePaths("comparison evidencePaths", item.evidencePaths, knownPaths),
  };
}

function normalizeNotSelected(value: unknown): ProductNotSelected {
  const item = asObject("notSelected", value);
  assertExactKeys("notSelected", item, NOT_SELECTED_KEYS);
  if (typeof item.id !== "string" || !COMPARISON_IDS.includes(item.id)) throw new Error("notSelected id is invalid");
  return { id: item.id, reason: boundedText("notSelected reason", item.reason) };
}

function normalizeProposal(value: unknown, knownPaths: ReadonlySet<string>): ProductImprovementProposal {
  const item = asObject("candidate", value);
  assertExactKeys("candidate", item, PROPOSAL_KEYS);
  if (typeof item.confidence !== "string" || !CONFIDENCES.includes(item.confidence)) {
    throw new Error("candidate confidence is unsupported");
  }
  return {
    title: normalizeTitle(item.title),
    problem: boundedText("candidate problem", item.problem),
    desiredOutcome: boundedText("candidate desiredOutcome", item.desiredOutcome),
    acceptanceExample: boundedText("candidate acceptanceExample", item.acceptanceExample),
    constraint: boundedText("candidate constraint", item.constraint),
    scopePaths: normalizeScopePaths(item.scopePaths),
    evidencePaths: normalizeEvidencePaths("candidate evidencePaths", item.evidencePaths, knownPaths),
    confidence: item.confidence as ProductEvaluationConfidence,
  };
}

/** 영역이 같은지는 공백과 대소문자 차이를 무시한 결정적 비교로만 판단한다. */
function normalizeForCompare(value: string): string {
  return value.trim().replaceAll(/\s+/gu, " ").toLowerCase();
}

function normalizeRawEvaluation(
  raw: unknown,
  snapshot: ProductSnapshot,
): { comparisons: ProductComparison[]; selection: ProductSelection; candidate: ProductImprovementProposal | null } {
  const object = asObject("product discovery", raw);
  assertExactKeys("product discovery", object, RAW_KEYS);
  if (object.schemaVersion !== 2 || object.kind !== "untrusted-product-discovery") {
    throw new Error("unsupported product discovery schema");
  }
  if (typeof object.sourceSnapshotDigest !== "string" || object.sourceSnapshotDigest !== snapshot.snapshotDigest) {
    throw new Error("product discovery source snapshot digest mismatch");
  }

  const knownPaths = new Set(snapshot.files.map(({ path }) => path));
  if (!Array.isArray(object.comparisons) || object.comparisons.length !== COMPARISON_IDS.length) {
    throw new Error(`product discovery must compare exactly ${COMPARISON_IDS.length} candidates`);
  }
  const comparisons = object.comparisons
    .map((item) => normalizeComparison(item, knownPaths))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (comparisons.map(({ id }) => id).join(",") !== COMPARISON_IDS.join(",")) {
    throw new Error("comparison ids must be unique");
  }
  if (new Set(comparisons.map(({ area }) => normalizeForCompare(area))).size !== comparisons.length) {
    throw new Error("compared candidates must come from different areas");
  }

  const selectedId = object.selectedId;
  if (typeof selectedId !== "string" || (selectedId !== NO_CANDIDATE && !COMPARISON_IDS.includes(selectedId))) {
    throw new Error("selectedId is invalid");
  }

  // 고르지 않은 후보는 전부, 정확히 한 번씩 이유를 가져야 한다.
  if (!Array.isArray(object.notSelected)) throw new Error("notSelected must be an array");
  const notSelected = object.notSelected
    .map(normalizeNotSelected)
    .sort((left, right) => left.id.localeCompare(right.id));
  const expectedNotSelected = COMPARISON_IDS.filter((id) => id !== selectedId);
  if (notSelected.map(({ id }) => id).join(",") !== expectedNotSelected.join(",")) {
    throw new Error("notSelected must give a reason for every candidate that was not selected");
  }

  if (!Array.isArray(object.candidates)) throw new Error("candidates must be an array");
  // 한 실행당 Improvement Candidate는 최대 1개다.
  if (object.candidates.length > 1) throw new Error("product discovery allows at most one candidate per run");
  if (selectedId === NO_CANDIDATE && object.candidates.length !== 0) {
    throw new Error("NONE selection must not carry a candidate");
  }
  if (selectedId !== NO_CANDIDATE && object.candidates.length !== 1) {
    throw new Error("selected candidate requires exactly one proposal");
  }
  const candidate = object.candidates.length === 1 ? normalizeProposal(object.candidates[0], knownPaths) : null;

  return { comparisons, selection: { selectedId, notSelected }, candidate };
}

function normalizeFinalizeIdentity(
  identity: ProductEvaluationFinalizeIdentity,
): ProductEvaluationFinalizeIdentity {
  assertPositiveInteger("sourceRun.runId", identity.sourceRun.runId);
  assertPositiveInteger("sourceRun.runAttempt", identity.sourceRun.runAttempt);
  assertNonempty("snapshotArtifact.name", identity.snapshotArtifact.name);
  assertPositiveInteger("snapshotArtifact.id", identity.snapshotArtifact.id);
  const digest = normalizeSha256("snapshotArtifact.digest", identity.snapshotArtifact.digest);
  assertNonempty("evaluator.provider", identity.evaluator.provider);
  assertNonempty("evaluator.action", identity.evaluator.action);
  assertNonempty("evaluator.model", identity.evaluator.model);
  assertNonempty("evaluator.reasoningEffort", identity.evaluator.reasoningEffort);
  return {
    sourceRun: { ...identity.sourceRun },
    snapshotArtifact: { ...identity.snapshotArtifact, digest },
    evaluator: { ...identity.evaluator },
  };
}

export function createProductEvaluationReport(
  snapshot: ProductSnapshot,
  raw: unknown,
  finalizeIdentity: ProductEvaluationFinalizeIdentity,
): ProductEvaluationReport {
  verifyProductSnapshot(snapshot);
  const normalized = normalizeRawEvaluation(raw, snapshot);
  const identity = normalizeFinalizeIdentity(finalizeIdentity);

  const payload: ProductEvaluationReportPayload = {
    schemaVersion: 2,
    kind: "untrusted-product-evaluation-report",
    repository: snapshot.repository,
    source: {
      snapshot: {
        snapshotDigest: snapshot.snapshotDigest,
        artifact: { ...identity.snapshotArtifact },
        sourceRun: { ...identity.sourceRun },
      },
    },
    discovery: { ...snapshot.discovery },
    evaluator: { ...identity.evaluator },
    comparisons: normalized.comparisons,
    selection: normalized.selection,
    candidate: normalized.candidate,
  };

  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > PRODUCT_EVALUATION_BUDGET.maxReportBytes) {
    throw new Error("product evaluation report exceeds maxReportBytes");
  }
  return { ...payload, digestAlgorithm: "sha256", reportDigest: sha256(JSON.stringify(payload)) };
}

export function verifyProductEvaluationReport(report: ProductEvaluationReport, snapshot: ProductSnapshot): void {
  if (
    report.schemaVersion !== 2 ||
    report.kind !== "untrusted-product-evaluation-report" ||
    report.digestAlgorithm !== "sha256" ||
    !SHA256.test(report.reportDigest)
  ) {
    throw new Error("unsupported product evaluation report schema or digest");
  }
  if (JSON.stringify(report.discovery) !== JSON.stringify(snapshot.discovery)) {
    throw new Error("product evaluation report discovery identity mismatch");
  }
  if (report.source.snapshot.snapshotDigest !== snapshot.snapshotDigest) {
    throw new Error("product evaluation report snapshot digest mismatch");
  }

  const regenerated = createProductEvaluationReport(
    snapshot,
    {
      schemaVersion: 2,
      kind: "untrusted-product-discovery",
      sourceSnapshotDigest: report.source.snapshot.snapshotDigest,
      comparisons: report.comparisons,
      selectedId: report.selection.selectedId,
      notSelected: report.selection.notSelected,
      candidates: report.candidate === null ? [] : [report.candidate],
    },
    {
      sourceRun: report.source.snapshot.sourceRun,
      snapshotArtifact: report.source.snapshot.artifact,
      evaluator: report.evaluator,
    },
  );
  if (JSON.stringify(regenerated) !== JSON.stringify(report)) {
    throw new Error("product evaluation report digest or canonical shape mismatch");
  }
}

export function createProductEvaluationPrompt(snapshot: ProductSnapshot): string {
  const snapshotView = {
    ...snapshot,
    files: snapshot.files.map(({ path, byteLength, content }) => ({ path, byteLength, content })),
  };
  const { completedRequirements, rejectedCandidates, recentChangedPaths } = snapshot.history;
  return [
    "# 역할",
    "당신은 지금 배포된 App을 제품 관점에서 한 번 살펴보는 read-only AI Product Discovery입니다.",
    "아래 Trusted Product Snapshot만 근거로 사용하십시오. GitHub, repository, 웹, 다른 run/artifact를 탐색하거나 추정하지 마십시오.",
    "",
    "# 판단 순서",
    "1. 서로 다른 제품 영역(화면, 기능, 데이터 등)에서 개선 후보 3개를 찾아 comparisons에 c1, c2, c3으로 적습니다. 같은 영역의 후보를 둘 이상 넣지 않습니다.",
    "2. 세 후보를 사용자 영향(userImpact), 사용 빈도(usageFrequency), README가 말하는 제품 비전과의 일치(visionFit)로 비교합니다.",
    "3. 최근 변경 경로에 속한 영역의 후보는 recentlyChanged를 true로 적고 순위를 낮춥니다. 단, 사용자가 겪는 결함(defect: true)은 예외입니다.",
    "4. 1위 1개만 selectedId로 고르고 candidates에 구체적인 제안 1개를 적습니다. 고르지 않은 2개는 notSelected에 이유를 적습니다.",
    "5. 세 후보 모두 가치가 낮으면 selectedId를 NONE으로 하고 candidates는 빈 배열, notSelected에 세 후보 모두의 이유를 적습니다. 억지로 고르지 마십시오.",
    "",
    "# 판단 기준",
    "- 이 App을 실제로 쓰는 사용자가 곧바로 아쉬워할 만한 제품 문제만 후보로 삼습니다.",
    "- 개발 프로세스, CI, 테스트 전략, workflow, 리뷰 방식, 배포 자동화는 평가 대상이 아닙니다.",
    "- Snapshot에 없는 파일(omittedPaths 포함)은 내용을 단정하지 않습니다.",
    "- '완료한 요구'에 이미 있는 일과 '이미 기각된 후보'는 다른 표현, 부분 적용, 우회 방식으로도 다시 제안하지 마십시오.",
    "",
    "# 출력 규칙",
    "- JSON schema에 맞는 JSON만 출력합니다.",
    "- 모든 문장은 한국어로 작성하고 id, 경로, enum 값은 원래 형식을 유지합니다.",
    "- comparisons와 candidates의 evidencePaths는 snapshot에 있는 경로만 인용합니다.",
    "- candidates는 최대 1개이고, selectedId가 NONE이 아닐 때만 1개입니다.",
    "- candidates[0].scopePaths는 이 App의 제품 경로만 적습니다. Framework 경로를 적으면 거부됩니다.",
    "- title은 대괄호 태그 없이 개선 내용을 한 줄로 적습니다.",
    "- 코드 수정, Issue/PR 생성, workflow 실행, 승인, Merge를 실행하지 않습니다.",
    "- 이 판단은 사람이 검토할 제안일 뿐 authority가 아닙니다.",
    "",
    "# 완료한 요구 (다시 제안 금지)",
    ...(completedRequirements.length === 0
      ? ["없음"]
      : completedRequirements.map(({ issueNumber, title }) => `- #${issueNumber} ${title}`)),
    "",
    "# 이미 기각된 후보 (다시 제안 금지)",
    ...(rejectedCandidates.length === 0
      ? ["없음"]
      : rejectedCandidates.map(({ issueNumber, title, reason }) =>
          `- #${issueNumber} ${title}${reason ? ` — 기각 사유: ${reason}` : ""}`,
        )),
    "",
    "# 최근 변경 경로 (이 영역의 후보는 결함이 아니면 순위를 낮춤)",
    ...(recentChangedPaths.length === 0 ? ["없음"] : recentChangedPaths.map((path) => `- ${path}`)),
    "",
    "# Trusted Product Snapshot",
    "```json",
    JSON.stringify(snapshotView, null, 2),
    "```",
  ].join("\n");
}

export function createProductEvaluationOutputSchema(snapshot: ProductSnapshot): Record<string, unknown> {
  const snapshotPaths = snapshot.files.map(({ path }) => path);
  const evidencePathsSchema = {
    type: "array",
    minItems: 1,
    items: { type: "string", enum: snapshotPaths },
  };
  const boundedString = { type: "string", minLength: 1 };
  const level = { type: "string", enum: [...LEVELS] };
  const comparisonId = { type: "string", enum: [...COMPARISON_IDS] };

  return {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "kind", "sourceSnapshotDigest", "comparisons", "selectedId", "notSelected", "candidates"],
    properties: {
      schemaVersion: { type: "integer", const: 2 },
      kind: { type: "string", const: "untrusted-product-discovery" },
      sourceSnapshotDigest: { type: "string", const: snapshot.snapshotDigest },
      comparisons: {
        type: "array",
        minItems: COMPARISON_IDS.length,
        maxItems: COMPARISON_IDS.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: [...COMPARISON_KEYS],
          properties: {
            id: comparisonId,
            area: boundedString,
            summary: boundedString,
            userImpact: level,
            usageFrequency: level,
            visionFit: level,
            defect: { type: "boolean" },
            recentlyChanged: { type: "boolean" },
            evidencePaths: evidencePathsSchema,
          },
        },
      },
      selectedId: { type: "string", enum: [...COMPARISON_IDS, NO_CANDIDATE] },
      notSelected: {
        type: "array",
        minItems: COMPARISON_IDS.length - 1,
        maxItems: COMPARISON_IDS.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "reason"],
          properties: { id: comparisonId, reason: boundedString },
        },
      },
      candidates: {
        type: "array",
        maxItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: [...PROPOSAL_KEYS],
          properties: {
            title: boundedString,
            problem: boundedString,
            desiredOutcome: boundedString,
            acceptanceExample: boundedString,
            constraint: boundedString,
            scopePaths: {
              type: "array",
              minItems: 1,
              maxItems: PRODUCT_EVALUATION_BUDGET.maxScopePaths,
              items: boundedString,
            },
            evidencePaths: evidencePathsSchema,
            confidence: { type: "string", enum: [...CONFIDENCES] },
          },
        },
      },
    },
  };
}

/** 제목 중복 판단은 접두사와 공백 차이를 무시한 결정적 비교로만 한다. */
function normalizeTitleForDedup(title: string): string {
  const withoutPrefix = title.startsWith(SELF_IMPROVEMENT_TITLE_PREFIX)
    ? title.slice(SELF_IMPROVEMENT_TITLE_PREFIX.length)
    : title;
  return normalizeForCompare(withoutPrefix);
}

export function improvementIssueTitle(candidate: ProductImprovementProposal): string {
  return `${SELF_IMPROVEMENT_TITLE_PREFIX} ${candidate.title}`;
}

const LEVEL_LABELS: Readonly<Record<ProductComparisonLevel, string>> = { high: "높음", medium: "보통", low: "낮음" };

/** Markdown 표 칸 하나. AI 문장이 표를 깨지 않게 한다. */
function tableCell(value: string): string {
  return value.replaceAll(/\s+/gu, " ").replaceAll("|", "\\|").trim();
}

function renderComparisonTable(report: ProductEvaluationReport): string {
  return [
    "| 후보 | 영역 | 내용 | 사용자 영향 | 사용 빈도 | README 비전 | 결함 | 최근 변경 영역 |",
    "|---|---|---|---|---|---|---|---|",
    ...report.comparisons.map((comparison) => [
      comparison.id === report.selection.selectedId ? `**${comparison.id} (1위)**` : comparison.id,
      tableCell(comparison.area),
      tableCell(comparison.summary),
      LEVEL_LABELS[comparison.userImpact],
      LEVEL_LABELS[comparison.usageFrequency],
      LEVEL_LABELS[comparison.visionFit],
      comparison.defect ? "예" : "아니오",
      comparison.recentlyChanged ? "예" : "아니오",
    ].join(" | ")).map((row) => `| ${row} |`),
  ].join("\n");
}

function renderNotSelected(report: ProductEvaluationReport): string {
  const areas = new Map(report.comparisons.map(({ id, area }) => [id, area]));
  return report.selection.notSelected
    .map(({ id, reason }) => `- ${id} (${tableCell(areas.get(id) ?? "")}): ${reason.replaceAll(/\s+/gu, " ").trim()}`)
    .join("\n");
}

export function renderImprovementIssueBody(report: ProductEvaluationReport): string {
  const candidate = report.candidate;
  if (candidate === null) throw new Error("cannot render an improvement issue without a candidate");
  const discovery = report.discovery;
  const run = report.source.snapshot.sourceRun;
  const list = (items: readonly string[]): string => items.map((item) => `- \`${item}\``).join("\n");

  return [
    `<!-- ai-dev-framework:PRODUCT_IMPROVEMENT discovery-issue=${discovery.issueNumber} discovery-run=${run.runId} snapshot=${report.source.snapshot.snapshotDigest} -->`,
    "## 어떤 업무가 불편한가요?",
    candidate.problem,
    "## 어떻게 바뀌면 좋겠나요?",
    candidate.desiredOutcome,
    "## 잘 되었다고 판단할 수 있는 예",
    candidate.acceptanceExample,
    "## 지켜야 할 사항",
    candidate.constraint,
    "## 예상 변경 범위",
    list(candidate.scopePaths),
    "## 근거로 읽은 제품 파일",
    list(candidate.evidencePaths),
    "## 비교한 후보",
    renderComparisonTable(report),
    "## 고르지 않은 후보와 이유",
    renderNotSelected(report),
    "---",
    "### HumanStatus: IMPROVEMENT_CANDIDATE",
    "**현재 상황:** 사람이 실행한 Product Discovery가 배포된 App에서 후보 3개를 비교해 1위로 고른 개선 후보입니다. 아직 아무 구현도 시작하지 않았습니다.",
    "**다음 행동:** read-only AI PLAN이 이 Issue에 자동으로 제안됩니다. PLAN을 읽고 진행하려면 `PLAN-승인` 댓글을 남기고, 진행하지 않으려면 사유를 남기고 `not_planned`로 닫으세요. PLAN-승인 이후에만 구현이 시작됩니다.",
    [
      `- Product Discovery: Discovery Issue #${discovery.issueNumber} / run ${run.runId} (attempt ${run.runAttempt})`,
      `- 평가한 배포 SHA: \`${discovery.deployedSha}\``,
      `- Product Snapshot SHA-256: \`${report.source.snapshot.snapshotDigest}\``,
      `- Product Evaluation report SHA-256: \`${report.reportDigest}\``,
      `- Evaluator: ${report.evaluator.provider} / ${report.evaluator.action} / ${report.evaluator.model} / effort ${report.evaluator.reasoningEffort}`,
      `- Evaluator 확신도: ${candidate.confidence}`,
      "- 이 Issue는 proposal이며 최종 Merge는 Human-only입니다.",
    ].join("\n"),
  ].join("\n\n");
}

/**
 * Issue 생성 여부를 결정적으로 판단한다. AI에게 중복 판단을 맡기지 않는다.
 *
 * - 1위가 없으면(NONE) 만들지 않는다.
 * - 열린 Self-Improvement Issue가 하나라도 있으면 사람이 처리할 때까지 더 쌓지 않는다.
 * - 열림/닫힘과 무관하게 같은 제목이 이미 있으면 만들지 않는다.
 */
export function decideImprovementIssue(
  report: ProductEvaluationReport,
  existingIssues: readonly ExistingIssue[],
): ImprovementIssueDecision {
  const candidate = report.candidate;
  if (candidate === null) {
    return { action: "skip", reason: "비교한 후보 3개 모두 가치가 낮아 NONE으로 판단했습니다" };
  }

  const openSelfImprovement = existingIssues
    .filter((issue) => issue.state === "open" && issue.title.startsWith(SELF_IMPROVEMENT_TITLE_PREFIX))
    .sort((left, right) => left.number - right.number)[0];
  if (openSelfImprovement !== undefined) {
    return {
      action: "skip",
      reason: `이미 열린 Improvement Candidate Issue가 있습니다: #${openSelfImprovement.number}`,
    };
  }

  const wanted = normalizeTitleForDedup(improvementIssueTitle(candidate));
  const duplicate = existingIssues
    .filter((issue) => normalizeTitleForDedup(issue.title) === wanted)
    .sort((left, right) => left.number - right.number)[0];
  if (duplicate !== undefined) {
    return { action: "skip", reason: `같은 제목의 Issue가 이미 있습니다: #${duplicate.number}` };
  }

  return {
    action: "create",
    title: improvementIssueTitle(candidate),
    body: renderImprovementIssueBody(report),
  };
}

/** Discovery 전용 Issue에 남기는 사람이 읽을 결과. 생성된 Issue 번호는 workflow가 뒤에 덧붙인다. */
export function renderDiscoveryResultComment(
  report: ProductEvaluationReport,
  decision: ImprovementIssueDecision,
): string {
  const run = report.source.snapshot.sourceRun;
  const selected = report.comparisons.find(({ id }) => id === report.selection.selectedId);
  return [
    `<!-- ai-dev-framework:PRODUCT_DISCOVERY_RESULT run=${run.runId} run-attempt=${run.runAttempt} snapshot=${report.source.snapshot.snapshotDigest} -->`,
    `## Product Discovery 결과 (배포 SHA \`${report.discovery.deployedSha}\`)`,
    "### 비교한 후보",
    renderComparisonTable(report),
    "### 판단",
    selected === undefined || report.candidate === null
      ? "- 1위 없음(NONE): 세 후보 모두 가치가 낮다고 판단했습니다."
      : `- 1위: ${selected.id} (${tableCell(selected.area)}) — ${report.candidate.title}`,
    renderNotSelected(report),
    "### 결과",
    decision.action === "create"
      ? `Improvement Candidate Issue를 만듭니다: ${decision.title}`
      : `Improvement Candidate Issue를 만들지 않았습니다: ${decision.reason}`,
    `Evaluator: ${report.evaluator.provider} / ${report.evaluator.model} / effort ${report.evaluator.reasoningEffort} · report SHA-256 \`${report.reportDigest}\``,
  ].join("\n\n");
}

// ---- Product Discovery subscription: Private subscription executor(Claude Max, opus)에 1회 요청한다. ----

export const PRODUCT_DISCOVERY_SUBSCRIPTION_MODEL = "opus" as const;

export interface ProductDiscoverySubscriptionIdentity {
  readonly schemaVersion: 1;
  readonly kind: "trusted-product-discovery-request";
  readonly repository: string;
  /** 교환 comment를 남기는 Discovery 전용 Issue. */
  readonly issueNumber: number;
  /** 평가한 배포 SHA(실행 시점 default branch). */
  readonly baseSha: string;
  readonly snapshotDigest: string;
  /** 결과를 기다리는 이 Product Discovery run. Private Executor가 live run인지 확인한다. */
  readonly worker: { readonly runId: number; readonly runAttempt: number };
  readonly model: typeof PRODUCT_DISCOVERY_SUBSCRIPTION_MODEL;
}

export function createProductDiscoverySubscriptionIdentity(
  snapshot: ProductSnapshot,
  worker: { readonly runId: number; readonly runAttempt: number },
): ProductDiscoverySubscriptionIdentity {
  verifyProductSnapshot(snapshot);
  for (const [name, value] of [["worker.runId", worker.runId], ["worker.runAttempt", worker.runAttempt]] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "trusted-product-discovery-request",
    repository: snapshot.repository,
    issueNumber: snapshot.discovery.issueNumber,
    baseSha: snapshot.discovery.deployedSha,
    snapshotDigest: snapshot.snapshotDigest,
    worker: { runId: worker.runId, runAttempt: worker.runAttempt },
    model: PRODUCT_DISCOVERY_SUBSCRIPTION_MODEL,
  });
}
