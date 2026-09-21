import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createImplementContextPack } from "../src/self-improvement/context-pack.js";
import { applyCandidateToExactBase } from "../src/self-improvement/deterministic-ci.js";
import { createImplementContract } from "../src/self-improvement/implement-contract.js";
import {
  createCandidateChangeSet,
  TRUSTED_LOCKFILE_MAX_BYTES,
  TRUSTED_LOCKFILE_PATH,
  verifyCandidateChangeSet,
  type WorkerProposal,
} from "../src/self-improvement/single-pass-worker.js";
import {
  applyTrustedLockfile,
  generateTrustedLockfile,
  TRUSTED_LOCKFILE_NPM_ARGS,
  TRUSTED_NPM_REGISTRY,
  validateProposedManifest,
  verifyGeneratedLockfile,
  type NpmLockExecutor,
} from "../src/self-improvement/trusted-lockfile.js";

const baseSha = "b".repeat(40);
const BASE_MANIFEST = `${JSON.stringify({
  name: "app", version: "0.0.0", private: "true", type: "module",
  scripts: { build: "tsc --noEmit" },
  devDependencies: { typescript: "^5.7.2" },
}, null, 2)}\n`;

function sha512(name: string): string {
  return `sha512-${createHash("sha512").update(name).digest("base64")}`;
}

/** package.json의 의존성을 그대로 반영한 lockfileVersion 3 lock을 만든다 (테스트용 deterministic fake). */
function lockFor(manifestText: string, extra: Record<string, Record<string, unknown>> = {}): string {
  const manifest = JSON.parse(manifestText) as Record<string, Record<string, string> | string>;
  const root: Record<string, unknown> = { name: manifest.name, version: manifest.version };
  const packages: Record<string, unknown> = { "": root };
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const deps = manifest[field] as Record<string, string> | undefined;
    if (!deps) continue;
    root[field] = deps;
    for (const name of Object.keys(deps)) {
      packages[`node_modules/${name}`] = {
        version: "1.0.0",
        resolved: `${TRUSTED_NPM_REGISTRY}${name}/-/${name.split("/").pop()}-1.0.0.tgz`,
        integrity: sha512(name),
        dev: field === "devDependencies",
      };
    }
  }
  Object.assign(packages, extra);
  return `${JSON.stringify({ name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages }, null, 2)}\n`;
}

interface Call { cwd: string; args: readonly string[]; env: NodeJS.ProcessEnv; files: string[]; }

function fakeNpm(calls: Call[], produce: (manifestText: string) => string | null = lockFor): NpmLockExecutor {
  return (cwd, args, env) => {
    calls.push({ cwd, args, env, files: readdirSync(cwd).sort() });
    const produced = produce(readFileSync(join(cwd, "package.json"), "utf8"));
    if (produced !== null) writeFileSync(join(cwd, "package-lock.json"), produced);
    return { status: 0, signal: null, stdout: "up to date", stderr: "" };
  };
}

