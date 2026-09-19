import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
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
import { needsHumanOutputPlanContext } from "./plan-context-policy.js";

const HUMAN_OUTPUT_SURFACE_MAX_FILES = 2;
const HUMAN_OUTPUT_SURFACE_MAX_BYTES = 6_000;
const decoder = new TextDecoder("utf-8", { fatal: true });
const OUTPUT_CALL = /github\.rest\.(?:issues\.(?:createComment|create)|pulls\.create)\s*\(/i;
const LIFECYCLE_WORKFLOW_BY_ANCHOR = new Map<string, string>([
  ["PLAN", ".github/workflows/plan.yml"],
  ["PLAN_AUTHORIZE", ".github/workflows/plan-authorize.yml"],
  ["IMPLEMENT", ".github/workflows/implement.yml"],
  ["VERIFY", ".github/workflows/trusted-rail.yml"],
  ["MERGE_READY", ".github/workflows/orchestrator.yml"],
  ["STOPPED", ".github/workflows/orchestrator.yml"],
]);
const LIFECYCLE_SUPPORT_FILES = [
  { path: "src/self-improvement/state.ts", focus: "WORKFLOW_STATES" },
  { path: "src/self-improvement/implement-contract.ts", focus: "ImplementContract" },
  { path: "package.json", focus: "scripts" },
] as const;

function runtimeSurfacePath(path: string): boolean {
  const lower = path.toLowerCase();
  if (lower.startsWith(".github/workflows/")) return true;
  if (!lower.startsWith("src/")) return false;
  return !/\.(test|spec)\.[^/]+$/.test(lower);
}

function walkRuntimeSurfaceFiles(target: string): string[] {
  const paths: string[] = [];
  for (const root of ["src", ".github/workflows"]) {
    const absoluteRoot = join(target, root);
    if (!existsSync(absoluteRoot)) continue;
    const realRoot = realpathSync(absoluteRoot);
    const relRoot = relative(realpathSync(target), realRoot);
    if (relRoot.startsWith("..") || isAbsolute(relRoot)) throw new Error("Human-output context root escapes target");
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const absolute = join(dir, entry.name);
        const stat = lstatSync(absolute);
        if (stat.isSymbolicLink()) throw new Error(`Human-output context refuses symlink: ${absolute}`);
        if (entry.isDirectory()) walk(absolute);
        else if (entry.isFile()) {
          const path = relative(target, absolute).replaceAll("\\", "/");
          if (runtimeSurfacePath(path)) paths.push(path);
        }
      }
    };
    walk(realRoot);
  }
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

