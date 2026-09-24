import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { verifyImplementContract, type ImplementContract } from "./implement-contract.js";

export interface PresentContextFile {
  readonly path: string;
  readonly state: "present";
  readonly byteLength: number;
  readonly digestAlgorithm: "sha256";
  readonly contentDigest: string;
  readonly content: string;
}

export interface MissingContextFile {
  readonly path: string;
  readonly state: "missing";
  readonly byteLength: 0;
}

/**
 * 승인된 PLAN이 실제로 본 evidence 발췌를 read-only contextPath로 materialize한 항목.
 * PLAN Context는 bounded excerpt인데 IMPLEMENT Context는 전체 파일을 넣으므로, contextPaths 전체 파일이
 * maxContextBytes를 넘으면 Planner가 본 것과 같은 발췌를 그대로 쓴다 (self-improvement-mvp #244 Handoff run 35976744079).
 * startOffset은 PLAN evidence·validatePlan과 같은 문자 인덱스이며, 전체 파일 digest로 exact SHA에 묶인다.
 * allowedPaths(쓰기 권한)에는 절대 쓰지 않는다: 수정에는 전체 파일과 exact base digest가 필요하다.
 */
export interface ExcerptContextFile {
  readonly path: string;
  readonly state: "excerpt";
  readonly startOffset: number;
  readonly byteLength: number;
  readonly digestAlgorithm: "sha256";
  readonly contentDigest: string;
  readonly content: string;
  readonly sourceByteLength: number;
  readonly sourceContentDigest: string;
}

export type ContextFile = PresentContextFile | MissingContextFile | ExcerptContextFile;

/** 승인된 PLAN Context Pack의 evidence 한 건 (PLAN-context.json files[] 항목의 부분집합). */
export interface ApprovedPlanEvidence {
  readonly path: string;
  readonly startOffset: number;
  readonly content: string;
  readonly contentDigest: string;
}

export interface ImplementContextPackOptions {
  /** 승인된 PLAN이 본 evidence. 전체 파일이 예산을 넘을 때만 read-only contextPath의 발췌 근거로 쓴다. */
  readonly approvedPlanEvidence?: readonly ApprovedPlanEvidence[];
}

export interface ImplementContextPackPayload {
  readonly schemaVersion: 1;
  readonly kind: "trusted-implement-context-pack";
  readonly contractDigest: string;
  readonly repository: string;
  readonly baseSha: string;
  readonly files: readonly ContextFile[];
  readonly totalContextBytes: number;
}

export interface ImplementContextPack extends ImplementContextPackPayload {
  readonly digestAlgorithm: "sha256";
  readonly contextDigest: string;
}

const SHA256 = /^[0-9a-f]{64}$/;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertTargetRoot(targetRoot: string): string {
  const root = resolve(targetRoot);
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Context Pack target root must be a real directory");
  return root;
}

function assertSafePath(root: string, path: string): string {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((segment) => segment === "" || segment === "..")) {
    throw new Error(`unsafe Context Pack path: ${path}`);
  }
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Context Pack path escapes target root: ${path}`);
  }
  return absolute;
}

function assertNoSymlinkComponents(root: string, path: string): void {
  let current = root;
  const segments = path.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]!);
    if (!existsSync(current)) return;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Context Pack path contains symlink: ${path}`);
    if (index < segments.length - 1 && !stat.isDirectory()) throw new Error(`Context Pack ancestor is not a directory: ${path}`);
  }
}