function fixture(options: { lockPresent?: boolean; lockInScope?: boolean; maxPatchBytes?: number; maxFilesChanged?: number } = {}) {
  const { lockPresent = true, lockInScope = true, maxPatchBytes = 2_000 } = options;
  const allowedPaths = ["package.json", "src/web-main.ts", ...(lockInScope ? ["package-lock.json"] : [])];
  const contract = createImplementContract({
    requirement: { issueNumber: 176, digest: "a".repeat(64) },
    repository: "erpsarang/sales-order-exception-analyzer",
    targetSha: baseSha,
    plan: {
      runId: 1, runAttempt: 1,
      artifact: { name: "plan-issue-176-1-attempt-1", id: 1, digest: "c".repeat(64) },
      provenanceArtifact: { name: "plan-issue-176-1-attempt-1-provenance", id: 2, digest: "d".repeat(64) },
    },
    approval: { commentId: 1, approverUserId: 8370921 },
  }, {
    allowedPaths,
    requiredChanges: ["웹 entry 추가"],
    forbiddenChanges: [],
    validationCommands: ["npm test"],
    maxFilesChanged: options.maxFilesChanged ?? allowedPaths.length,
    maxContextBytes: 80_000,
    maxPatchBytes,
  });
  const target = mkdtempSync(join(tmpdir(), "trusted-lockfile-target-"));
  writeFileSync(join(target, "package.json"), BASE_MANIFEST);
  if (lockPresent) writeFileSync(join(target, "package-lock.json"), lockFor(BASE_MANIFEST));
  const context = createImplementContextPack(contract, target, baseSha);
  const file = (path: string) => {
    const found = context.files.find((item) => item.path === path)!;
    assert.equal(found.state, "present");
    return found as Extract<typeof found, { state: "present" }>;
  };
  const withVite = `${JSON.stringify({ ...JSON.parse(BASE_MANIFEST), devDependencies: { typescript: "^5.7.2", vite: "^6.0.0" } }, null, 2)}\n`;
  const manifestChange = { path: "package.json", operation: "modify" as const, baseContentDigest: file("package.json").contentDigest, content: withVite };
  const sourceChange = { path: "src/web-main.ts", operation: "create" as const, baseContentDigest: null, content: "export const main = 1;\n" };
  return { contract, context, target, file, withVite, manifestChange, sourceChange, cleanup: () => rmSync(target, { recursive: true, force: true }) };
}

test("package.json을 바꾸지 않으면 npm을 실행하지 않고, AI가 제안한 package-lock.json은 버린다", () => {
  const f = fixture();
  try {
    const calls: Call[] = [];
    const proposal: WorkerProposal = {
      summary: "web",
      changes: [f.sourceChange, { path: "package-lock.json", operation: "modify", baseContentDigest: f.file("package-lock.json").contentDigest, content: "{\"evil\":true}" }],
    };
    const result = applyTrustedLockfile(f.contract, f.context, proposal, fakeNpm(calls));
    assert.equal(result.status, "NOT_NEEDED");
    assert.equal(result.droppedUntrustedLockfile, true);
    assert.deepEqual(result.proposal.changes, [f.sourceChange]);
    assert.equal(calls.length, 0);
  } finally { f.cleanup(); }
});

