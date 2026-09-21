/**
 * Candidate Bridge canonical patch 생성 계약.
 *
 * 이전 계약은 "검증이 끝난 worktree의 git status 전체 == candidate 경로"를 요구했다. 그래서
 * 승인된 검증 명령(`npm run build`)이 untracked build artifact(예: dist/)를 만들면, candidate와
 * 무관한 파일 때문에 Bridge가 실패했다 (#176 run 35516108102).
 *
 * 새 계약:
 *  - canonical patch는 candidate의 exact approved paths만 대상으로 만든다.
 *  - candidate 경로의 worktree 내용은 candidate가 제안한 내용과 byte-identical이어야 한다
 *    (검증 명령이 candidate 파일을 바꿨다면 fail-closed). → patch는 candidateDigest가 가리키는 내용 그대로다.
 *  - candidate 밖의 tracked 파일이 수정/삭제/rename/stage 되었으면 fail-closed.
 *  - candidate 밖의 untracked 파일(build artifact)은 canonical patch와 provenance에서 제외한다.
 *  - 생성된 patch는 exact base SHA의 clean worktree에 apply --check 되어야 한다 (기존과 동일).
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CandidatePatchFile {
  readonly path: string;
  readonly content: string;
}

export interface WorktreeStatusEntry {
  /** porcelain v1 XY status (예: " M", "??", "A ", "R ") */
  readonly status: string;
  readonly path: string;
}

export interface ValidationWorktreeClassification {
  /** candidate 경로 (정렬됨). canonical patch의 유일한 대상. */
  readonly candidatePaths: readonly string[];
  /** candidate 밖의 untracked 파일. patch/provenance에서 제외된다. */
  readonly excludedUntrackedPaths: readonly string[];
}

function git(args: readonly string[], cwd: string): string {
  const result = spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    shell: false,
    env: { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: "" },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

/** `git status --porcelain=v1 -z` 출력을 파싱한다 (pure). rename/copy의 두 번째 경로도 소비한다. */
export function parsePorcelainStatus(raw: string): WorktreeStatusEntry[] {
  const tokens = raw.split("\0");
  const entries: WorktreeStatusEntry[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "") continue;
    if (token.length < 4 || token[2] !== " ") throw new Error(`unexpected git status entry: ${token}`);
    const status = token.slice(0, 2);
    entries.push({ status, path: token.slice(3) });
    if (status.includes("R") || status.includes("C")) index += 1; // 원본 경로 token
  }
  return entries;
}

/**
 * 검증이 끝난 worktree 상태를 candidate 경로 기준으로 분류한다 (pure, fail-closed).
 */
export function classifyValidationWorktree(
  entries: readonly WorktreeStatusEntry[],
  expectedPaths: readonly string[],
): ValidationWorktreeClassification {
  const candidatePaths = [...expectedPaths].sort((a, b) => a.localeCompare(b));
  if (candidatePaths.length === 0) throw new Error("candidate must change at least one path");
  if (new Set(candidatePaths).size !== candidatePaths.length) throw new Error("candidate paths must be unique");
  const expected = new Set(candidatePaths);

  const seen = new Set<string>();
  const excluded: string[] = [];
  const trackedOutside: string[] = [];
  for (const entry of entries) {
    const untracked = entry.status === "??";
    if (expected.has(entry.path)) {
      // candidate 경로는 worktree 변경(수정) 또는 untracked(신규)만 허용한다. stage/삭제/rename은 허용하지 않는다.
      if (!untracked && entry.status !== " M") {
        throw new Error(`candidate path has an unexpected git status "${entry.status}": ${entry.path}`);
      }
      seen.add(entry.path);
      continue;
    }
    if (untracked) excluded.push(entry.path);
    else trackedOutside.push(`${entry.status.trim() || entry.status}:${entry.path}`);
  }

  if (trackedOutside.length > 0) {
    throw new Error(`validation modified tracked files outside the candidate: ${trackedOutside.sort().join(",")}`);
  }
  const missing = candidatePaths.filter((path) => !seen.has(path));
  if (missing.length > 0) {
    throw new Error(`candidate paths are not changed in the validation worktree: ${missing.join(",")}`);
  }
  return {
    candidatePaths,
    excludedUntrackedPaths: excluded.sort((a, b) => a.localeCompare(b)),
  };
}

/** candidate 경로의 worktree 내용이 candidate 제안 내용과 byte-identical인지 확인한다. */
function assertCandidateContentIntact(targetDirectory: string, files: readonly CandidatePatchFile[]): void {
  for (const file of files) {
    const absolute = join(targetDirectory, file.path);
    if (!existsSync(absolute)) throw new Error(`candidate path is missing after validation: ${file.path}`);
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`candidate path is not a regular file after validation: ${file.path}`);
    if (!readFileSync(absolute).equals(Buffer.from(file.content, "utf8"))) {
      throw new Error(`validation changed candidate file content: ${file.path}`);
    }
  }
}

export function createCanonicalCandidatePatch(
  targetDirectory: string,
  baseSha: string,
  candidateFiles: readonly CandidatePatchFile[],
): { readonly patch: Buffer; readonly classification: ValidationWorktreeClassification } {
  if (git(["rev-parse", "HEAD"], targetDirectory).trim() !== baseSha) {
    throw new Error("validation worktree HEAD is not the exact base SHA");
  }
  const raw = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], targetDirectory);
  const classification = classifyValidationWorktree(
    parsePorcelainStatus(raw),
    candidateFiles.map(({ path }) => path),
  );
  assertCandidateContentIntact(targetDirectory, candidateFiles);
  const expected = [...classification.candidatePaths];

  // patch 대상은 candidate exact paths뿐이다. 그 밖의 untracked 파일은 index에 넣지 않는다.
  git(["add", "-N", "--", ...expected], targetDirectory);
  const names = git(["diff", "--name-only", "--no-ext-diff", "HEAD", "--", ...expected], targetDirectory)
    .split("\n").filter(Boolean).sort((a, b) => a.localeCompare(b));
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`candidate patch paths mismatch: actual=${names.join(",")} expected=${expected.join(",")}`);
  }
  const patch = Buffer.from(
    git(["diff", "--binary", "--full-index", "--no-ext-diff", "HEAD", "--", ...expected], targetDirectory),
    "utf8",
  );
  if (patch.length === 0) throw new Error("generated candidate patch is empty");

  const checkRoot = mkdtempSync(join(tmpdir(), "plan-bridge-patch-check-"));
  const checkDir = join(checkRoot, "worktree");
  try {
    git(["worktree", "add", "--detach", checkDir, baseSha], targetDirectory);
    const patchFile = join(checkRoot, "candidate.patch.check");
    writeFileSync(patchFile, patch);
    git(["apply", "--check", "--binary", patchFile], checkDir);
  } finally {
    try { git(["worktree", "remove", "--force", checkDir], targetDirectory); } catch { /* best-effort cleanup below */ }
    rmSync(checkRoot, { recursive: true, force: true });
  }
  return { patch, classification };
}
