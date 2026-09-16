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

interface ExplicitPathContextBudget {
  readonly maxFiles?: number;
  readonly maxBytes?: number;
  readonly maxFileBytes?: number;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

function requirementPathAnchors(requirement: string): string[] {
  const anchors: string[] = [];
  for (const match of requirement.matchAll(/`([A-Za-z0-9._/-]{3,500})`/g)) {
    const path = match[1]!;
    if (
      !path.includes("/") ||
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

function excerpt(text: string, terms: readonly string[], maxBytes: number): { content: string; startOffset: number } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { content: text, startOffset: 0 };
  const lower = text.toLowerCase();
  const indexes = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0);
  const focus = indexes.length > 0 ? Math.min(...indexes) : 0;
  const estimatedChars = Math.min(text.length, maxBytes);
  const startOffset = Math.max(0, focus - Math.floor(estimatedChars / 3));
  return { content: trimUtf8(text.slice(startOffset), maxBytes), startOffset };
}

function explicitContextFile(
  target: string,
  path: string,
  terms: readonly string[],
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
  const part = excerpt(text, terms, maxBytes);
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
  const explicit: PlanContextFile[] = [];
  let explicitBytes = 0;
  for (const path of requirementPathAnchors(requirement)) {
    if (explicit.length >= maxFiles || explicitBytes >= maxBytes) break;
    const remaining = maxBytes - explicitBytes;
    const file = explicitContextFile(target, path, terms, Math.min(maxFileBytes, remaining));
    if (!file) continue;
    explicit.push(file);
    explicitBytes += file.byteLength;
  }
  if (explicit.length === 0) return context;

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