test("package.json에 의존성을 추가하면 trusted step이 lock을 생성해 candidate change로 추가한다 (AI lock은 대체)", () => {
  const f = fixture();
  try {
    const calls: Call[] = [];
    const aiLock = { path: "package-lock.json", operation: "modify" as const, baseContentDigest: f.file("package-lock.json").contentDigest, content: "AI가 지어낸 lock" };
    const result = applyTrustedLockfile(f.contract, f.context, { summary: "web", changes: [f.manifestChange, aiLock, f.sourceChange] }, fakeNpm(calls));
    assert.equal(result.status, "GENERATED");
    assert.equal(result.droppedUntrustedLockfile, true);
    assert.deepEqual(result.proposal.changes.map((change) => change.path), ["package.json", "src/web-main.ts", "package-lock.json"]);
    const lockChange = result.proposal.changes[2]!;
    assert.deepEqual(lockChange, {
      path: "package-lock.json",
      operation: "modify",
      baseContentDigest: f.file("package-lock.json").contentDigest,
      content: lockFor(f.withVite),
    });
    assert.notEqual(lockChange.content, aiLock.content);
    assert.match(lockChange.content, /node_modules\/vite/);

    // npm은 격리된 디렉터리에서 package.json + base lock만 가지고, 고정된 인자로 한 번 실행된다.
    assert.equal(calls.length, 1);
    assert.deepEqual([...calls[0]!.args], ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"]);
    assert.deepEqual([...calls[0]!.args], [...TRUSTED_LOCKFILE_NPM_ARGS]);
    assert.deepEqual(calls[0]!.files, ["package-lock.json", "package.json"]);
    assert.notEqual(calls[0]!.cwd, f.target);
  } finally { f.cleanup(); }
});

test("npm 실행 환경: 토큰 제거, user/global npmrc 무시, registry 고정, script 미실행", () => {
  const f = fixture();
  const saved = { ...process.env };
  try {
    process.env.GITHUB_TOKEN = "ghs_secret";
    process.env.GH_TOKEN = "ghs_secret";
    process.env.NODE_AUTH_TOKEN = "npm_secret";
    process.env.NPM_TOKEN = "npm_secret";
    process.env.npm_config_registry = "https://evil.example/";
    process.env.NPM_CONFIG_USERCONFIG = "/home/runner/.npmrc";
    const calls: Call[] = [];
    applyTrustedLockfile(f.contract, f.context, { summary: "web", changes: [f.manifestChange] }, fakeNpm(calls));
    const env = calls[0]!.env;
    for (const key of ["GITHUB_TOKEN", "GH_TOKEN", "NODE_AUTH_TOKEN", "NPM_TOKEN"]) assert.equal(env[key], "", key);
    assert.equal(env.npm_config_registry, TRUSTED_NPM_REGISTRY);
    assert.equal(env.npm_config_ignore_scripts, "true");
    assert.match(String(env.npm_config_userconfig), /empty-user\.npmrc$/);
    assert.match(String(env.npm_config_globalconfig), /empty-global\.npmrc$/);
    assert.equal(env.NPM_CONFIG_USERCONFIG, undefined);
    assert.equal(JSON.stringify(env).includes("secret"), false);
    assert.equal(JSON.stringify(env).includes("evil.example"), false);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    f.cleanup();
  }
});

test("pre-validation: AI lock을 제거한 untrusted proposal이 기존 candidate 계약을 통과해야만 npm을 실행한다", () => {
  const f = fixture({ maxPatchBytes: 600 });
  try {
    const digest = f.file("package.json").contentDigest;
    const aiLock = { path: "package-lock.json", operation: "modify" as const, baseContentDigest: f.file("package-lock.json").contentDigest, content: "AI lock" };
    const rejected: Array<[RegExp, WorkerProposal]> = [
      // allowedPaths 밖
      [/outside allowedPaths: src\/evil\.ts/, { summary: "x", changes: [f.manifestChange, { path: "src/evil.ts", operation: "create", baseContentDigest: null, content: "x" }] }],
      // operation
      [/present path must use modify: package\.json/, { summary: "x", changes: [{ ...f.manifestChange, operation: "create", baseContentDigest: null }] }],
      [/missing path must use create: src\/web-main\.ts/, { summary: "x", changes: [f.manifestChange, { ...f.sourceChange, operation: "modify", baseContentDigest: digest }] }],
      [/unsupported worker operation/, { summary: "x", changes: [{ ...f.manifestChange, operation: "delete" as never }] }],
      // exact baseContentDigest
      [/base content digest mismatch: package\.json/, { summary: "x", changes: [{ ...f.manifestChange, baseContentDigest: "0".repeat(64) }] }],
      [/new file baseContentDigest must be null/, { summary: "x", changes: [f.manifestChange, { ...f.sourceChange, baseContentDigest: digest }] }],
      // no-op
      [/no-op change: package\.json/, { summary: "x", changes: [{ ...f.manifestChange, content: BASE_MANIFEST }] }],
      // duplicate path
      [/paths must be unique/, { summary: "x", changes: [f.manifestChange, f.manifestChange] }],
      // untrusted maxPatchBytes (lock은 아직 없으므로 untrusted 내용만으로 판단된다)
      [/exceeds maxPatchBytes/, { summary: "x", changes: [f.manifestChange, { ...f.sourceChange, content: "x".repeat(601) }] }],
      // AI lock을 버리고 나면 남는 변경이 없음
      [/must contain changes/, { summary: "x", changes: [aiLock] }],
      // summary
      [/summary must be non-empty/, { summary: " ", changes: [f.manifestChange] }],
    ];
    for (const [expected, proposal] of rejected) {
      const calls: Call[] = [];
      assert.throws(() => applyTrustedLockfile(f.contract, f.context, proposal, fakeNpm(calls)), expected, String(expected));
      assert.equal(calls.length, 0, `npm must not run: ${expected}`);
    }
    // AI lock이 섞여 있어도 나머지가 유효하면 통과하고, 그때만 npm이 실행된다.
    const calls: Call[] = [];
    const ok = applyTrustedLockfile(f.contract, f.context, { summary: "web", changes: [f.manifestChange, aiLock, f.sourceChange] }, fakeNpm(calls));
    assert.equal(ok.status, "GENERATED");
    assert.equal(calls.length, 1);
  } finally { f.cleanup(); }
});

test("pre-validation: maxFilesChanged 초과와 trusted lock 자리 부족은 npm 실행 전에 거부한다", () => {
  const f = fixture({ maxFilesChanged: 1 });
  try {
    const tight = f.contract;
    // digest를 다시 계산하지 않고 scope만 바꾼 contract는 pre-validation에서 거부된다.
    assert.throws(
      () => applyTrustedLockfile({ ...f.contract, scope: { ...f.contract.scope, maxFilesChanged: 2 } }, f.context, { summary: "x", changes: [f.manifestChange] }, fakeNpm([])),
      /IMPLEMENT contract digest or canonical shape mismatch/,
    );
    const calls: Call[] = [];
    // untrusted 변경만으로 이미 초과
    assert.throws(() => applyTrustedLockfile(tight, f.context, { summary: "x", changes: [f.manifestChange, f.sourceChange] }, fakeNpm(calls)), /exceeds maxFilesChanged/);
    // untrusted 변경은 한도 안이지만 trusted lock이 들어갈 자리가 없음
    assert.throws(() => applyTrustedLockfile(tight, f.context, { summary: "x", changes: [f.manifestChange] }, fakeNpm(calls)), /no room for the trusted package-lock\.json within maxFilesChanged/);
    assert.equal(calls.length, 0);
    // package.json을 바꾸지 않으면 lock 자리가 필요 없다.
    assert.equal(applyTrustedLockfile(tight, f.context, { summary: "x", changes: [f.sourceChange] }, fakeNpm(calls)).status, "NOT_NEEDED");
    assert.equal(calls.length, 0);
  } finally { f.cleanup(); }
});

test("최종 proposal은 기존 createCandidateChangeSet()으로 다시 전체 검증되어 candidateDigest를 만든다", () => {
  const f = fixture();
  try {
    const { proposal } = applyTrustedLockfile(f.contract, f.context, { summary: "web", changes: [f.manifestChange, f.sourceChange] }, fakeNpm([]));
    const untrustedOnly = createCandidateChangeSet(f.contract, f.context, { summary: "web", changes: [f.manifestChange, f.sourceChange] });
    const final = createCandidateChangeSet(f.contract, f.context, proposal);
    // pre-validation용 candidate와 최종 candidate는 다르다: 최종 digest는 trusted lock을 포함한다.
    assert.notEqual(final.candidateDigest, untrustedOnly.candidateDigest);
    assert.equal(final.changes.length, untrustedOnly.changes.length + 1);
    assert.doesNotThrow(() => verifyCandidateChangeSet(final, f.contract, f.context));
    // handler는 lock 결합 뒤에 createCandidateChangeSet을 호출한다.
    const handler = readFileSync("src/self-improvement/plan-implement-worker-handler.ts", "utf8");
    assert.ok(handler.includes("const proposal = lockfile.proposal;\n  const candidate = createCandidateChangeSet(bundle.contract, bundle.context, proposal);"));
  } finally { f.cleanup(); }
});

test("생성된 lock이 base와 같으면 change를 추가하지 않는다 / lock이 없던 repo는 create로 추가한다", () => {
  const f = fixture();
  try {
    const scriptsOnly = `${JSON.stringify({ ...JSON.parse(BASE_MANIFEST), scripts: { build: "tsc --noEmit", dev: "vite" } }, null, 2)}\n`;
    const change = { ...f.manifestChange, content: scriptsOnly };
    const result = applyTrustedLockfile(f.contract, f.context, { summary: "scripts", changes: [change] }, fakeNpm([]));
    assert.equal(result.status, "UNCHANGED");
    assert.deepEqual(result.proposal.changes, [change]);
  } finally { f.cleanup(); }

  const missing = fixture({ lockPresent: false });
  try {
    const result = applyTrustedLockfile(missing.contract, missing.context, { summary: "web", changes: [missing.manifestChange] }, fakeNpm([]));
    assert.equal(result.status, "GENERATED");
    assert.deepEqual(result.proposal.changes[1], { path: "package-lock.json", operation: "create", baseContentDigest: null, content: lockFor(missing.withVite) });
  } finally { missing.cleanup(); }

  const outOfScope = fixture({ lockInScope: false });
  try {
    assert.throws(
      () => applyTrustedLockfile(outOfScope.contract, outOfScope.context, { summary: "web", changes: [outOfScope.manifestChange] }, fakeNpm([])),
      /requires package-lock\.json within the approved allowedPaths/,
    );
  } finally { outOfScope.cleanup(); }
});

test("untrusted package.json: registry semver 의존성만 허용하고 나머지는 npm 실행 전에 fail-closed", () => {
  const manifest = (patch: Record<string, unknown>) => JSON.stringify({ name: "app", version: "0.0.0", ...patch });
  for (const spec of ["^6.0.0", "~1.2.3", "1.2.3", ">=1.0.0", "5", "5.7", "1.0.0-beta.1"]) {
    assert.doesNotThrow(() => validateProposedManifest(manifest({ dependencies: { vite: spec } })), spec);
  }
  assert.doesNotThrow(() => validateProposedManifest(manifest({ devDependencies: { "@types/node": "^22.10.0" } })));
  const rejectedSpecs = [
    "file:../evil", "git+https://github.com/evil/x.git", "github:evil/x", "https://evil.example/x.tgz",
    "npm:evil@1.0.0", "workspace:*", "link:../x", "*", "latest", "", "^1.0.0 || ^2.0.0", "1.0.0 && rm -rf /",
  ];
  for (const spec of rejectedSpecs) {
    assert.throws(() => validateProposedManifest(manifest({ dependencies: { vite: spec } })), /must be a registry semver range/, spec);
  }
  for (const name of ["../evil", "Evil", "a b", "@scope", "", "https://x"]) {
    assert.throws(() => validateProposedManifest(manifest({ dependencies: { [name]: "1.0.0" } })), /invalid package name/, name);
  }
  assert.throws(() => validateProposedManifest(manifest({ dependencies: { vite: 6 } })), /registry semver range/);
  assert.throws(() => validateProposedManifest(manifest({ dependencies: ["vite"] })), /must be an object/);
  for (const field of ["workspaces", "overrides", "bundleDependencies", "bundledDependencies"]) {
    assert.throws(() => validateProposedManifest(manifest({ [field]: {} })), new RegExp(`must not use ${field}`));
  }
  assert.throws(() => validateProposedManifest("{not json"), /not valid JSON/);
  assert.throws(() => validateProposedManifest("[]"), /must be an object/);

  // 잘못된 manifest는 npm을 실행하지 않는다.
  const f = fixture();
  try {
    const calls: Call[] = [];
    const evil = { ...f.manifestChange, content: manifest({ devDependencies: { vite: "git+https://github.com/evil/x.git" } }) };
    assert.throws(() => applyTrustedLockfile(f.contract, f.context, { summary: "evil", changes: [evil] }, fakeNpm(calls)), /registry semver range/);
    assert.equal(calls.length, 0);
  } finally { f.cleanup(); }
});

test("생성된 lockfile 검증: registry/integrity/sync/version/size 위반은 fail-closed", () => {
  const manifest = fixture();
  try {
    const good = lockFor(manifest.withVite);
    assert.doesNotThrow(() => verifyGeneratedLockfile(good, manifest.withVite));
    const entry = { version: "1.0.0", resolved: `${TRUSTED_NPM_REGISTRY}x/-/x-1.0.0.tgz`, integrity: sha512("x") };
    const bad: Array<[RegExp, string]> = [
      [/not resolved from the trusted registry/, lockFor(manifest.withVite, { "node_modules/x": { ...entry, resolved: "https://evil.example/x.tgz" } })],
      [/not resolved from the trusted registry/, lockFor(manifest.withVite, { "node_modules/x": { version: "1.0.0", integrity: sha512("x") } })],
      [/no sha512 integrity/, lockFor(manifest.withVite, { "node_modules/x": { ...entry, integrity: "sha1-abc" } })],
      [/linked package/, lockFor(manifest.withVite, { "node_modules/x": { resolved: "../x", link: true } })],
      [/non-registry package path/, lockFor(manifest.withVite, { "../outside": entry })],
      [/must be lockfileVersion 3/, good.replace('"lockfileVersion": 3', '"lockfileVersion": 2')],
      [/not in sync with package\.json/, lockFor(BASE_MANIFEST)],
      [/not valid JSON/, "{"],
      [/exceeds trusted size bound/, `${good}${" ".repeat(TRUSTED_LOCKFILE_MAX_BYTES)}`],
    ];
    for (const [expected, lock] of bad) assert.throws(() => verifyGeneratedLockfile(lock, manifest.withVite), expected, String(expected));

    // npm이 실패하거나 lock을 만들지 않거나 검증에 실패하는 lock을 만들면 candidate를 만들지 않는다.
    const failing: NpmLockExecutor = () => ({ status: 1, signal: null, stdout: "", stderr: "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/no-such-pkg" });
    assert.throws(() => generateTrustedLockfile({ packageJson: manifest.withVite, baseLockfile: null }, failing), /generation failed \(exit 1\)[\s\S]*E404/);
    assert.throws(() => generateTrustedLockfile({ packageJson: manifest.withVite, baseLockfile: null }, fakeNpm([], () => null)), /produced no lockfile/);
    assert.throws(
      () => generateTrustedLockfile({ packageJson: manifest.withVite, baseLockfile: null }, fakeNpm([], () => lockFor(BASE_MANIFEST))),
      /not in sync with package\.json/,
    );
  } finally { manifest.cleanup(); }
});

test("trusted lock은 일반 candidate change다: candidateDigest에 묶이고, Bridge식 재검증과 exact-base 적용을 통과한다", () => {
  const f = fixture();
  try {
    const { proposal } = applyTrustedLockfile(f.contract, f.context, { summary: "web", changes: [f.manifestChange, f.sourceChange] }, fakeNpm([]));
    const candidate = createCandidateChangeSet(f.contract, f.context, proposal);
    assert.deepEqual(candidate.changes.map((change) => change.path), ["package-lock.json", "package.json", "src/web-main.ts"]);
    // Candidate Bridge가 하는 것과 같은 재생성 검증
    assert.doesNotThrow(() => verifyCandidateChangeSet(candidate, f.contract, f.context));
    // lock 내용이 바뀌면 candidateDigest가 달라진다 (provenance에 결합됨)
    const tampered = { ...candidate, changes: candidate.changes.map((change) => change.path === "package-lock.json" ? { ...change, content: `${change.content} ` } : change) };
    assert.throws(() => verifyCandidateChangeSet(tampered, f.contract, f.context), /digest or canonical shape mismatch/);
    // exact base에 적용하면 package.json과 lock이 함께 들어간다
    const applied = applyCandidateToExactBase(f.contract, f.context, candidate, f.target, baseSha);
    assert.deepEqual([...applied], ["package-lock.json", "package.json", "src/web-main.ts"]);
    assert.equal(readFileSync(join(f.target, "package-lock.json"), "utf8"), lockFor(f.withVite));
    assert.doesNotThrow(() => verifyGeneratedLockfile(readFileSync(join(f.target, "package-lock.json"), "utf8"), readFileSync(join(f.target, "package.json"), "utf8")));
  } finally { f.cleanup(); }
});

test("patch budget: trusted lock은 untrusted maxPatchBytes에서 제외되지만 자체 상한이 있고, untrusted 내용의 budget은 그대로다", () => {
  const f = fixture({ maxPatchBytes: 1_000 });
  try {
    // 실제 lock은 수십 KB다. untrusted budget(1,000 bytes)보다 훨씬 큰 lock도 candidate에 들어갈 수 있어야 한다.
    const padding: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < 200; i += 1) {
      padding[`node_modules/pad-${i}`] = { version: "1.0.0", resolved: `${TRUSTED_NPM_REGISTRY}pad-${i}/-/pad-${i}-1.0.0.tgz`, integrity: sha512(`pad-${i}`) };
    }
    const bigLock = (manifestText: string) => lockFor(manifestText, padding);
    const { proposal } = applyTrustedLockfile(f.contract, f.context, { summary: "web", changes: [f.manifestChange, f.sourceChange] }, fakeNpm([], bigLock));
    const lockBytes = Buffer.byteLength(proposal.changes.find((change) => change.path === TRUSTED_LOCKFILE_PATH)!.content, "utf8");
    assert.ok(lockBytes > 20_000, String(lockBytes));
    const candidate = createCandidateChangeSet(f.contract, f.context, proposal);
    assert.equal(candidate.outputBytes, proposal.changes.reduce((sum, change) => sum + Buffer.byteLength(change.content, "utf8"), 0)); // outputBytes 의미는 그대로(전체 합)

    // untrusted 내용은 여전히 maxPatchBytes로 묶인다.
    const bigSource = { ...f.sourceChange, content: "x".repeat(1_001) };
    assert.throws(() => createCandidateChangeSet(f.contract, f.context, { summary: "big", changes: [bigSource] }), /exceeds maxPatchBytes/);
    // lock 자체도 상한이 있다.
    const hugeLock = { path: "package-lock.json", operation: "modify" as const, baseContentDigest: f.file("package-lock.json").contentDigest, content: "x".repeat(TRUSTED_LOCKFILE_MAX_BYTES + 1) };
    assert.throws(() => createCandidateChangeSet(f.contract, f.context, { summary: "huge", changes: [hugeLock] }), /exceeds trusted lockfile size bound/);
  } finally { f.cleanup(); }
});

