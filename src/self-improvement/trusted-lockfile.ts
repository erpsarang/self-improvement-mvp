/**
 * Trusted deterministic package-lock.json 생성.
 *
 * 문제: bounded IMPLEMENT Worker(AI)는 파일 내용을 텍스트로만 제안하므로, package.json에
 * 의존성을 추가해도 실제 package-lock.json(수십 KB, integrity hash 포함)을 만들 수 없다.
 * 그 결과 deterministic CI의 `npm ci`가 lock 불일치로 실패하고, AI repair로도 절대 고칠 수 없다.
 *
 * 해결: Worker의 trusted validate 단계에서, untrusted proposal이 package.json을 바꾸면
 * trusted code가 `npm install --package-lock-only --ignore-scripts`로 lockfile을 생성해
 * candidate에 포함한다. AI가 제안한 package-lock.json은 항상 버린다.
 *
 * Trust boundary:
 *  - AI가 쓴 package.json은 untrusted 입력이다. registry semver 의존성만 허용하고
 *    (file:/git/http/alias/workspace 금지, workspaces/overrides 금지) 나머지는 fail-closed.
 *  - npm은 격리된 임시 디렉터리에서 package.json + base lock만 가지고 실행한다.
 *    install script 미실행, 토큰 제거, user/global npmrc 무시, registry 고정.
 *  - 생성된 lock은 다시 검증한다(lockfileVersion, registry resolved, integrity, manifest와 sync).
 *  - 생성된 lock은 일반 candidate change로 들어가므로 candidateDigest / provenance /
 *    Candidate Bridge 재검증 / Trusted Rail exact-SHA 검증을 그대로 통과해야 한다.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImplementContextPack } from "./context-pack.js";
import type { ImplementContract } from "./implement-contract.js";
import {
  createCandidateChangeSet,
  TRUSTED_LOCKFILE_MAX_BYTES,
  TRUSTED_LOCKFILE_PATH,
  type WorkerChangeProposal,
  type WorkerProposal,
} from "./single-pass-worker.js";

export const TRUSTED_MANIFEST_PATH = "package.json" as const;
export const TRUSTED_NPM_REGISTRY = "https://registry.npmjs.org/" as const;
export const TRUSTED_LOCKFILE_NPM_ARGS = Object.freeze([
  "install",
  "--package-lock-only",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
] as const);

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
const FORBIDDEN_MANIFEST_FIELDS = ["workspaces", "overrides", "bundleDependencies", "bundledDependencies"] as const;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
/** registry semver만 허용: 선택적 비교 연산자 + 1~3자리 버전 + 선택적 prerelease. */
const REGISTRY_SEMVER_SPEC = /^(?:\^|~|>=|<=|>|<|=)?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?$/;

export type TrustedLockfileStatus =
  | "NOT_NEEDED"            // package.json을 바꾸지 않음
  | "UNCHANGED"             // package.json은 바꿨지만 생성된 lock이 base와 동일
  | "GENERATED";            // trusted lock을 candidate change로 추가

export interface TrustedLockfileResult {
  readonly proposal: WorkerProposal;
  readonly status: TrustedLockfileStatus;
  /** AI가 package-lock.json을 제안했고 그것을 버렸는지 */
  readonly droppedUntrustedLockfile: boolean;
}

export interface NpmExecutorResult {
  readonly status: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** cwd에는 package.json(과 있으면 base package-lock.json)만 있다. 성공하면 cwd에 package-lock.json을 남긴다. */
export type NpmLockExecutor = (cwd: string, args: readonly string[], env: NodeJS.ProcessEnv) => NpmExecutorResult;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dependencyMap(manifest: Record<string, unknown>, field: string): Record<string, string> {
  const value = manifest[field];
  if (value === undefined) return {};
  if (!record(value)) throw new Error(`package.json ${field} must be an object`);
  const out: Record<string, string> = {};
  for (const [name, spec] of Object.entries(value)) {
    if (!PACKAGE_NAME.test(name) || name.length > 214) throw new Error(`package.json ${field} has an invalid package name: ${name}`);
    if (typeof spec !== "string" || !REGISTRY_SEMVER_SPEC.test(spec)) {
      throw new Error(`package.json ${field}.${name} must be a registry semver range, got: ${String(spec)}`);
    }
    out[name] = spec;
  }
  return out;
}

/** untrusted package.json을 fail-closed로 검증한다. registry semver 의존성만 허용. */
export function validateProposedManifest(packageJsonText: string): Record<string, unknown> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(packageJsonText);
  } catch {
    throw new Error("proposed package.json is not valid JSON");
  }
  if (!record(manifest)) throw new Error("proposed package.json must be an object");
  for (const field of FORBIDDEN_MANIFEST_FIELDS) {
    if (manifest[field] !== undefined) throw new Error(`proposed package.json must not use ${field}`);
  }
  for (const field of DEPENDENCY_FIELDS) dependencyMap(manifest, field);
  return manifest;
}

