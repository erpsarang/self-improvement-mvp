import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

/**
 * Product Evaluation은 Human Merge로 배포된 App을 제품 관점에서 한 번 평가하고,
 * 명백한 다음 개선사항이 있을 때만 App repository에 Improvement Candidate Issue를 만든다.
 *
 * LEARN이 "개발 cycle이 어떻게 흘렀는가"를 본다면 이 stage는 "배포된 제품이 사용자에게
 * 충분한가"를 본다. 두 stage는 입력도 산출물도 공유하지 않는다.
 *
 * 경계:
 * - 한 cycle당 Improvement Candidate 최대 1개 (schema가 구조적으로 제한한다)
 * - 기존 Issue와 중복이면 생성 금지 (trusted control-plane이 결정적으로 판단한다)
 * - Framework 자체 개선 후보는 생성 금지 (snapshot에 Framework 파일이 없고 scope도 거부한다)
 * - 생성한 Issue는 proposal이다. read-only PLAN은 자동으로 한 번 제안되지만 구현은 사람의 PLAN-승인 이후에만 시작된다
 */

export const SELF_IMPROVEMENT_TITLE_PREFIX = "[Self-Improvement]";

export const PRODUCT_EVALUATION_BUDGET = Object.freeze({
  maxFiles: 24,
  maxFileBytes: 16_384,
  maxTotalBytes: 131_072,
  maxObservations: 6,
  maxStatementBytes: 1_024,
  maxScopePaths: 8,
  maxTitleBytes: 160,
  maxReportBytes: 32_768,
  maxRejectedCandidates: 16,
});

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
const OBSERVATION_ID = /^[a-z][a-z0-9._-]{0,127}$/;
const CONFIDENCES: readonly string[] = ["high", "medium", "low"];

const RAW_KEYS = new Set(["schemaVersion", "kind", "sourceSnapshotDigest", "observations", "candidates"]);
const OBSERVATION_KEYS = new Set(["id", "statement", "evidencePaths"]);
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

export interface ProductCycleIdentity {
  readonly repository: string;
  readonly requirementIssueNumber: number;
  readonly humanMergePullRequestNumber: number;
  readonly reviewedHeadSha: string;
  readonly mergeCommitSha: string;
  /** snapshot 내용을 읽은 배포 SHA. 평가 대상은 특정 PR이 아니라 지금 배포된 제품이다. */
  readonly deployedSha: string;
}

/** 사람이 not_planned로 닫은 Improvement Candidate. 같은 문제를 다른 표현으로 다시 제안하지 않게 한다. */
export interface RejectedCandidate {
  readonly issueNumber: number;
  readonly title: string;
  readonly reason: string;
}

export interface ProductSnapshotFile {
  readonly path: string;
  readonly byteLength: number;
  readonly digestAlgorithm: "sha256";
  readonly contentDigest: string;
  readonly content: string;
}

export interface ProductSnapshotPayload {
  readonly schemaVersion: 1;
  readonly kind: "trusted-product-snapshot";
  readonly repository: string;
  readonly deployedCycle: {
    readonly requirementIssueNumber: number;
    readonly humanMergePullRequestNumber: number;
    readonly reviewedHeadSha: string;
    readonly mergeCommitSha: string;
    readonly deployedSha: string;
  };
  readonly budget: {
    readonly maxFiles: number;
    readonly maxFileBytes: number;
    readonly maxTotalBytes: number;
  };
  readonly files: readonly ProductSnapshotFile[];
  readonly omittedPaths: readonly string[];
  readonly rejectedCandidates: readonly RejectedCandidate[];
  readonly fileCount: number;
  readonly totalSnapshotBytes: number;
}

export interface ProductSnapshot extends ProductSnapshotPayload {
  readonly digestAlgorithm: "sha256";
  readonly snapshotDigest: string;
}