test("Worker validate만 trusted lockfile을 결합하고, workflow / Bridge / Rail / deterministic CI는 바뀌지 않는다", () => {
  const handler = readFileSync("src/self-improvement/plan-implement-worker-handler.ts", "utf8");
  const validateStart = handler.indexOf("async function validate(): Promise<void> {");
  assert.ok(validateStart > 0);
  const validateBody = handler.slice(validateStart);
  assert.ok(validateBody.indexOf("applyTrustedLockfile(bundle.contract, bundle.context, rawProposal)") > 0);
  assert.ok(validateBody.indexOf("applyTrustedLockfile(") < validateBody.indexOf("createCandidateChangeSet(bundle.contract, bundle.context, proposal)"));
  assert.equal((handler.match(/applyTrustedLockfile\(/g) ?? []).length, 1);
  assert.equal(handler.slice(0, validateStart).includes("applyTrustedLockfile("), false); // prepare / reuse는 그대로

  for (const path of [
    ".github/workflows/plan-implement-worker.yml",
    ".github/workflows/plan-candidate-bridge.yml",
    ".github/workflows/trusted-rail.yml",
    "src/self-improvement/plan-candidate-bridge-handler.ts",
    "src/self-improvement/plan-candidate-bridge.ts",
    "src/self-improvement/deterministic-ci.ts",
    "src/self-improvement/seal.ts",
  ]) {
    assert.doesNotMatch(readFileSync(path, "utf8"), /trusted-lockfile|package-lock-only/, path);
  }
  // deterministic CI는 여전히 candidate 적용 후 npm ci로 lock sync를 검증한다.
  assert.match(readFileSync("src/self-improvement/deterministic-ci.ts", "utf8"), /parseValidationCommand\("npm ci --ignore-scripts"\)/);
});