/** 생성된 lockfile을 fail-closed로 검증한다. */
export function verifyGeneratedLockfile(lockText: string, packageJsonText: string): void {
  if (Buffer.byteLength(lockText, "utf8") > TRUSTED_LOCKFILE_MAX_BYTES) throw new Error("generated package-lock.json exceeds trusted size bound");
  let lock: unknown;
  try {
    lock = JSON.parse(lockText);
  } catch {
    throw new Error("generated package-lock.json is not valid JSON");
  }
  if (!record(lock) || lock.lockfileVersion !== 3 || !record(lock.packages)) {
    throw new Error("generated package-lock.json must be lockfileVersion 3");
  }
  const manifest = validateProposedManifest(packageJsonText);
  const root = lock.packages[""];
  if (!record(root)) throw new Error("generated package-lock.json root package is missing");
  for (const field of DEPENDENCY_FIELDS) {
    const expected = dependencyMap(manifest, field);
    const actual = root[field] === undefined ? {} : root[field];
    if (!record(actual) || JSON.stringify(sorted(actual as Record<string, unknown>)) !== JSON.stringify(sorted(expected))) {
      throw new Error(`generated package-lock.json ${field} is not in sync with package.json`);
    }
  }
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === "") continue;
    if (!path.startsWith("node_modules/")) throw new Error(`generated package-lock.json has a non-registry package path: ${path}`);
    if (!record(entry) || entry.link === true) throw new Error(`generated package-lock.json has a linked package: ${path}`);
    if (typeof entry.resolved !== "string" || !entry.resolved.startsWith(TRUSTED_NPM_REGISTRY)) {
      throw new Error(`generated package-lock.json package is not resolved from the trusted registry: ${path}`);
    }
    if (typeof entry.integrity !== "string" || !/^sha512-[A-Za-z0-9+/=]+$/.test(entry.integrity)) {
      throw new Error(`generated package-lock.json package has no sha512 integrity: ${path}`);
    }
  }
}

function sorted(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = value[key];
  return out;
}

const defaultExecutor: NpmLockExecutor = (cwd, args, env) => {
  const result = spawnSync("npm", [...args], {
    cwd,
    shell: false,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    env,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: `${result.stderr ?? ""}${result.error ? `\n${result.error.message}` : ""}`,
  };
};

/** npm 실행 환경: 토큰 제거, user/global npmrc 무시, registry 고정, script 미실행. */
export function trustedNpmEnvironment(isolatedDirectory: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (/^npm_config_/i.test(key)) continue;
    env[key] = value;
  }
  return {
    ...env,
    GH_TOKEN: "",
    GITHUB_TOKEN: "",
    NODE_AUTH_TOKEN: "",
    NPM_TOKEN: "",
    npm_config_userconfig: join(isolatedDirectory, "empty-user.npmrc"),
    npm_config_globalconfig: join(isolatedDirectory, "empty-global.npmrc"),
    npm_config_registry: TRUSTED_NPM_REGISTRY,
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };
}

