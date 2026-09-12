import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  verifyImplementContextPack,
  type ContextFile,
  type ImplementContextPack,
} from "./context-pack.js";
import {
  verifyImplementContract,
  type ImplementContract,
} from "./implement-contract.js";
import {
  verifyCandidateChangeSet,
  type CandidateChangeSet,
} from "./single-pass-worker.js";

export interface ValidationCommandSpec {
  readonly raw: string;
  readonly executable: "npm";
  readonly args: readonly string[];
}

export interface ValidationCommandResult {
  readonly raw: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly status: "PASS" | "FAIL";
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DeterministicValidationResult {
  readonly schemaVersion: 1;
  readonly kind: "deterministic-validation-result";
  readonly contractDigest: string;
  readonly contextDigest: string;
  readonly candidateDigest: string;
  readonly baseSha: string;
  readonly appliedPaths: readonly string[];
  readonly status: "PASS" | "FAIL";
  readonly commands: readonly ValidationCommandResult[];
  readonly digestAlgorithm: "sha256";
  readonly evidenceDigest: string;
}

export interface ValidationExecutorResult {
  readonly status: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type ValidationExecutor = (
  executable: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
) => ValidationExecutorResult;

const SHA256 = /^[0-9a-f]{64}$/;
const FORBIDDEN_COMMAND_CHARS = /[\n\r;&|<>`$'"\\]/;
const MAX_LOG_BYTES = 32 * 1024;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
}

function assertTargetRoot(targetRoot: string): string {
  const root = resolve(targetRoot);
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("validation target root must be a real directory");
  return root;
}

function safeAbsolutePath(root: string, path: string): string {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((segment) => segment === "" || segment === "..")) {
    throw new Error(`unsafe candidate path: ${path}`);
  }
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`candidate path escapes target root: ${path}`);
  return absolute;
}

function assertNoSymlinkComponents(root: string, path: string): void {
  let current = root;
  for (const segment of path.split("/")) {
    current = resolve(current, segment);
    if (!existsSync(current)) return;
    if (lstatSync(current).isSymbolicLink()) throw new Error(`candidate path contains symlink: ${path}`);
  }
}

function verifyLiveFile(root: string, file: ContextFile): string {
  const absolute = safeAbsolutePath(root, file.path);
  assertNoSymlinkComponents(root, file.path);

  if (file.state === "missing") {
    if (existsSync(absolute)) throw new Error(`expected missing path now exists: ${file.path}`);
    return absolute;
  }

  if (!existsSync(absolute)) throw new Error(`expected present path is missing: ${file.path}`);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`candidate base path must be a regular file: ${file.path}`);
  const bytes = readFileSync(absolute);
  if (bytes.byteLength !== file.byteLength || sha256(bytes) !== file.contentDigest) {
    throw new Error(`candidate base content changed since Context Pack: ${file.path}`);
  }
  return absolute;
}

export function parseValidationCommand(raw: string): ValidationCommandSpec {
  const command = raw.trim();
  if (!command) throw new Error("validation command must be non-empty");
  if (FORBIDDEN_COMMAND_CHARS.test(command)) throw new Error(`validation command contains forbidden shell syntax: ${raw}`);

  const tokens = command.split(/\s+/u);
  if (tokens[0] !== "npm") throw new Error(`validation executable is not allowed: ${tokens[0] ?? ""}`);
  if (tokens.length < 2) throw new Error("npm validation command must include a subcommand");

  return { raw: command, executable: "npm", args: tokens.slice(1) };
}

export function createValidationPlan(contract: ImplementContract): readonly ValidationCommandSpec[] {
  verifyImplementContract(contract);
  return contract.scope.validationCommands.map(parseValidationCommand);
}

export function applyCandidateToExactBase(
  contract: ImplementContract,
  contextPack: ImplementContextPack,
  candidate: CandidateChangeSet,
  targetRoot: string,
  observedBaseSha: string,
): readonly string[] {
  verifyImplementContract(contract);
  verifyImplementContextPack(contextPack, contract);
  verifyCandidateChangeSet(candidate, contract, contextPack);
  if (observedBaseSha !== contract.baseSha) throw new Error("validation base SHA mismatch");

  const root = assertTargetRoot(targetRoot);
  const contextByPath = new Map(contextPack.files.map((file) => [file.path, file] as const));
  const appliedPaths: string[] = [];

  for (const change of candidate.changes) {
    const context = contextByPath.get(change.path);
    if (!context) throw new Error(`candidate path missing from Context Pack: ${change.path}`);
    const absolute = verifyLiveFile(root, context);

    if (change.operation === "create") mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, change.content, "utf8");
    appliedPaths.push(change.path);
  }

  return [...appliedPaths].sort((a, b) => a.localeCompare(b));
}

function truncateLog(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= MAX_LOG_BYTES) return value;
  return `${bytes.subarray(0, MAX_LOG_BYTES).toString("utf8")}\n...[truncated]`;
}

const defaultExecutor: ValidationExecutor = (executable, args, cwd, timeoutMs) => {
  const result = spawnSync(executable, [...args], {
    cwd,
    shell: false,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
    },
  });

  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: `${result.stderr ?? ""}${result.error ? `\n${result.error.message}` : ""}`,
  };
};

export function runDeterministicValidation(
  contract: ImplementContract,
  contextPack: ImplementContextPack,
  candidate: CandidateChangeSet,
  targetRoot: string,
  observedBaseSha: string,
  options: {
    readonly commandTimeoutMs?: number;
    readonly executor?: ValidationExecutor;
  } = {},
): DeterministicValidationResult {
  const appliedPaths = applyCandidateToExactBase(contract, contextPack, candidate, targetRoot, observedBaseSha);
  const plan = createValidationPlan(contract);
  const timeoutMs = options.commandTimeoutMs ?? 120_000;
  assertPositiveInteger("commandTimeoutMs", timeoutMs);
  const executor = options.executor ?? defaultExecutor;

  const commands: ValidationCommandResult[] = [];
  for (const spec of plan) {
    const outcome = executor(spec.executable, spec.args, resolve(targetRoot), timeoutMs);
    const passed = outcome.status === 0 && outcome.signal === null;
    commands.push({
      raw: spec.raw,
      executable: spec.executable,
      args: [...spec.args],
      status: passed ? "PASS" : "FAIL",
      exitCode: outcome.status,
      signal: outcome.signal,
      stdout: truncateLog(outcome.stdout),
      stderr: truncateLog(outcome.stderr),
    });
    if (!passed) break;
  }

  const status = commands.length === plan.length && commands.every(({ status: commandStatus }) => commandStatus === "PASS") ? "PASS" : "FAIL";
  const payload = {
    schemaVersion: 1 as const,
    kind: "deterministic-validation-result" as const,
    contractDigest: contract.contractDigest,
    contextDigest: contextPack.contextDigest,
    candidateDigest: candidate.candidateDigest,
    baseSha: contract.baseSha,
    appliedPaths,
    status,
    commands,
  };
  const evidenceDigest = sha256(JSON.stringify(payload));
  return { ...payload, digestAlgorithm: "sha256", evidenceDigest };
}

export function verifyDeterministicValidationResult(result: DeterministicValidationResult): void {
  if (result.schemaVersion !== 1 || result.kind !== "deterministic-validation-result" || result.digestAlgorithm !== "sha256") {
    throw new Error("unsupported deterministic validation result schema");
  }
  if (!SHA256.test(result.contractDigest) || !SHA256.test(result.contextDigest) || !SHA256.test(result.candidateDigest) || !SHA256.test(result.evidenceDigest)) {
    throw new Error("deterministic validation result contains invalid digest");
  }
  const { digestAlgorithm: _algorithm, evidenceDigest, ...payload } = result;
  if (sha256(JSON.stringify(payload)) !== evidenceDigest) throw new Error("deterministic validation evidence digest mismatch");
}