function requestedLifecycleAnchors(requirement: string): string[] {
  const tokens = new Set<string>();
  for (const match of requirement.matchAll(/`([A-Z][A-Z0-9_]{2,79})`/g)) tokens.add(match[1]!);
  for (const match of requirement.matchAll(/\b([A-Z][A-Z0-9_]{2,79})\b/g)) tokens.add(match[1]!);
  return [...LIFECYCLE_WORKFLOW_BY_ANCHOR.keys()].filter((anchor) => tokens.has(anchor));
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

function surfaceScore(path: string, text: string, terms: readonly string[]): number {
  const lowerPath = path.toLowerCase();
  const lowerText = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const pathTerm = term.replaceAll("_", "-");
    if (lowerPath.includes(term) || lowerPath.includes(pathTerm)) score += 25;
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

function maskSourceStringsAndComments(text: string): string {
  const chars = text.split("");
  const masked = [...chars];
  let state: "code" | "single" | "double" | "template" | "line" | "block" = "code";
  const hide = (index: number) => {
    if (chars[index] !== "\n" && chars[index] !== "\r") masked[index] = " ";
  };

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!;
    const next = chars[index + 1];
    if (state === "code") {
      if (char === "/" && next === "/") {
        hide(index);
        hide(index + 1);
        index += 1;
        state = "line";
      } else if (char === "/" && next === "*") {
        hide(index);
        hide(index + 1);
        index += 1;
        state = "block";
      } else if (char === "'") {
        hide(index);
        state = "single";
      } else if (char === "\"") {
        hide(index);
        state = "double";
      } else if (char === "`") {
        hide(index);
        state = "template";
      }
      continue;
    }

    if (state === "line") {
      if (char === "\n" || char === "\r") state = "code";
      else hide(index);
      continue;
    }

    if (state === "block") {
      hide(index);
      if (char === "*" && next === "/") {
        hide(index + 1);
        index += 1;
        state = "code";
      }
      continue;
    }

    hide(index);
    if (char === "\\") {
      if (index + 1 < chars.length) {
        hide(index + 1);
        index += 1;
      }
      continue;
    }
    if ((state === "single" && char === "'") || (state === "double" && char === "\"") || (state === "template" && char === "`")) {
      state = "code";
    }
  }

  return masked.join("");
}

function directOutputCallIndex(path: string, text: string): number {
  const searchable = path.toLowerCase().startsWith(".github/workflows/") ? text : maskSourceStringsAndComments(text);
  return searchable.search(OUTPUT_CALL);
}

function surfaceExcerpt(text: string, focus: number): { content: string; startOffset: number } {
  if (Buffer.byteLength(text, "utf8") <= HUMAN_OUTPUT_SURFACE_MAX_BYTES) return { content: text, startOffset: 0 };
  const estimatedChars = Math.min(text.length, HUMAN_OUTPUT_SURFACE_MAX_BYTES);
  const startOffset = Math.max(0, focus - Math.floor(estimatedChars / 2));
  return { content: trimUtf8(text.slice(startOffset), HUMAN_OUTPUT_SURFACE_MAX_BYTES), startOffset };
}

function contextFile(target: string, path: string, focusTerms: readonly string[]): PlanContextFile | null {
  const absolute = join(target, path);
  if (!existsSync(absolute)) return null;
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new Error(`Human-output context refuses symlink: ${absolute}`);
  if (!stat.isFile()) return null;
  const text = decodeText(absolute);
  if (text === null) return null;

  const outputCall = directOutputCallIndex(path, text);
  const indexes = focusTerms.map((term) => text.indexOf(term)).filter((index) => index >= 0);
  const focus = outputCall >= 0 ? outputCall : indexes.length > 0 ? Math.min(...indexes) : 0;
  const excerpt = surfaceExcerpt(text, focus);
  const byteLength = Buffer.byteLength(excerpt.content, "utf8");
  if (byteLength < 1 || byteLength > PLAN_CONTEXT_MAX_FILE_BYTES) return null;
  return {
    evidenceId: "E1",
    path,
    startOffset: excerpt.startOffset,
    byteLength,
    digestAlgorithm: "sha256",
    contentDigest: createHash("sha256").update(excerpt.content, "utf8").digest("hex"),
    content: excerpt.content,
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

function surfaceCandidates(requirement: string, target: string): PlanContextFile[] {
  const terms = requirementTerms(requirement);
  return walkRuntimeSurfaceFiles(target)
    .map((path) => {
      const text = decodeText(join(target, path));
      if (text === null) return null;
      const callIndex = directOutputCallIndex(path, text);
      if (callIndex < 0) return null;
      const excerpt = surfaceExcerpt(text, callIndex);
      const byteLength = Buffer.byteLength(excerpt.content, "utf8");
      if (byteLength < 1 || byteLength > PLAN_CONTEXT_MAX_FILE_BYTES) return null;
      return {
        path,
        score: surfaceScore(path, text, terms),
        file: {
          evidenceId: "E1",
          path,
          startOffset: excerpt.startOffset,
          byteLength,
          digestAlgorithm: "sha256" as const,
          contentDigest: createHash("sha256").update(excerpt.content, "utf8").digest("hex"),
          content: excerpt.content,
        },
      };
    })
    .filter((entry): entry is { path: string; score: number; file: PlanContextFile } => entry !== null)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, HUMAN_OUTPUT_SURFACE_MAX_FILES)
    .map((entry) => entry.file);
}

function lifecycleCandidates(requirement: string, target: string): PlanContextFile[] {
  const anchors = requestedLifecycleAnchors(requirement);
  if (anchors.length === 0) return [];

  const workflowFocus = new Map<string, string[]>();
  for (const anchor of anchors) {
    const path = LIFECYCLE_WORKFLOW_BY_ANCHOR.get(anchor)!;
    const current = workflowFocus.get(path) ?? [];
    current.push(anchor);
    workflowFocus.set(path, current);
  }

  const result: PlanContextFile[] = [];
  for (const [path, focusTerms] of workflowFocus) {
    const file = contextFile(target, path, focusTerms);
    if (file) result.push(file);
  }
  for (const support of LIFECYCLE_SUPPORT_FILES) {
    const file = contextFile(target, support.path, [support.focus, ...anchors]);
    if (file) result.push(file);
  }
  return result;
}

function uniqueCandidates(groups: readonly PlanContextFile[][]): PlanContextFile[] {
  const result: PlanContextFile[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const file of group) {
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      result.push(file);
      if (result.length >= PLAN_CONTEXT_MAX_FILES) return result;
    }
  }
  return result;
}

export function augmentPlanContextWithHumanOutputSurfaces(
  requirement: string,
  target: string,
  context: PlanContextPack,
): PlanContextPack {
  verifyPlanContextPack(context);
  if (!needsHumanOutputPlanContext(requirement)) return context;

  const candidates = uniqueCandidates([
    lifecycleCandidates(requirement, target),
    surfaceCandidates(requirement, target),
  ]);
  if (candidates.length === 0) return context;

  const candidatePaths = new Set(candidates.map((file) => file.path));
  const candidateByPath = new Map(candidates.map((file) => [file.path, file] as const));
  const files = context.files.map((file) => candidateByPath.get(file.path) ?? file);
  const totalBytes = () => files.reduce((sum, file) => sum + file.byteLength, 0);

  for (const candidate of candidates) {
    if (files.some((file) => file.path === candidate.path)) continue;

    while (files.length >= PLAN_CONTEXT_MAX_FILES || totalBytes() + candidate.byteLength > PLAN_CONTEXT_MAX_BYTES) {
      let removeIndex = -1;
      for (let index = files.length - 1; index >= 0; index -= 1) {
        if (!candidatePaths.has(files[index]!.path)) {
          removeIndex = index;
          break;
        }
      }
      if (removeIndex < 0) throw new Error("Human-output Context Pack cannot fit within trusted budget");
      files.splice(removeIndex, 1);
    }
    files.push(candidate);
  }

  return rebind(context.repository, context.sha, files);
}
