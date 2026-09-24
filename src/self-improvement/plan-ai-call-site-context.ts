import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { TextDecoder } from "node:util";
import { needsAiExecutionPlanContext } from "./plan-context-policy.js";
import {
  PLAN_CONTEXT_MAX_BYTES,
  PLAN_CONTEXT_MAX_FILES,
  PLAN_CONTEXT_MAX_FILE_BYTES,
  verifyPlanContextPack,
  type PlanContextFile,
  type PlanContextPack,
  type PlanContextPackPayload,
} from "./planner.js";

/**
 * Framework 자체 요구(AI 호출·모델·비용·effort 정책)를 위한 결정적 Context Pack 보강.
 *
 * 기본 선택기는 App 코드(소스 + 직접 테스트 쌍)를 전제로 어휘 점수와 역할 슬롯(workflow 1개)을 쓴다.
 * Framework repo에서 "AI 호출 정책" 요구의 변경 단위는 여러 workflow의 AI 호출 step인데, 이 구조에서는
 * 호출 지점이 1개만 들어가고 나머지 슬롯은 lifecycle 단어를 많이 쓴 파일이 차지한다
 * (self-improvement-mvp #244 PLAN run 35968565239: 호출 지점 8곳 중 1곳만 문맥에 포함 → ready=false).
 *
 * 이 보강은 canonical Framework source tree에서만, 요구가 AI 실행 정책을 다룰 때만 발동하며,
 * AI 호출 step을 담은 workflow마다 그 step 주변의 작은 창 하나를 evidence로 넣는다.
 * 새 AI 호출은 없고, 파일 시스템 밖의 정보(모델 식별자, 가격 등)는 만들지 않는다.
 */

export const AI_CALL_SITE_CONTEXT_MAX_FILE_BYTES = 3_000;
const CANONICAL_FRAMEWORK_PACKAGE_NAME = "self-improvement-mvp";
const WORKFLOW_DIRECTORY = ".github/workflows";
const AI_CALL_STEP_USES = /^(\s*)uses:\s*openai\/codex-action\b/;
const decoder = new TextDecoder("utf-8", { fatal: true });

interface AiCallSiteContextBudget {
  readonly maxFiles?: number;
  readonly maxBytes?: number;
  readonly maxFileBytes?: number;
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

/** target root package.json이 canonical Framework package일 때만 Framework 자체 요구로 본다 (App 배포본은 App package). */
export function isCanonicalFrameworkTarget(target: string): boolean {
  const manifest = join(target, "package.json");
  if (!existsSync(manifest) || lstatSync(manifest).isSymbolicLink() || !lstatSync(manifest).isFile()) return false;
  const text = decodeText(manifest);
  if (text === null) return false;
  try {
    const parsed = JSON.parse(text) as unknown;
    return !!parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).name === CANONICAL_FRAMEWORK_PACKAGE_NAME;
  } catch {
    return false;
  }
}

