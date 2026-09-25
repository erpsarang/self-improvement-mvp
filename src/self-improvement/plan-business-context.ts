import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { TextDecoder } from "node:util";
import * as ts from "typescript";
import {
  PLAN_CONTEXT_MAX_BYTES,
  PLAN_CONTEXT_MAX_FILES,
  PLAN_CONTEXT_MAX_FILE_BYTES,
  PLAN_IMPLEMENT_MAX_FILES,
  verifyPlanContextPack,
  type PlanContextFile,
  type PlanContextPack,
  type PlanContextPackPayload,
} from "./planner.js";

interface BusinessContextBudget {
  readonly maxFiles?: number;
  readonly maxBytes?: number;
  readonly maxFileBytes?: number;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

function isTestLike(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.startsWith("test/") || /\.(test|spec)\.[^/]+$/.test(lower);
}

function isRuntimeSource(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.startsWith("src/") && !/\.(test|spec)\.[^/]+$/.test(lower);
}

function isFrameworkSource(path: string): boolean {
  return path.toLowerCase().startsWith("src/self-improvement/");
}

function isProjectExecutionContext(path: string): boolean {
  return path === "package.json" || path === "tsconfig.json";
}

function walkFiles(target: string, root: string): string[] {
  const absoluteRoot = join(target, root);
  if (!existsSync(absoluteRoot)) return [];
  const realTarget = realpathSync(target);
  const realRoot = realpathSync(absoluteRoot);
  const relRoot = relative(realTarget, realRoot);
  if (relRoot.startsWith("..") || isAbsolute(relRoot)) throw new Error("Business context root escapes target");

  const paths: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(dir, entry.name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Business context refuses symlink: ${absolute}`);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) paths.push(relative(target, absolute).replaceAll("\\", "/"));
    }
  };
  walk(realRoot);
  return paths;
}

function decodeText(path: string): string | null {
  const bytes = readFileSync(path);
  if (bytes.includes(0)) return null;
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

function requirementTerms(requirement: string): string[] {
  const terms = requirement.toLowerCase().match(/[a-z0-9_.-]{2,}|[가-힣]{2,}/g) ?? [];
  return [...new Set(terms)].sort((a, b) => a.localeCompare(b));
}

function requirementRuntimePathHints(requirement: string, sourcePaths: readonly string[], contextPaths: ReadonlySet<string>): string[] {
  const sourceSet = new Set(sourcePaths);
  const result: string[] = [];
  for (const match of requirement.matchAll(/`([A-Za-z0-9._/-]{3,500})`/g)) {
    const path = match[1]!;
    if (!path.startsWith("src/") || isFrameworkSource(path) || !sourceSet.has(path) || !contextPaths.has(path)) continue;
    if (!result.includes(path)) result.push(path);
  }
  return result;
}

function occurrences(text: string, term: string): number {
  let count = 0;
  let from = 0;
  while (count < 5) {
    const index = text.indexOf(term, from);
    if (index < 0) break;
    count += 1;
    from = index + term.length;
  }
  return count;
}

function relevanceScore(path: string, text: string, terms: readonly string[]): number {
  const lowerPath = path.toLowerCase();
  const lowerText = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (lowerPath.includes(term)) score += 20;
    const hits = occurrences(lowerText, term);
    if (hits > 0) score += 4 + Math.min(5, hits);
  }
  return score;
}

function modulePathIdentity(path: string): string {
  return path.replace(/\\/g, "/").replace(/\.(?:[cm]?[jt]sx?)$/i, "");
}

function scriptKind(path: string): ts.ScriptKind {
  const lower = path.toLowerCase();
  if (lower.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (lower.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

// Parse syntax only. Target code is never imported or executed, and strings/comments cannot masquerade as imports.
function relativeImportSpecifiers(path: string, text: string): string[] {
  const sourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
  const result: string[] = [];
  const add = (node: ts.Expression | undefined): void => {
    if (!node || !ts.isStringLiteralLike(node)) return;
    const specifier = node.text;
    if (specifier.startsWith(".") && !result.includes(specifier)) result.push(specifier);
  };

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) add(statement.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)) {
      add(statement.moduleReference.expression);
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const requireCall = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (dynamicImport || requireCall) add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return result;
}


function isImportMetaUrl(node: ts.Expression | undefined): boolean {
  return !!node
    && ts.isPropertyAccessExpression(node)
    && node.name.text === "url"
    && ts.isMetaProperty(node.expression)
    && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
    && node.expression.name.text === "meta";
}

/**
 * VM/test harness가 source를 정적 import하지 않고 파일 내용 자체를 읽어 실행하는 관계를 찾는다.
 * 오탐을 피하기 위해 readFileSync(new URL("<relative literal>", import.meta.url), ...) 형태만 인정한다.
 */
function relativeLiteralSourceReadSpecifiers(path: string, text: string): string[] {
  const sourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
  const result: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const readFileSyncCall = ts.isIdentifier(node.expression) && node.expression.text === "readFileSync";
      const first = node.arguments[0];
      if (
        readFileSyncCall
        && first
        && ts.isNewExpression(first)
        && ts.isIdentifier(first.expression)
        && first.expression.text === "URL"
        && first.arguments?.length === 2
        && ts.isStringLiteralLike(first.arguments[0]!)
        && first.arguments[0]!.text.startsWith(".")
        && isImportMetaUrl(first.arguments[1])
      ) {
        const specifier = first.arguments[0]!.text;
        if (!result.includes(specifier)) result.push(specifier);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return result;
}

function pathStem(path: string): string {
  const name = modulePathIdentity(path).split("/").at(-1) ?? "";
  return name.replace(/\.(?:test|spec)$/i, "");
}

function sourceAffinity(testPath: string, sourcePath: string): number {
  const testStem = pathStem(testPath);
  const sourceStem = pathStem(sourcePath);
  if (testStem === sourceStem) return 2;
  if (testStem.includes(sourceStem) || sourceStem.includes(testStem)) return 1;
  return 0;
}

function runtimeSourcesFromSpecifiers(
  testPath: string,
  specifiers: readonly string[],
  sourcePaths: readonly string[],
): string[] {
  const identities = new Map(sourcePaths.map((path) => [modulePathIdentity(path), path] as const));
  const result: string[] = [];
  for (const specifier of specifiers) {
    const resolved = normalize(join(dirname(testPath), specifier)).replace(/\\/g, "/");
    const source = identities.get(modulePathIdentity(resolved));
    if (source && !result.includes(source)) result.push(source);
  }
  return result.sort((a, b) => sourceAffinity(testPath, b) - sourceAffinity(testPath, a) || a.localeCompare(b));
}

// 테스트 파일에서는 source를 읽어 VM에서 실행하는 harness도 import와 같은 영향 관계다 (#281).
// source 사이의 의존 분석 의미는 바꾸지 않도록 테스트 파일에만 적용한다.
// 이 관계는 이미 Context에 있는 파일 사이에서만 쓰인다. Context 보호 목록을 늘리면 8개 한도를 넘어
// 업무 Context 보강 전체가 생략되므로 보호 목록에는 더하지 않는다 (#282 실제 App 트리 재현).
function importedRuntimeSources(testPath: string, testText: string, sourcePaths: readonly string[]): string[] {
  const specifiers = relativeImportSpecifiers(testPath, testText);
  if (isTestLike(testPath)) specifiers.push(...relativeLiteralSourceReadSpecifiers(testPath, testText));
  return runtimeSourcesFromSpecifiers(testPath, specifiers, sourcePaths);
}

/**
 * App runtime source의 가장 강한 기존 직접 테스트(해당 source를 import하는 exact-stem 테스트)를 돌려준다.
 * #124의 보호 규칙과 같은 판별이다. Framework source이거나 그런 테스트가 없으면 null이다.
 */
export function strongestDirectTest(target: string, sourcePath: string): string | null {
  if (!isRuntimeSource(sourcePath) || isFrameworkSource(sourcePath)) return null;
  const sourcePaths = walkFiles(target, "src").filter(isRuntimeSource);
  if (!sourcePaths.includes(sourcePath)) return null;
  const direct = walkFiles(target, "test")
    .filter(isTestLike)
    .filter((path) => sourceAffinity(path, sourcePath) === 2)
    .sort((a, b) => a.localeCompare(b))
    .find((path) => {
      const text = decodeText(join(target, path));
      return text !== null && importedRuntimeSources(path, text, sourcePaths).includes(sourcePath);
    });
  return direct ?? null;
}

function selectedRelationProtection(target: string, context: PlanContextPack): ReadonlySet<string> {
  const contextPaths = new Set(context.files.map((file) => file.path));
  const sourcePaths = walkFiles(target, "src").filter(isRuntimeSource);
  const protectedPaths = new Set<string>();

  for (const file of context.files) {
    if (isProjectExecutionContext(file.path)) protectedPaths.add(file.path);
    if (!isTestLike(file.path)) continue;
    const text = decodeText(join(target, file.path));
    if (text === null) continue;
    for (const sourcePath of importedRuntimeSources(file.path, text, sourcePaths)) {
      if (!contextPaths.has(sourcePath) || isFrameworkSource(sourcePath)) continue;
      protectedPaths.add(sourcePath);
      protectedPaths.add(file.path);
    }
  }

  // The primary selector can surface an App runtime without its direct test when
  // later context competition is tight. Recover only the strongest exact-stem
  // direct test so trusted scope validation can still require evidence for that
  // existing test path.
  for (const file of context.files) {
    const direct = strongestDirectTest(target, file.path);
    if (!direct) continue;
    protectedPaths.add(file.path);
    protectedPaths.add(direct);
  }
  return protectedPaths;
}

function trimUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low);
}

function excerpt(text: string, terms: readonly string[], maxBytes: number): { content: string; startOffset: number } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { content: text, startOffset: 0 };
  const lower = text.toLowerCase();
  const indexes = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0);
  const focus = indexes.length > 0 ? Math.min(...indexes) : 0;
  const estimatedChars = Math.min(text.length, maxBytes);
  const startOffset = Math.max(0, focus - Math.floor(estimatedChars / 3));
  return { content: trimUtf8(text.slice(startOffset), maxBytes), startOffset };
}

function contextFile(target: string, path: string, terms: readonly string[], maxFileBytes: number): PlanContextFile | null {
  const absolute = join(target, path);
  if (!existsSync(absolute)) return null;
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new Error(`Business context refuses symlink: ${absolute}`);
  if (!stat.isFile()) return null;
  const text = decodeText(absolute);
  if (text === null) return null;
  const part = excerpt(text, terms, maxFileBytes);
  const byteLength = Buffer.byteLength(part.content, "utf8");
  if (byteLength < 1 || byteLength > PLAN_CONTEXT_MAX_FILE_BYTES) return null;
  return {
    evidenceId: "E1",
    path,
    startOffset: part.startOffset,
    byteLength,
    digestAlgorithm: "sha256",
    contentDigest: createHash("sha256").update(part.content, "utf8").digest("hex"),
    content: part.content,
  };
}

function payload(repository: string, sha: string, files: readonly PlanContextFile[]): PlanContextPackPayload {
  return {
    schemaVersion: 1,
    kind: "trusted-plan-context-pack",
    repository,
    sha,
    files,
    totalBytes: files.reduce((sum, file) => sum + file.byteLength, 0),
  };
}

function rebind(repository: string, sha: string, files: readonly PlanContextFile[]): PlanContextPack {
  const rebound = files.map((file, index) => ({ ...file, evidenceId: `E${index + 1}` }));
  const base = payload(repository, sha, rebound);
  const contextDigest = createHash("sha256").update(JSON.stringify(base), "utf8").digest("hex");
  const pack: PlanContextPack = { ...base, digestAlgorithm: "sha256", contextDigest };
  verifyPlanContextPack(pack);
  return pack;
}

function businessRelationCandidates(
  requirement: string,
  target: string,
  contextPaths: ReadonlySet<string>,
  maxFiles: number,
  maxFileBytes: number,
): PlanContextFile[] {
  const terms = requirementTerms(requirement);
  const allTests = walkFiles(target, "test")
    .filter(isTestLike)
    .map((path) => {
      const text = decodeText(join(target, path));
      return text === null ? null : { path, text, score: relevanceScore(path, text, terms) };
    })
    .filter((entry): entry is { path: string; text: string; score: number } => entry !== null);
  const tests = allTests
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  if (tests.length === 0) return [];

  const sourcePaths = walkFiles(target, "src").filter(isRuntimeSource);
  const relations = tests.flatMap((test) => importedRuntimeSources(test.path, test.text, sourcePaths).map((sourcePath, sourceRank) => ({
    test,
    sourcePath,
    sourceRank,
    affinity: sourceAffinity(test.path, sourcePath),
    application: !isFrameworkSource(sourcePath),
  })));
  if (relations.length === 0) return [];

  const expandOneHop = (
    sourcePath: string,
    primaryTest: { path: string; text: string; score: number },
  ): PlanContextFile[] => {
    const selected: PlanContextFile[] = [];
    const selectedPaths = new Set<string>();
    const addPath = (path: string, evidenceTerms: readonly string[]): void => {
      if (selected.length >= maxFiles || selectedPaths.has(path)) return;
      const file = contextFile(target, path, evidenceTerms, maxFileBytes);
      if (!file) return;
      selected.push(file);
      selectedPaths.add(path);
    };

    addPath(sourcePath, []);
    addPath(primaryTest.path, terms);
    if (selected.length >= maxFiles || isFrameworkSource(sourcePath)) return selected;

    const sourceText = decodeText(join(target, sourcePath));
    if (sourceText === null) return selected;
    const dependencies = importedRuntimeSources(sourcePath, sourceText, sourcePaths)
      .filter((path) => path !== sourcePath && !isFrameworkSource(path));

    for (const dependency of dependencies) {
      if (selected.length >= maxFiles) break;
      addPath(dependency, []);
      if (selected.length >= maxFiles) break;

      const directTests = allTests
        .filter((test) => importedRuntimeSources(test.path, test.text, sourcePaths).includes(dependency))
        .sort((a, b) =>
          sourceAffinity(b.path, dependency) - sourceAffinity(a.path, dependency)
          || b.score - a.score
          || a.path.localeCompare(b.path));
      if (directTests[0]) addPath(directTests[0].path, terms);
    }
    return selected;
  };

  const runtimeHints = requirementRuntimePathHints(requirement, sourcePaths, contextPaths);
  const hintedSource = runtimeHints.find((path) => relations.some((relation) => relation.sourcePath === path));
  if (hintedSource) {
    const hintedRelations = relations
      .filter((relation) => relation.sourcePath === hintedSource)
      .sort((a, b) =>
        b.affinity - a.affinity
        || b.test.score - a.test.score
        || a.sourceRank - b.sourceRank
        || a.test.path.localeCompare(b.test.path));
    const best = hintedRelations[0]!;
    return expandOneHop(hintedSource, best.test);
  }
  if (runtimeHints.length > 0) return [];

  const applicationRelations = relations.filter((relation) => relation.application);
  const pool = applicationRelations.length > 0 ? applicationRelations : relations;
  pool.sort((a, b) =>
    b.test.score - a.test.score
    || b.affinity - a.affinity
    || a.sourceRank - b.sourceRank
    || a.test.path.localeCompare(b.test.path)
    || a.sourcePath.localeCompare(b.sourcePath));
  const best = pool[0]!;

  return expandOneHop(best.sourcePath, best.test);
}

export function augmentPlanContextWithBusinessRelations(
  requirement: string,
  target: string,
  context: PlanContextPack,
  budget: BusinessContextBudget = {},
): PlanContextPack {
  verifyPlanContextPack(context);
  const maxFiles = Math.min(budget.maxFiles ?? PLAN_CONTEXT_MAX_FILES, PLAN_CONTEXT_MAX_FILES);
  const maxBytes = Math.min(budget.maxBytes ?? PLAN_CONTEXT_MAX_BYTES, PLAN_CONTEXT_MAX_BYTES);
  const maxFileBytes = Math.min(budget.maxFileBytes ?? PLAN_CONTEXT_MAX_FILE_BYTES, PLAN_CONTEXT_MAX_FILE_BYTES);
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) {
    throw new Error("Invalid business context budget");
  }

  const contextPaths = new Set(context.files.map((file) => file.path));
  const candidates = businessRelationCandidates(requirement, target, contextPaths, maxFiles, maxFileBytes).slice(0, maxFiles);
  if (candidates.length < 2) return context;

  const protectedPaths = selectedRelationProtection(target, context);
  const terms = requirementTerms(requirement);
  const protectedFiles: PlanContextFile[] = [];
  const protectedSeen = new Set<string>();
  const addProtected = (file: PlanContextFile | null): void => {
    if (!file || protectedSeen.has(file.path)) return;
    protectedFiles.push(file);
    protectedSeen.add(file.path);
  };
  for (const file of context.files) {
    if (protectedPaths.has(file.path)) addProtected(file);
  }
  for (const path of protectedPaths) {
    if (protectedSeen.has(path)) continue;
    addProtected(contextFile(target, path, terms, maxFileBytes));
  }
  const protectedBytes = protectedFiles.reduce((sum, file) => sum + file.byteLength, 0);
  if (protectedFiles.length > maxFiles || protectedBytes > maxBytes) return context;

  const additionalCandidates = candidates.filter((file) => !protectedPaths.has(file.path));
  const candidatePaths = new Set(additionalCandidates.map((file) => file.path));
  const ordinaryRetained = context.files.filter(
    (file) => !protectedPaths.has(file.path) && !candidatePaths.has(file.path),
  );

  // Protected source/test/package evidence is authoritative for the already
  // selected runtime. Business augmentation only spends the remaining budget.
  let selectedCandidates = additionalCandidates.slice(0, Math.max(0, maxFiles - protectedFiles.length));
  while (
    selectedCandidates.length >= 2 &&
    protectedBytes + selectedCandidates.reduce((sum, file) => sum + file.byteLength, 0) > maxBytes
  ) {
    selectedCandidates = selectedCandidates.slice(0, -1);
  }

  const required = [...selectedCandidates, ...protectedFiles];
  const files = [...required, ...ordinaryRetained].slice(0, maxFiles);
  const requiredCount = required.length;
  let totalBytes = files.reduce((sum, file) => sum + file.byteLength, 0);
  while (totalBytes > maxBytes && files.length > requiredCount) {
    const removed = files.pop()!;
    totalBytes -= removed.byteLength;
  }
  if (totalBytes > maxBytes) return context;

  // Even when no additional source/test pair fits, returning the protected pack
  // is useful because it can restore a missing exact direct test for validation.
  return rebind(context.repository, context.sha, files);
}

export interface ImpactedTestCompanionResult {
  readonly plan: Record<string, unknown>;
  readonly companions: readonly string[];
}

function isFrameworkTest(path: string): boolean {
  return path.toLowerCase().startsWith("test/self-improvement/");
}

/**
 * 변경 대상 App 소스를 import하는 기존 테스트를 trusted 단계가 allowedPaths에 결정적으로 추가한다.
 *
 * Planner가 Context Pack에서 그 테스트를 봤더라도 "수정이 필요할 때만 포함"이라는 판단을 틀리면
 * Worker는 scope 밖 테스트를 고칠 수 없어 deterministic CI가 fail-closed 된다
 * (classic-paragraph-wit#9 1차 PLAN). package-lock.json companion과 같은 원칙으로,
 * AI 판단이 아니라 import graph로 정한다. 사람은 PLAN.md에서 보강된 최종 scope를 보고 승인한다.
 *
 * ready=false이거나 scope 모양이 맞지 않으면 손대지 않고 validatePlan이 판단하게 둔다.
 */
export function applyImpactedTestCompanions(
  target: string,
  context: PlanContextPack,
  rawPlan: unknown,
): ImpactedTestCompanionResult {
  const untouched = { plan: rawPlan as Record<string, unknown>, companions: [] as string[] };
  if (!rawPlan || typeof rawPlan !== "object" || Array.isArray(rawPlan)) return untouched;
  const plan = rawPlan as Record<string, unknown>;
  const scope = plan.implementationScope;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return untouched;
  const scopeRecord = scope as Record<string, unknown>;
  const isStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === "string");
  if (scopeRecord.ready !== true || !isStringArray(scopeRecord.allowedPaths)) return untouched;
  const allowedPaths = scopeRecord.allowedPaths;
  const contextPaths = isStringArray(scopeRecord.contextPaths) ? scopeRecord.contextPaths : [];
  const requiredChanges = isStringArray(scopeRecord.requiredChanges) ? scopeRecord.requiredChanges : [];

  const sourcePaths = walkFiles(target, "src").filter(isRuntimeSource);
  const changedSources = new Set(
    allowedPaths.filter((path) =>
      isRuntimeSource(path) && !isFrameworkSource(path) && sourcePaths.includes(path) && existsSync(join(target, path)),
    ),
  );
  if (changedSources.size === 0) return untouched;

  // Planner가 본 Context Pack 안의 기존 테스트만 대상으로 한다. 존재하는 allowedPath는
  // Context Pack에 있어야 한다는 validatePlan 규칙과 같은 경계다.
  const companions: string[] = [];
  for (const file of context.files) {
    const path = file.path;
    if (!isTestLike(path) || isFrameworkTest(path) || allowedPaths.includes(path)) continue;
    if (!existsSync(join(target, path))) continue;
    const text = decodeText(join(target, path));
    if (text === null) continue;
    const imported = importedRuntimeSources(path, text, sourcePaths);
    if (imported.some((source) => changedSources.has(source)) && !companions.includes(path)) companions.push(path);
  }
  companions.sort((a, b) => a.localeCompare(b));
  if (companions.length === 0) return untouched;

  if (allowedPaths.length + companions.length > PLAN_IMPLEMENT_MAX_FILES) {
    throw new Error(
      `PLAN scope cannot hold existing tests that import changed sources within ${PLAN_IMPLEMENT_MAX_FILES} bounded paths: ${companions.join(", ")}`,
    );
  }

  const companionNote =
    `기존 테스트 ${companions.map((path) => `\`${path}\``).join(", ")}는 변경 대상 소스를 import하므로 새 동작에 맞게 기대값을 갱신한다. 테스트를 삭제하거나 건너뛰지 않는다.`;
  const nextRequiredChanges = requiredChanges.length < 8 ? [...requiredChanges, companionNote] : requiredChanges;

  return {
    plan: {
      ...plan,
      implementationScope: {
        ...scopeRecord,
        allowedPaths: [...allowedPaths, ...companions],
        contextPaths: contextPaths.filter((path) => !companions.includes(path)),
        requiredChanges: nextRequiredChanges,
      },
    },
    companions,
  };
}