export interface ProductObservation {
  readonly id: string;
  readonly statement: string;
  readonly evidencePaths: readonly string[];
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
  readonly schemaVersion: 1;
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
  readonly deployedCycle: ProductSnapshotPayload["deployedCycle"];
  readonly evaluator: ProductEvaluationFinalizeIdentity["evaluator"];
  readonly observations: readonly ProductObservation[];
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

/** README, 화면, 제품 소스를 먼저 담아 예산이 모자라도 제품의 핵심이 남도록 한다. */
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
  if (bytes.byteLength > PRODUCT_EVALUATION_BUDGET.maxFileBytes) return null;
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

function normalizeCycleIdentity(identity: ProductCycleIdentity): ProductCycleIdentity {
  assertNonempty("repository", identity.repository);
  assertPositiveInteger("requirementIssueNumber", identity.requirementIssueNumber);
  assertPositiveInteger("humanMergePullRequestNumber", identity.humanMergePullRequestNumber);
  if (!GIT_SHA.test(identity.reviewedHeadSha)) throw new Error("reviewedHeadSha must be a git SHA");
  if (!GIT_SHA.test(identity.mergeCommitSha)) throw new Error("mergeCommitSha must be a git SHA");
  if (!GIT_SHA.test(identity.deployedSha)) throw new Error("deployedSha must be a git SHA");
  return { ...identity };
}

/**
 * 배포된 merge commit의 제품 내용만 담은 bounded snapshot을 만든다.
 * Framework 파일은 선택 자체에서 제외되므로 Learner가 Framework를 볼 수 없다.
 */
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
    const title = assertNonempty("rejected candidate title", rawTitle).trim();
    if (/[\r\n]/.test(title)) throw new Error("rejected candidate title must be a single line");
    if (Buffer.byteLength(title, "utf8") > PRODUCT_EVALUATION_BUDGET.maxTitleBytes) {
      throw new Error("rejected candidate title exceeds maxTitleBytes");
    }
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

export function createProductSnapshot(
  identity: ProductCycleIdentity,
  targetRoot: string,
  rejectedCandidates: readonly RejectedCandidate[] = [],
): ProductSnapshot {
  const cycle = normalizeCycleIdentity(identity);
  const rejected = normalizeRejectedCandidates(rejectedCandidates);
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
    if (files.length >= PRODUCT_EVALUATION_BUDGET.maxFiles) {
      omittedPaths.push(path);
      continue;
    }
    const file = readSnapshotFile(realRoot, path);
    if (file === null) {
      omittedPaths.push(path);
      continue;
    }
    if (totalSnapshotBytes + file.byteLength > PRODUCT_EVALUATION_BUDGET.maxTotalBytes) {
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
    schemaVersion: 1,
    kind: "trusted-product-snapshot",
    repository: cycle.repository,
    deployedCycle: {
      requirementIssueNumber: cycle.requirementIssueNumber,
      humanMergePullRequestNumber: cycle.humanMergePullRequestNumber,
      reviewedHeadSha: cycle.reviewedHeadSha,
      mergeCommitSha: cycle.mergeCommitSha,
      deployedSha: cycle.deployedSha,
    },
    budget: {
      maxFiles: PRODUCT_EVALUATION_BUDGET.maxFiles,
      maxFileBytes: PRODUCT_EVALUATION_BUDGET.maxFileBytes,
      maxTotalBytes: PRODUCT_EVALUATION_BUDGET.maxTotalBytes,
    },
    files,
    omittedPaths,
    rejectedCandidates: rejected,
    fileCount: files.length,
    totalSnapshotBytes,
  };

  return { ...payload, digestAlgorithm: "sha256", snapshotDigest: sha256(JSON.stringify(payload)) };
}

export function verifyProductSnapshot(snapshot: ProductSnapshot): void {
  if (
    snapshot.schemaVersion !== 1 ||
    snapshot.kind !== "trusted-product-snapshot" ||
    snapshot.digestAlgorithm !== "sha256" ||
    !SHA256.test(snapshot.snapshotDigest)
  ) {
    throw new Error("unsupported product snapshot schema or digest");
  }
  if (snapshot.files.length !== snapshot.fileCount) throw new Error("product snapshot fileCount mismatch");
  if (JSON.stringify(normalizeRejectedCandidates(snapshot.rejectedCandidates)) !== JSON.stringify(snapshot.rejectedCandidates)) {
    throw new Error("product snapshot rejectedCandidates are not canonical");
  }
  const total = snapshot.files.reduce((sum, file) => sum + file.byteLength, 0);
  if (total !== snapshot.totalSnapshotBytes) throw new Error("product snapshot totalSnapshotBytes mismatch");
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

export function productSnapshotArtifactName(snapshot: ProductSnapshot): string {
  return `product-snapshot-issue-${snapshot.deployedCycle.requirementIssueNumber}-pr-${snapshot.deployedCycle.humanMergePullRequestNumber}-${snapshot.snapshotDigest}`;
}

export function productEvaluationReportArtifactName(
  snapshot: ProductSnapshot,
  runId: number,
  runAttempt: number,
): string {
  assertPositiveInteger("runId", runId);
  assertPositiveInteger("runAttempt", runAttempt);
  return `product-evaluation-issue-${snapshot.deployedCycle.requirementIssueNumber}-pr-${snapshot.deployedCycle.humanMergePullRequestNumber}-${runId}-attempt-${runAttempt}`;
}

function normalizeObservation(value: unknown, knownPaths: ReadonlySet<string>): ProductObservation {
  const item = asObject("observation", value);
  assertExactKeys("observation", item, OBSERVATION_KEYS);
  if (typeof item.id !== "string" || !OBSERVATION_ID.test(item.id)) throw new Error("observation id is invalid");
  const statement = boundedText("observation statement", item.statement);
  const evidencePaths = normalizeEvidencePaths("observation evidencePaths", item.evidencePaths, knownPaths);
  return { id: item.id, statement, evidencePaths };
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
  if (typeof value !== "string") throw new Error("candidate title must be a string");
  const title = assertNonempty("candidate title", value).trim();
  if (Buffer.byteLength(title, "utf8") > PRODUCT_EVALUATION_BUDGET.maxTitleBytes) {
    throw new Error("candidate title exceeds maxTitleBytes");
  }
  if (/[\r\n]/.test(title)) throw new Error("candidate title must be a single line");
  // 접두사는 trusted control-plane만 붙인다.
  if (title.startsWith("[")) throw new Error("candidate title must not carry its own bracket tag");
  return title;
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

function normalizeRawEvaluation(
  raw: unknown,
  snapshot: ProductSnapshot,
): { observations: ProductObservation[]; candidate: ProductImprovementProposal | null } {
  const object = asObject("product evaluation", raw);
  assertExactKeys("product evaluation", object, RAW_KEYS);
  if (object.schemaVersion !== 1 || object.kind !== "untrusted-product-evaluation") {
    throw new Error("unsupported product evaluation schema");
  }
  if (typeof object.sourceSnapshotDigest !== "string" || object.sourceSnapshotDigest !== snapshot.snapshotDigest) {
    throw new Error("product evaluation source snapshot digest mismatch");
  }

  const knownPaths = new Set(snapshot.files.map(({ path }) => path));
  if (!Array.isArray(object.observations)) throw new Error("observations must be an array");
  if (object.observations.length > PRODUCT_EVALUATION_BUDGET.maxObservations) {
    throw new Error("observations exceeds maxObservations");
  }
  const observations = object.observations
    .map((item) => normalizeObservation(item, knownPaths))
    .sort((left, right) => left.id.localeCompare(right.id));
  const ids = observations.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new Error("observation IDs must be unique");

  if (!Array.isArray(object.candidates)) throw new Error("candidates must be an array");
  // 한 cycle당 Improvement Candidate는 최대 1개다.
  if (object.candidates.length > 1) throw new Error("product evaluation allows at most one candidate per cycle");
  const candidate = object.candidates.length === 1 ? normalizeProposal(object.candidates[0], knownPaths) : null;

  return { observations, candidate };
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
    schemaVersion: 1,
    kind: "untrusted-product-evaluation-report",
    repository: snapshot.repository,
    source: {
      snapshot: {
        snapshotDigest: snapshot.snapshotDigest,
        artifact: { ...identity.snapshotArtifact },
        sourceRun: { ...identity.sourceRun },
      },
    },
    deployedCycle: { ...snapshot.deployedCycle },
    evaluator: { ...identity.evaluator },
    observations: normalized.observations,
    candidate: normalized.candidate,
  };

  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > PRODUCT_EVALUATION_BUDGET.maxReportBytes) {
    throw new Error("product evaluation report exceeds maxReportBytes");
  }
  return { ...payload, digestAlgorithm: "sha256", reportDigest: sha256(JSON.stringify(payload)) };
}

export function verifyProductEvaluationReport(report: ProductEvaluationReport, snapshot: ProductSnapshot): void {
  if (
    report.schemaVersion !== 1 ||
    report.kind !== "untrusted-product-evaluation-report" ||
    report.digestAlgorithm !== "sha256" ||
    !SHA256.test(report.reportDigest)
  ) {
    throw new Error("unsupported product evaluation report schema or digest");
  }
  if (JSON.stringify(report.deployedCycle) !== JSON.stringify(snapshot.deployedCycle)) {
    throw new Error("product evaluation report deployed-cycle identity mismatch");
  }
  if (report.source.snapshot.snapshotDigest !== snapshot.snapshotDigest) {
    throw new Error("product evaluation report snapshot digest mismatch");
  }

  const regenerated = createProductEvaluationReport(
    snapshot,
    {
      schemaVersion: 1,
      kind: "untrusted-product-evaluation",
      sourceSnapshotDigest: report.source.snapshot.snapshotDigest,
      observations: report.observations,
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
  return [
    "# 역할",
    "당신은 이미 배포된 App을 제품 관점에서 한 번 평가하는 read-only AI Product Evaluator입니다.",
    "아래 Trusted Product Snapshot만 근거로 사용하십시오. GitHub, repository, 웹, 다른 run/artifact를 탐색하거나 추정하지 마십시오.",
    "",
    "# 판단 기준",
    "- 이 App을 처음 쓰는 실제 사용자가 곧바로 아쉬워할 만한 제품 문제만 찾습니다.",
    "- 사용자 가치가 명백하지 않으면 후보를 만들지 않습니다. 억지로 만들지 마십시오.",
    "- 개발 프로세스, CI, 테스트 전략, workflow, 리뷰 방식, 배포 자동화는 평가 대상이 아닙니다.",
    "- Snapshot에 없는 파일은 존재 여부를 단정하지 않습니다.",
    "",
    "# 출력 규칙",
    "- JSON schema에 맞는 JSON만 출력합니다.",
    "- 모든 문장은 한국어로 작성하고 id, 경로, enum 값은 원래 형식을 유지합니다.",
    "- observations와 candidates의 모든 항목은 snapshot에 있는 경로만 evidencePaths로 인용합니다.",
    "- candidates는 최대 1개입니다. 명백한 개선이 없으면 빈 배열을 출력합니다.",
    "- candidates[0].scopePaths는 이 App의 제품 경로만 적습니다. Framework 경로를 적으면 거부됩니다.",
    "- title은 대괄호 태그 없이 개선 내용을 한 줄로 적습니다.",
    "- 코드 수정, Issue/PR 생성, workflow 실행, 승인, Merge를 실행하지 않습니다.",
    "- 이 평가는 사람이 판단할 제안일 뿐 authority가 아닙니다.",
    "- 아래 '이미 기각된 후보'는 제품 책임자가 거절한 방향입니다. 같은 문제를 다른 표현, 부분 적용, 우회 방식으로 다시 제안하지 마십시오.",
    "",
    "# 이미 기각된 후보 (다시 제안 금지)",
    ...(snapshot.rejectedCandidates.length === 0
      ? ["없음"]
      : snapshot.rejectedCandidates.map(({ issueNumber, title, reason }) =>
          `- #${issueNumber} ${title}${reason ? ` — 기각 사유: ${reason}` : ""}`,
        )),
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

  return {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "kind", "sourceSnapshotDigest", "observations", "candidates"],
    properties: {
      schemaVersion: { type: "integer", const: 1 },
      kind: { type: "string", const: "untrusted-product-evaluation" },
      sourceSnapshotDigest: { type: "string", const: snapshot.snapshotDigest },
      observations: {
        type: "array",
        maxItems: PRODUCT_EVALUATION_BUDGET.maxObservations,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "statement", "evidencePaths"],
          properties: {
            id: { type: "string", pattern: "^[a-z][a-z0-9._-]{0,127}$" },
            statement: boundedString,
            evidencePaths: evidencePathsSchema,
          },
        },
      },
      candidates: {
        type: "array",
        maxItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "title",
            "problem",
            "desiredOutcome",
            "acceptanceExample",
            "constraint",
            "scopePaths",
            "evidencePaths",
            "confidence",
          ],
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
            confidence: { type: "string", enum: ["high", "medium", "low"] },
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
  return withoutPrefix.trim().replaceAll(/\s+/gu, " ").toLowerCase();
}

export function improvementIssueTitle(candidate: ProductImprovementProposal): string {
  return `${SELF_IMPROVEMENT_TITLE_PREFIX} ${candidate.title}`;
}

export function renderImprovementIssueBody(report: ProductEvaluationReport): string {
  const candidate = report.candidate;
  if (candidate === null) throw new Error("cannot render an improvement issue without a candidate");
  const cycle = report.deployedCycle;
  const list = (items: readonly string[]): string => items.map((item) => `- \`${item}\``).join("\n");

  return [
    `<!-- ai-dev-framework:PRODUCT_IMPROVEMENT cycle-issue=${cycle.requirementIssueNumber} cycle-pr=${cycle.humanMergePullRequestNumber} snapshot=${report.source.snapshot.snapshotDigest} -->`,
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
    "---",
    "### HumanStatus: IMPROVEMENT_CANDIDATE",
    "**현재 상황:** 배포된 App을 제품 관점으로 평가해 만든 개선 후보입니다. 아직 아무 구현도 시작하지 않았습니다.",
    "**다음 행동:** read-only AI PLAN이 이 Issue에 자동으로 제안됩니다. PLAN을 읽고 진행하려면 `PLAN-승인` 댓글을 남기고, 진행하지 않으려면 사유를 남기고 `not_planned`로 닫으세요. PLAN-승인 이후에만 구현이 시작됩니다.",
    [
      `- 평가한 cycle: Issue #${cycle.requirementIssueNumber} / Human Merge PR #${cycle.humanMergePullRequestNumber}`,
      `- 평가한 배포 SHA: \`${cycle.deployedSha}\``,
      `- 이 cycle의 merge commit: \`${cycle.mergeCommitSha}\``,
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
 * - 후보가 없으면 만들지 않는다.
 * - 열린 Self-Improvement Issue가 하나라도 있으면 사람이 처리할 때까지 더 쌓지 않는다.
 * - 열림/닫힘과 무관하게 같은 제목이 이미 있으면 만들지 않는다.
 */
export function decideImprovementIssue(
  report: ProductEvaluationReport,
  existingIssues: readonly ExistingIssue[],
): ImprovementIssueDecision {
  const candidate = report.candidate;
  if (candidate === null) {
    return { action: "skip", reason: "제품 평가에서 명백한 개선 후보를 찾지 못했습니다" };
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
