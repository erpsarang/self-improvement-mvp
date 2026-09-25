import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { TextDecoder } from "node:util";
import {
  PLAN_CONTEXT_MAX_BYTES,
  PLAN_CONTEXT_MAX_FILES,
  PLAN_CONTEXT_MAX_FILE_BYTES,
  verifyPlanContextPack,
  type PlanContextFile,
  type PlanContextPack,
  type PlanContextPackPayload,
} from "./planner.js";
import { strongestDirectTest } from "./plan-business-context.js";

interface ExplicitPathContextBudget {
  readonly maxFiles?: number;
  readonly maxBytes?: number;
  readonly maxFileBytes?: number;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

// `/` 없는 토큰(`package.json` 등)도 후보로 둔다. 실재하는 일반 파일인지는 explicitContextFile이 확인하므로
// 존재하지 않는 이름이나 디렉터리는 지금처럼 건너뛴다 (#273 재PLAN run 36114594331).
function requirementPathAnchors(requirement: string): string[] {
  const anchors: string[] = [];
  for (const match of requirement.matchAll(/`([A-Za-z0-9._/-]{3,500})`/g)) {
    const path = match[1]!;
    if (
      isAbsolute(path) ||
      path.includes("\\") ||
      path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      continue;
    }
    if (!anchors.includes(path)) anchors.push(path);
  }
  return anchors;
}

function requirementTerms(requirement: string): string[] {
  const terms = requirement.toLowerCase().match(/[a-z0-9_.-]{2,}|[가-힣]{2,}/g) ?? [];
  return [...new Set(terms)].sort((a, b) => a.localeCompare(b));
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

// 사람이 backtick으로 적은 식별자(`name`, `name(...)`)를 요구 등장 순서대로 돌려준다.
function requirementSymbolAnchors(requirement: string): string[] {
  const symbols: string[] = [];
  for (const match of requirement.matchAll(/`([A-Za-z_$][A-Za-z0-9_$]{2,200})(?:\([^`]*\))?`/g)) {
    const symbol = match[1]!;
    if (!symbols.includes(symbol)) symbols.push(symbol);
  }
  return symbols;
}

// 명시된 symbol 중 이 파일에 있는 첫 symbol의 선언 위치(없으면 첫 등장 위치)를 돌려준다.
function symbolFocus(text: string, symbols: readonly string[]): number | null {
  for (const symbol of symbols) {
    const escaped = symbol.replace(/\$/g, "\\$");
    const declaration = new RegExp(`\\b(?:function|const|let|var|class|interface|type|enum)\\s+${escaped}(?![A-Za-z0-9_$])`).exec(text);
    if (declaration) return declaration.index;
    const usage = new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`).exec(text);
    if (usage) return usage.index;
  }
  return null;
}

// 큰 파일은 명시 symbol을 중심으로 발췌한다. 흔한 요구 단어는 대개 파일 첫머리에 있어
// 수정 대상 함수가 창 밖으로 밀려났다 (#273: createPlanPrompt가 20KB 창 밖). symbol이 없으면 기존 동작 그대로다.
function excerpt(
  text: string,
  terms: readonly string[],
  symbols: readonly string[],
  maxBytes: number,
): { content: string; startOffset: number } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { content: text, startOffset: 0 };
  const lower = text.toLowerCase();
  const indexes = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0);
  const focus = symbolFocus(text, symbols) ?? (indexes.length > 0 ? Math.min(...indexes) : 0);
  const estimatedChars = Math.min(text.length, maxBytes);
  const startOffset = Math.max(0, focus - Math.floor(estimatedChars / 3));
  return { content: trimUtf8(text.slice(startOffset), maxBytes), startOffset };
}

function explicitContextFile(
  target: string,
  path: string,
  terms: readonly string[],
  symbols: readonly string[],
  maxBytes: number,
): PlanContextFile | null {
  const absolute = join(target, path);
  if (!existsSync(absolute)) return null;
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new Error(`Explicit PLAN context refuses symlink: ${path}`);
  if (!stat.isFile()) return null;

  const realTarget = realpathSync(target);
  const realFile = realpathSync(absolute);
  const rel = relative(realTarget, realFile);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Explicit PLAN context path escapes target: ${path}`);
  }

  const text = decodeText(realFile);
  if (text === null) return null;
  const part = excerpt(text, terms, symbols, maxBytes);
  const byteLength = Buffer.byteLength(part.content, "utf8");
  if (byteLength < 1) return null;
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

export function augmentPlanContextWithExplicitPaths(
  requirement: string,
  target: string,
  context: PlanContextPack,
  budget: ExplicitPathContextBudget = {},
): PlanContextPack {
  verifyPlanContextPack(context);
  const maxFiles = Math.min(budget.maxFiles ?? PLAN_CONTEXT_MAX_FILES, PLAN_CONTEXT_MAX_FILES);
  const maxBytes = Math.min(budget.maxBytes ?? PLAN_CONTEXT_MAX_BYTES, PLAN_CONTEXT_MAX_BYTES);
  const maxFileBytes = Math.min(budget.maxFileBytes ?? PLAN_CONTEXT_MAX_FILE_BYTES, PLAN_CONTEXT_MAX_FILE_BYTES);
  if (
    !Number.isSafeInteger(maxFiles) || maxFiles < 1 ||
    !Number.isSafeInteger(maxBytes) || maxBytes < 1 ||
    !Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1
  ) {
    throw new Error("Invalid explicit PLAN context budget");
  }

  const terms = requirementTerms(requirement);
  const symbols = requirementSymbolAnchors(requirement);
  const explicit: PlanContextFile[] = [];
  let explicitBytes = 0;
  for (const path of requirementPathAnchors(requirement)) {
    if (explicit.length >= maxFiles || explicitBytes >= maxBytes) break;
    const remaining = maxBytes - explicitBytes;
    const file = explicitContextFile(target, path, terms, symbols, Math.min(maxFileBytes, remaining));
    if (!file) continue;
    explicit.push(file);
    explicitBytes += file.byteLength;
  }
  if (explicit.length === 0) return context;

  // 명시된 변경 대상 App source의 기존 직접 테스트를 함께 넣는다 (#124 규칙과 같은 판별, source당 최대 1개).
  // 앞선 보강(AI 호출 지점 등)이 pack을 다시 만들며 업무 관계 보강이 보호한 source/직접 테스트 쌍을 버릴 수 있어,
  // 마지막 단계에서 Planner가 그 테스트를 실제로 보도록 보장한다 (#259 재PLAN run 36086224421).
  const explicitPaths = new Set(explicit.map((file) => file.path));
  for (const file of [...explicit]) {
    if (explicit.length >= maxFiles || explicitBytes >= maxBytes) break;
    const testPath = strongestDirectTest(target, file.path);
    if (!testPath || explicitPaths.has(testPath)) continue;
    const remaining = maxBytes - explicitBytes;
    const test = explicitContextFile(target, testPath, terms, symbols, Math.min(maxFileBytes, remaining));
    if (!test) continue;
    explicit.push(test);
    explicitPaths.add(testPath);
    explicitBytes += test.byteLength;
  }

  const files = [...explicit];
  const paths = new Set(files.map((file) => file.path));
  let totalBytes = explicitBytes;
  for (const file of context.files) {
    if (files.length >= maxFiles) break;
    if (paths.has(file.path) || totalBytes + file.byteLength > maxBytes) continue;
    files.push(file);
    paths.add(file.path);
    totalBytes += file.byteLength;
  }

  return rebind(context.repository, context.sha, files);
}