/** 격리된 임시 디렉터리에서 trusted lockfile을 생성한다. */
export function generateTrustedLockfile(
  input: { readonly packageJson: string; readonly baseLockfile: string | null },
  executor: NpmLockExecutor = defaultExecutor,
): string {
  validateProposedManifest(input.packageJson);
  const root = mkdtempSync(join(tmpdir(), "trusted-lockfile-"));
  try {
    const project = join(root, "project");
    const config = join(root, "config");
    mkdirSync(project);
    mkdirSync(config);
    writeFileSync(join(config, "empty-user.npmrc"), "");
    writeFileSync(join(config, "empty-global.npmrc"), "");
    writeFileSync(join(project, TRUSTED_MANIFEST_PATH), input.packageJson);
    if (input.baseLockfile !== null) writeFileSync(join(project, TRUSTED_LOCKFILE_PATH), input.baseLockfile);

    const outcome = executor(project, TRUSTED_LOCKFILE_NPM_ARGS, trustedNpmEnvironment(config));
    if (outcome.status !== 0 || outcome.signal !== null) {
      const detail = `${outcome.stdout}\n${outcome.stderr}`.trim().split(/\r?\n/).slice(-12).join("\n");
      throw new Error(`trusted package-lock.json generation failed (exit ${String(outcome.status)}): ${detail}`);
    }
    let generated: string;
    try {
      generated = readFileSync(join(project, TRUSTED_LOCKFILE_PATH), "utf8");
    } catch {
      throw new Error("trusted package-lock.json generation produced no lockfile");
    }
    verifyGeneratedLockfile(generated, input.packageJson);
    return generated;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * untrusted Worker proposal에 trusted lockfile을 결합한다.
 *  - AI가 제안한 package-lock.json change는 항상 버린다.
 *  - package.json을 바꾸면 trusted lock을 생성해 change로 추가한다(base와 같으면 추가하지 않음).
 */
export function applyTrustedLockfile(
  contract: ImplementContract,
  context: ImplementContextPack,
  proposal: WorkerProposal,
  executor: NpmLockExecutor = defaultExecutor,
): TrustedLockfileResult {
  if (!record(proposal) || !Array.isArray(proposal.changes)) throw new Error("worker proposal must contain changes");
  const changes = proposal.changes as readonly WorkerChangeProposal[];
  const kept = changes.filter((change) => change?.path !== TRUSTED_LOCKFILE_PATH);
  const droppedUntrustedLockfile = kept.length !== changes.length;

  // Pre-validation: AI가 제안한 lock을 제거한 untrusted proposal이 기존 candidate 계약을 통과해야만
  // trusted npm을 실행한다. 기존 createCandidateChangeSet()을 그대로 재사용하므로
  // allowedPaths(Context Pack membership) / operation / exact baseContentDigest / no-op /
  // duplicate path / maxFilesChanged / untrusted maxPatchBytes 규칙이 한 글자도 다르지 않다.
  // (여기서 만든 candidate는 버린다. 최종 candidate는 호출자가 lock을 결합한 proposal로 다시 만든다.)
  createCandidateChangeSet(contract, context, { summary: proposal.summary, changes: kept });

  const manifestChanges = kept.filter((change) => change.path === TRUSTED_MANIFEST_PATH);
  if (manifestChanges.length === 0) {
    return { proposal: { summary: proposal.summary, changes: kept }, status: "NOT_NEEDED", droppedUntrustedLockfile };
  }
  const manifestChange = manifestChanges[0]!;
  // trusted lock change가 들어갈 자리가 maxFilesChanged 안에 있어야 한다 (npm 실행 전에 확인).
  if (kept.length + 1 > contract.scope.maxFilesChanged) {
    throw new Error("worker proposal leaves no room for the trusted package-lock.json within maxFilesChanged");
  }
  if (typeof manifestChange.content !== "string") throw new Error("package.json change content must be a string");

  const lockContext = context.files.find((file) => file.path === TRUSTED_LOCKFILE_PATH);
  if (!lockContext) {
    throw new Error("package.json change requires package-lock.json within the approved allowedPaths");
  }
  const baseLockfile = lockContext.state === "present" ? lockContext.content : null;
  const generated = generateTrustedLockfile({ packageJson: manifestChange.content, baseLockfile }, executor);

  if (baseLockfile !== null && generated === baseLockfile) {
    return { proposal: { summary: proposal.summary, changes: kept }, status: "UNCHANGED", droppedUntrustedLockfile };
  }
  const lockChange: WorkerChangeProposal = lockContext.state === "present"
    ? { path: TRUSTED_LOCKFILE_PATH, operation: "modify", baseContentDigest: lockContext.contentDigest, content: generated }
    : { path: TRUSTED_LOCKFILE_PATH, operation: "create", baseContentDigest: null, content: generated };
  return {
    proposal: { summary: proposal.summary, changes: [...kept, lockChange] },
    status: "GENERATED",
    droppedUntrustedLockfile,
  };
}
