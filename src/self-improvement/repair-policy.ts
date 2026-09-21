import type { DeterministicValidationResult } from "./deterministic-ci.js";

export type RepairEligibility =
  | { readonly allowed: true; readonly reason: "REPAIR_ALLOWED"; readonly sourcePaths: readonly string[] }
  | { readonly allowed: false; readonly reason: "OUT_OF_SCOPE_BOUNDARY"; readonly sourcePaths: readonly string[] }
  | { readonly allowed: false; readonly reason: "DEPENDENCY_LOCK_MISMATCH"; readonly sourcePaths: readonly string[] };

const BOUNDARY_SIGNAL =
  /\b(?:budget|bounded|forbidden|not allowed|outside|scope|limits?|exceeds?|exceeded)\b/i;
const SOURCE_FRAME =
  /(?:^|[\s(])(?:[^\s():]+\/)*(src\/[A-Za-z0-9._/-]+):\d+:\d+/g;

const NPM_LOCK_SYNC_SIGNAL =
  /(?:npm ci[\s\S]{0,240}package\.json[\s\S]{0,240}package-lock\.json[\s\S]{0,240}in sync|Missing:\s+[^\r\n]+\s+from lock file)/i;

function dependencyLockBoundaryPaths(validation: DeterministicValidationResult): readonly string[] {
  for (const command of validation.commands) {
    if (
      command.status === "FAIL" &&
      command.executable === "npm" &&
      command.args[0] === "ci" &&
      NPM_LOCK_SYNC_SIGNAL.test(`${command.stdout}\n${command.stderr}`)
    ) {
      return ["package-lock.json"];
    }
  }
  return [];
}

function boundarySourcePaths(validation: DeterministicValidationResult): readonly string[] {
  const found = new Set<string>();

  for (const command of validation.commands) {
    if (command.status !== "FAIL") continue;
    const lines = `${command.stdout}\n${command.stderr}`.split(/\r?\n/u);

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      SOURCE_FRAME.lastIndex = 0;
      const matches = [...line.matchAll(SOURCE_FRAME)];
      if (matches.length === 0) continue;

      const window = lines
        .slice(Math.max(0, index - 5), Math.min(lines.length, index + 3))
        .join("\n");
      if (!BOUNDARY_SIGNAL.test(window)) continue;

      for (const match of matches) {
        const path = match[1];
        if (path) found.add(path);
      }
    }
  }

  return [...found].sort((a, b) => a.localeCompare(b));
}

export function classifyRepairEligibility(
  allowedPaths: readonly string[],
  validation: DeterministicValidationResult,
): RepairEligibility {
  if (validation.status !== "FAIL") {
    return { allowed: true, reason: "REPAIR_ALLOWED", sourcePaths: [] };
  }

  // package.json / package-lock.json 불일치는 AI repair로 절대 고칠 수 없다.
  // (lockfile은 trusted deterministic step이 생성한다. AI는 integrity hash가 들어간 lock을 만들 수 없다.)
  // allowedPaths에 package-lock.json이 있든 없든 AI를 호출하지 않고 fail-closed 한다.
  const lockPaths = dependencyLockBoundaryPaths(validation);
  if (lockPaths.length > 0) {
    return { allowed: false, reason: "DEPENDENCY_LOCK_MISMATCH", sourcePaths: lockPaths };
  }

  const sourcePaths = [...new Set([
    ...boundarySourcePaths(validation),
  ])].sort((a, b) => a.localeCompare(b));
  if (sourcePaths.length === 0) {
    return { allowed: true, reason: "REPAIR_ALLOWED", sourcePaths };
  }

  const allowed = new Set(allowedPaths);
  if (sourcePaths.some((path) => allowed.has(path))) {
    return { allowed: true, reason: "REPAIR_ALLOWED", sourcePaths };
  }

  return { allowed: false, reason: "OUT_OF_SCOPE_BOUNDARY", sourcePaths };
}