function readContextFile(root: string, path: string): ContextFile {
  const absolute = assertSafePath(root, path);
  assertNoSymlinkComponents(root, path);
  if (!existsSync(absolute)) return { path, state: "missing", byteLength: 0 };

  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Context Pack path must be a regular file: ${path}`);
  const bytes = readFileSync(absolute);
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`Context Pack only accepts UTF-8 text files: ${path}`);
  }
  return {
    path,
    state: "present",
    byteLength: bytes.byteLength,
    digestAlgorithm: "sha256",
    contentDigest: sha256(bytes),
    content,
  };
}

function excerptContextFile(present: PresentContextFile, evidence: ApprovedPlanEvidence): PresentContextFile | ExcerptContextFile {
  if (
    !Number.isSafeInteger(evidence.startOffset) || evidence.startOffset < 0 ||
    typeof evidence.content !== "string" || evidence.content.length === 0 ||
    !SHA256.test(evidence.contentDigest) || sha256(Buffer.from(evidence.content, "utf8")) !== evidence.contentDigest
  ) {
    throw new Error(`approved PLAN evidence is invalid: ${present.path}`);
  }
  // validatePlan과 같은 frozen 검사: 승인 당시 Planner가 본 발췌가 exact base SHA의 파일과 일치해야 한다.
  if (present.content.slice(evidence.startOffset, evidence.startOffset + evidence.content.length) !== evidence.content) {
    throw new Error(`approved PLAN evidence does not match frozen base file: ${present.path}`);
  }
  // Planner가 파일 전체를 봤다면 발췌가 아니라 전체 파일이다 (예산 계산은 같고 provenance가 정확해진다).
  if (evidence.startOffset === 0 && evidence.content === present.content) return present;
  return {
    path: present.path,
    state: "excerpt",
    startOffset: evidence.startOffset,
    byteLength: Buffer.byteLength(evidence.content, "utf8"),
    digestAlgorithm: "sha256",
    contentDigest: evidence.contentDigest,
    content: evidence.content,
    sourceByteLength: present.byteLength,
    sourceContentDigest: present.contentDigest,
  };
}

export function contextPackArtifactName(contract: ImplementContract): string {
  verifyImplementContract(contract);
  return `implement-context-issue-${contract.requirement.issueNumber}-contract-${contract.contractDigest}`;
}

export function createImplementContextPack(
  contract: ImplementContract,
  targetRoot: string,
  observedBaseSha: string,
  options: ImplementContextPackOptions = {},
): ImplementContextPack {
  verifyImplementContract(contract);
  if (observedBaseSha !== contract.baseSha) throw new Error("Context Pack base SHA mismatch");

  const root = assertTargetRoot(targetRoot);
  const allowedPaths = new Set(contract.scope.allowedPaths);
  const readOnlyContextPaths = new Set(contract.scope.contextPaths);
  const contextPaths = [...new Set([...contract.scope.allowedPaths, ...contract.scope.contextPaths])].sort();
  if (contextPaths.length === 0) {
    throw new Error("Context Pack requires at least one allowed or context path");
  }

  // 1) 전체 파일 표현. 예산 안이면 이것이 그대로 Context Pack이다 (기존 동작과 바이트 동일).
  const fullFiles: ContextFile[] = [];
  for (const path of contextPaths) {
    const file = readContextFile(root, path);
    if (readOnlyContextPaths.has(path) && file.state === "missing") {
      throw new Error(`read-only contextPath must exist at frozen base SHA: ${path}`);
    }
    fullFiles.push(file);
  }
  const bytesOf = (list: readonly ContextFile[]) => list.reduce((sum, file) => sum + file.byteLength, 0);

  let files: ContextFile[] = fullFiles;
  if (bytesOf(fullFiles) > contract.scope.maxContextBytes) {
    // 2) 예산 초과: 쓰기 권한이 없는 contextPath 중 승인된 PLAN evidence가 있는 것만 그 발췌로 바꾼다.
    //    임의로 파일을 버리지 않는다. 그래도 넘으면 fail-closed.
    const evidenceByPath = new Map<string, ApprovedPlanEvidence>();
    for (const evidence of options.approvedPlanEvidence ?? []) {
      if (typeof evidence?.path !== "string" || evidenceByPath.has(evidence.path)) {
        throw new Error("approved PLAN evidence paths must be unique strings");
      }
      evidenceByPath.set(evidence.path, evidence);
    }
    files = fullFiles.map((file) => {
      if (file.state !== "present" || allowedPaths.has(file.path)) return file;
      const evidence = evidenceByPath.get(file.path);
      return evidence ? excerptContextFile(file, evidence) : file;
    });
    if (bytesOf(files) > contract.scope.maxContextBytes) {
      const oversized = files
        .filter((file) => file.state === "present" && !allowedPaths.has(file.path))
        .map((file) => `${file.path} (${file.byteLength}B, no approved PLAN evidence)`);
      throw new Error(
        `Context Pack exceeds maxContextBytes${oversized.length > 0 ? `; read-only contextPaths without approved PLAN evidence: ${oversized.join(", ")}` : " even with approved PLAN evidence excerpts"}`,
      );
    }
  }
  const totalContextBytes = bytesOf(files);

  const payload: ImplementContextPackPayload = {
    schemaVersion: 1,
    kind: "trusted-implement-context-pack",
    contractDigest: contract.contractDigest,
    repository: contract.repository,
    baseSha: contract.baseSha,
    files,
    totalContextBytes,
  };
  const contextDigest = sha256(JSON.stringify(payload));
  return { ...payload, digestAlgorithm: "sha256", contextDigest };
}

export function verifyImplementContextPack(pack: ImplementContextPack, contract: ImplementContract): void {
  verifyImplementContract(contract);
  if (pack.schemaVersion !== 1 || pack.kind !== "trusted-implement-context-pack" || pack.digestAlgorithm !== "sha256") {
    throw new Error("unsupported Context Pack schema");
  }
  if (!SHA256.test(pack.contextDigest)) throw new Error("contextDigest must be a lowercase SHA-256 digest");
  if (pack.contractDigest !== contract.contractDigest || pack.repository !== contract.repository || pack.baseSha !== contract.baseSha) {
    throw new Error("Context Pack contract identity mismatch");
  }

  const expectedPaths = [...new Set([...contract.scope.allowedPaths, ...contract.scope.contextPaths])].sort();
  const actualPaths = pack.files.map(({ path }) => path);
  if (new Set(actualPaths).size !== actualPaths.length || JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error("Context Pack files must exactly match allowedPaths plus contextPaths");
  }

  const readOnlyContextPaths = new Set(contract.scope.contextPaths);
  const allowedPaths = new Set(contract.scope.allowedPaths);
  let total = 0;
  for (const file of pack.files) {
    if (file.state === "missing") {
      if (file.byteLength !== 0) throw new Error("missing Context Pack file must have zero bytes");
      if (readOnlyContextPaths.has(file.path)) throw new Error(`read-only contextPath cannot be missing: ${file.path}`);
      continue;
    }
    if (file.state === "excerpt") {
      // 발췌는 쓰기 권한이 없는 read-only contextPath에만 허용된다.
      if (allowedPaths.has(file.path) || !readOnlyContextPaths.has(file.path)) {
        throw new Error(`excerpt Context Pack file is only allowed for read-only contextPaths: ${file.path}`);
      }
      if (
        !Number.isSafeInteger(file.startOffset) || file.startOffset < 0 ||
        !Number.isSafeInteger(file.sourceByteLength) || file.sourceByteLength < file.byteLength ||
        !SHA256.test(file.sourceContentDigest) || file.content.length === 0
      ) {
        throw new Error(`Context Pack excerpt identity is invalid: ${file.path}`);
      }
    } else if (file.state !== "present") {
      throw new Error("unsupported Context Pack file state");
    }
    const bytes = Buffer.from(file.content, "utf8");
    if (bytes.byteLength !== file.byteLength || file.digestAlgorithm !== "sha256" || sha256(bytes) !== file.contentDigest) {
      throw new Error(`Context Pack file digest mismatch: ${file.path}`);
    }
    total += file.byteLength;
  }
  if (total !== pack.totalContextBytes || total > contract.scope.maxContextBytes) throw new Error("Context Pack byte budget mismatch");

  const { digestAlgorithm: _algorithm, contextDigest, ...payload } = pack;
  if (sha256(JSON.stringify(payload)) !== contextDigest) throw new Error("Context Pack digest mismatch");
}