function workflowPaths(target: string): string[] {
  const absoluteRoot = join(target, WORKFLOW_DIRECTORY);
  if (!existsSync(absoluteRoot)) return [];
  const realTarget = realpathSync(target);
  const realRoot = realpathSync(absoluteRoot);
  const relRoot = relative(realTarget, realRoot);
  if (relRoot.startsWith("..") || isAbsolute(relRoot)) throw new Error("AI call-site context root escapes target");

  const paths: string[] = [];
  for (const entry of readdirSync(realRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = join(realRoot, entry.name);
    if (lstatSync(absolute).isSymbolicLink()) throw new Error(`AI call-site context refuses symlink: ${absolute}`);
    if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
    paths.push(`${WORKFLOW_DIRECTORY}/${entry.name}`);
  }
  return paths;
}

function leadingSpaces(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * 첫 AI 호출 step(`uses: openai/codex-action`)이 속한 step 블록을 돌려준다.
 * 블록은 그 step의 `- ` 줄에서 시작해 같은 들여쓰기의 다음 step 또는 상위 key 직전에서 끝난다.
 * 한 workflow에 호출 step이 여러 개면(예: bounded IMPLEMENT Worker의 retry step) 첫 번째만 쓴다.
 */
export function aiCallStepWindow(text: string, maxBytes: number): { content: string; startOffset: number } | null {
  const lines = text.split("\n");
  const usesIndex = lines.findIndex((line) => AI_CALL_STEP_USES.test(line));
  if (usesIndex < 0) return null;
  const usesIndent = leadingSpaces(lines[usesIndex]!);
  const stepIndent = usesIndent - 2;
  if (stepIndent < 0) return null;

  let start = usesIndex;
  while (start > 0) {
    const line = lines[start]!;
    if (leadingSpaces(line) === stepIndent && line.trimStart().startsWith("- ")) break;
    start -= 1;
  }
  const startLine = lines[start]!;
  if (!(leadingSpaces(startLine) === stepIndent && startLine.trimStart().startsWith("- "))) return null;

  let end = usesIndex + 1;
  while (end < lines.length) {
    const line = lines[end]!;
    if (line.trim() !== "" && leadingSpaces(line) <= stepIndent) break;
    end += 1;
  }
  while (end > usesIndex + 1 && lines[end - 1]!.trim() === "") end -= 1;

  const startOffset = Buffer.byteLength(lines.slice(0, start).join("\n"), "utf8") + (start > 0 ? 1 : 0);
  const content = trimUtf8(lines.slice(start, end).join("\n"), maxBytes);
  if (content.length === 0) return null;
  return { content, startOffset };
}

function callSiteFile(target: string, path: string, maxFileBytes: number): PlanContextFile | null {
  const absolute = join(target, path);
  const text = decodeText(absolute);
  if (text === null) return null;
  const window = aiCallStepWindow(text, maxFileBytes);
  if (!window) return null;
  const byteLength = Buffer.byteLength(window.content, "utf8");
  if (byteLength < 1 || byteLength > PLAN_CONTEXT_MAX_FILE_BYTES) return null;
  return {
    evidenceId: "E1",
    path,
    startOffset: window.startOffset,
    byteLength,
    digestAlgorithm: "sha256",
    contentDigest: createHash("sha256").update(window.content, "utf8").digest("hex"),
    content: window.content,
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

function isProtectedProjectContext(path: string): boolean {
  return path === "package.json" || path === "tsconfig.json";
}

/** AI 호출 step을 가진 workflow를 요구 관련도 순으로 돌려준다 (동점은 path 순). */
export function aiCallSiteCandidates(
  requirement: string,
  target: string,
  maxFileBytes: number = AI_CALL_SITE_CONTEXT_MAX_FILE_BYTES,
): PlanContextFile[] {
  const terms = requirementTerms(requirement);
  return workflowPaths(target)
    .map((path) => {
      const text = decodeText(join(target, path));
      if (text === null) return null;
      const file = callSiteFile(target, path, maxFileBytes);
      return file ? { file, score: relevanceScore(path, text, terms) } : null;
    })
    .filter((entry): entry is { file: PlanContextFile; score: number } => entry !== null)
    .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path))
    .map((entry) => entry.file);
}

export function augmentPlanContextWithAiCallSites(
  requirement: string,
  target: string,
  context: PlanContextPack,
  budget: AiCallSiteContextBudget = {},
): PlanContextPack {
  verifyPlanContextPack(context);
  if (!needsAiExecutionPlanContext(requirement) || !isCanonicalFrameworkTarget(target)) return context;

  const maxFiles = Math.min(budget.maxFiles ?? PLAN_CONTEXT_MAX_FILES, PLAN_CONTEXT_MAX_FILES);
  const maxBytes = Math.min(budget.maxBytes ?? PLAN_CONTEXT_MAX_BYTES, PLAN_CONTEXT_MAX_BYTES);
  const maxFileBytes = Math.min(budget.maxFileBytes ?? AI_CALL_SITE_CONTEXT_MAX_FILE_BYTES, PLAN_CONTEXT_MAX_FILE_BYTES);
  if (
    !Number.isSafeInteger(maxFiles) || maxFiles < 1 ||
    !Number.isSafeInteger(maxBytes) || maxBytes < 1 ||
    !Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1
  ) {
    throw new Error("Invalid AI call-site PLAN context budget");
  }

  // 호출 지점이 슬롯 전부를 차지하지 않도록 기존 선택에 최소 1슬롯을 남긴다.
  const maxCallSites = Math.max(1, maxFiles - 1);
  const candidates = aiCallSiteCandidates(requirement, target, maxFileBytes).slice(0, maxCallSites);
  if (candidates.length === 0) return context;

  const candidatePaths = new Set(candidates.map((file) => file.path));
  const retained = context.files.filter((file) => !candidatePaths.has(file.path));
  const files: PlanContextFile[] = [...candidates];
  let totalBytes = files.reduce((sum, file) => sum + file.byteLength, 0);

  // 호출 지점 창은 작으므로(기본 3KB) 기존 선택은 예산이 허용하는 만큼 유지한다. package.json/tsconfig.json은 먼저 지킨다.
  const ordered = [
    ...retained.filter((file) => isProtectedProjectContext(file.path)),
    ...retained.filter((file) => !isProtectedProjectContext(file.path)),
  ];
  for (const file of ordered) {
    if (files.length >= maxFiles || totalBytes + file.byteLength > maxBytes) continue;
    files.push(file);
    totalBytes += file.byteLength;
  }

  return rebind(context.repository, context.sha, files);
}
