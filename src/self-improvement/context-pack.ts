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

export type ContextFile = PresentContextFile | MissingContextFile;

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

export function contextPackArtifactName(contract: ImplementContract): string {
  verifyImplementContract(contract);
  return `implement-context-issue-${contract.requirement.issueNumber}-contract-${contract.contractDigest}`;
}

export function createImplementContextPack(
  contract: ImplementContract,
  targetRoot: string,
  observedBaseSha: string,
): ImplementContextPack {
  verifyImplementContract(contract);
  if (observedBaseSha !== contract.baseSha) throw new Error("Context Pack base SHA mismatch");

  const root = assertTargetRoot(targetRoot);
  const allowedPaths = [...contract.scope.allowedPaths].sort((a, b) => a.localeCompare(b));
  if (allowedPaths.length === 0 || new Set(allowedPaths).size !== allowedPaths.length) {
    throw new Error("Context Pack requires unique allowedPaths");
  }

  const files: ContextFile[] = [];
  let totalContextBytes = 0;
  for (const path of allowedPaths) {
    const file = readContextFile(root, path);
    totalContextBytes += file.byteLength;
    if (totalContextBytes > contract.scope.maxContextBytes) throw new Error("Context Pack exceeds maxContextBytes");
    files.push(file);
  }

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

  const expectedPaths = [...contract.scope.allowedPaths].sort((a, b) => a.localeCompare(b));
  const actualPaths = pack.files.map(({ path }) => path);
  if (new Set(actualPaths).size !== actualPaths.length || JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error("Context Pack files must exactly match allowedPaths");
  }

  let total = 0;
  for (const file of pack.files) {
    if (file.state === "missing") {
      if (file.byteLength !== 0) throw new Error("missing Context Pack file must have zero bytes");
      continue;
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
