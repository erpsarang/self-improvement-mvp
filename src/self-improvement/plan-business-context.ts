import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { TextDecoder } from "node:util";
import * as ts from "typescript";
import {
  PLAN_CONTEXT_MAX_BYTES,
  PLAN_CONTEXT_MAX_FILES,
  PLAN_CONTEXT_MAX_FILE_BYTES,
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

function importedRuntimeSources(testPath: string, testText: string, sourcePaths: readonly string[]): string[] {
  const identities = new Map(sourcePaths.map((path) => [modulePathIdentity(path), path] as const));
  const result: string[] = [];
  for (const specifier of relativeImportSpecifiers(testPath, testText)) {
    const resolved = normalize(join(dirname(testPath), specifier)).replace(/\\/g, "/");
    const source = identities.get(modulePathIdentity(resolved));
    if (source && !result.includes(source)) result.push(source);
  }
  return result.sort((a, b) => sourceAffinity(testPath, b) - sourceAffinity(testPath, a) || a.localeCompare(b));
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
  maxFileBytes: number,
): PlanContextFile[] {
  const terms = requirementTerms(requirement);
  const tests = walkFiles(target, "test")
    .filter(isTestLike)
    .map((path) => {
      const text = decodeText(join(target, path));
      return text === null ? null : { path, text, score: relevanceScore(path, text, terms) };
    })
    .filter((entry): entry is { path: string; text: string; score: number } => entry !== null && entry.score > 0)
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

  const applicationRelations = relations.filter((relation) => relation.application);
  const pool = applicationRelations.length > 0 ? applicationRelations : relations;
  pool.sort((a, b) =>
    b.test.score - a.test.score
    || b.affinity - a.affinity
    || a.sourceRank - b.sourceRank
    || a.test.path.localeCompare(b.test.path)
    || a.sourcePath.localeCompare(b.sourcePath));
  const best = pool[0]!;

  const source = contextFile(target, best.sourcePath, [], maxFileBytes);
  const test = contextFile(target, best.test.path, terms, maxFileBytes);
  return source && test ? [source, test] : [];
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

  const candidates = businessRelationCandidates(requirement, target, maxFileBytes).slice(0, maxFiles);
  if (candidates.length < 2) return context;

  const candidatePaths = new Set(candidates.map((file) => file.path));
  const retained = context.files.filter((file) => !candidatePaths.has(file.path));
  const files = [...candidates, ...retained].slice(0, maxFiles);
  let totalBytes = files.reduce((sum, file) => sum + file.byteLength, 0);
  while (totalBytes > maxBytes && files.length > candidates.length) {
    const removed = files.pop()!;
    totalBytes -= removed.byteLength;
  }
  if (totalBytes > maxBytes) throw new Error("Business relation Context Pack cannot fit within trusted budget");

  return rebind(context.repository, context.sha, files);
}
