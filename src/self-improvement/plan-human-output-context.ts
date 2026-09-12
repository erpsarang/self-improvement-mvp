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

const HUMAN_OUTPUT_SURFACE_MAX_FILES = 2;
const HUMAN_OUTPUT_SURFACE_MAX_BYTES = 6_000;
const decoder = new TextDecoder("utf-8", { fatal: true });
const OUTPUT_MARKERS = [
  "github.rest.issues.createcomment",
  "github.rest.issues.create(",
  "github.rest.pulls.create(",
] as const;

function needsHumanOutputSurface(requirement: string): boolean {
  const lower = requirement.toLowerCase();
  if (["사람", "사용자", "표시", "요약", "다음 행동", "문구", "상태"].some((signal) => lower.includes(signal))) return true;
  return /\b(issue|pull request|pr|comment|status|summary|human|user)\b/.test(lower);
}

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

function surfaceExcerpt(text: string): { content: string; startOffset: number } {
  if (Buffer.byteLength(text, "utf8") <= HUMAN_OUTPUT_SURFACE_MAX_BYTES) return { content: text, startOffset: 0 };
  const lower = text.toLowerCase();
  const markerIndexes = OUTPUT_MARKERS.map((marker) => lower.indexOf(marker)).filter((index) => index >= 0);
  const focus = markerIndexes.length > 0 ? Math.min(...markerIndexes) : 0;
  const estimatedChars = Math.min(text.length, HUMAN_OUTPUT_SURFACE_MAX_BYTES);
  const startOffset = Math.max(0, focus - Math.floor(estimatedChars / 2));
  return { content: trimUtf8(text.slice(startOffset), HUMAN_OUTPUT_SURFACE_MAX_BYTES), startOffset };
}

function isDirectOutputSurface(text: string): boolean {
  const lower = text.toLowerCase();
  return OUTPUT_MARKERS.some((marker) => lower.includes(marker));
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
      if (text === null || !isDirectOutputSurface(text)) return null;
      const excerpt = surfaceExcerpt(text);
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

export function augmentPlanContextWithHumanOutputSurfaces(
  requirement: string,
  target: string,
  context: PlanContextPack,
): PlanContextPack {
  verifyPlanContextPack(context);
  if (!needsHumanOutputSurface(requirement)) return context;

  const candidates = surfaceCandidates(requirement, target);
  if (candidates.length === 0) return context;

  const files = [...context.files];
  const protectedPaths = new Set(context.files.slice(0, Math.min(5, context.files.length)).map((file) => file.path));
  const candidatePaths = new Set(candidates.map((file) => file.path));

  for (const candidate of candidates) {
    if (files.some((file) => file.path === candidate.path)) continue;

    const canEvict = (file: PlanContextFile): boolean => !protectedPaths.has(file.path) && !candidatePaths.has(file.path);
    const totalBytes = () => files.reduce((sum, file) => sum + file.byteLength, 0);
    while (files.length >= PLAN_CONTEXT_MAX_FILES || totalBytes() + candidate.byteLength > PLAN_CONTEXT_MAX_BYTES) {
      let removeIndex = -1;
      for (let index = files.length - 1; index >= 0; index -= 1) {
        if (canEvict(files[index]!)) {
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
