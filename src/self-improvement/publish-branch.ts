import { createHash } from "node:crypto";

// PUBLISH branch identity.
// 하나의 Issue가 여러 slice로 이어지면 issue-only branch(ai-publish/issue-N)는 이전 slice branch와 충돌한다
// (App #250 run 36285848604: "publish branch exists at an unexpected SHA").
// 새 PUBLISH는 Issue + cycle identity branch만 만든다. cycle은 trusted SEAL의 baseSha + sealedPatchDigest다.
// 같은 cycle 재시도는 같은 branch를 재사용하고, 같은 Issue의 다음 slice는 다른 branch를 쓴다.
// 구분자는 '/'가 아닌 '-'다. 남아 있는 legacy branch(ai-publish/issue-N)와 git ref 이름이 충돌하지 않게 한다.

export const PUBLISH_CYCLE_ID_HEX_LENGTH = 16;

function assertIssueNumber(issueNumber: number): void {
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    throw new Error("issue number는 양의 정수여야 합니다");
  }
}

export function publishCycleId(baseSha: string, sealedPatchDigest: string): string {
  if (typeof baseSha !== "string" || !/^[0-9a-f]{40}$/.test(baseSha)) {
    throw new Error("PUBLISH cycle baseSha는 40자리 Git SHA여야 합니다");
  }
  if (typeof sealedPatchDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(sealedPatchDigest)) {
    throw new Error("PUBLISH cycle sealedPatchDigest가 올바르지 않습니다");
  }
  return createHash("sha256")
    .update(`${baseSha}:${sealedPatchDigest}`, "utf8")
    .digest("hex")
    .slice(0, PUBLISH_CYCLE_ID_HEX_LENGTH);
}

export function cyclePublishBranchName(issueNumber: number, baseSha: string, sealedPatchDigest: string): string {
  assertIssueNumber(issueNumber);
  return `ai-publish/issue-${issueNumber}-cycle-${publishCycleId(baseSha, sealedPatchDigest)}`;
}

/** 이 변경 이전 PUBLISH가 만든 branch 이름이다. historical provenance를 읽을 때만 허용한다. */
export function legacyPublishBranchName(issueNumber: number): string {
  assertIssueNumber(issueNumber);
  return `ai-publish/issue-${issueNumber}`;
}

export function isCyclePublishBranchForIssue(branch: unknown, issueNumber: number): branch is string {
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) return false;
  return typeof branch === "string" &&
    new RegExp(`^ai-publish/issue-${issueNumber}-cycle-[0-9a-f]{${PUBLISH_CYCLE_ID_HEX_LENGTH}}$`).test(branch);
}

/** 같은 Issue의 legacy 또는 cycle 형식 branch인지 확인한다. */
export function isPublishBranchForIssue(branch: unknown, issueNumber: number): branch is string {
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) return false;
  return branch === `ai-publish/issue-${issueNumber}` || isCyclePublishBranchForIssue(branch, issueNumber);
}
