import { appendFileSync } from "node:fs";
import { requirementDigest } from "./plan-authorization.js";
import {
  decideEditedPlanStart,
  MAX_AUTO_PLAN_DISTINCT_REQUIREMENTS_PER_ISSUE,
  parsePlanRequestRecords,
} from "./plan-edited.js";

const TRUSTED_COMMENT_LOGIN = "github-actions[bot]";

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name: string): number {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function output(name: string, value: string | number | boolean): void {
  const path = process.env.GITHUB_OUTPUT;
  if (path) appendFileSync(path, `${name}=${String(value)}\n`, "utf8");
}

function repositoryParts(): { owner: string; repo: string } {
  const repository = required("GITHUB_REPOSITORY");
  const [owner, repo, ...extra] = repository.split("/");
  if (!owner || !repo || extra.length > 0) throw new Error("invalid GITHUB_REPOSITORY");
  return { owner, repo };
}

async function api<T>(path: string): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${required("GITHUB_TOKEN")}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "self-improvement-mvp-plan-edited",
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path}`);
  return await response.json() as T;
}

async function allComments(owner: string, repo: string, issueNumber: number): Promise<any[]> {
  const comments: any[] = [];
  for (let page = 1; ; page += 1) {
    const batch = await api<any[]>(`/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`);
    comments.push(...batch);
    if (batch.length < 100) return comments;
  }
}

/**
 * `issues.edited`로 시작한 PLAN run의 gate. 읽기만 하고 다음을 출력한다.
 * start=true/false, outcome, distinct_requirements, cap. plan job은 start=true일 때만 실행된다.
 */
async function main(): Promise<void> {
  const { owner, repo } = repositoryParts();
  const issueNumber = positiveInteger("ISSUE_NUMBER");
  output("cap", MAX_AUTO_PLAN_DISTINCT_REQUIREMENTS_PER_ISSUE);

  const issue = await api<any>(`/repos/${owner}/${repo}/issues/${issueNumber}`);
  if (issue.pull_request || typeof issue.title !== "string") throw new Error("requirement Issue expected");
  if (issue.state !== "open") {
    output("start", false);
    output("outcome", "ISSUE_CLOSED");
    return;
  }
  // plan job이 얼리는 digest와 같은 식(UTF-8 JSON.stringify([title, body]))이다.
  const currentRequirementDigest = requirementDigest(issue.title, issue.body ?? null);

  // 지금까지 PLAN한 본문은 trusted bot이 남긴 PLAN_REQUEST marker에서만 읽는다. 사람 댓글과 본문은 입력이 아니다.
  const comments = await allComments(owner, repo, issueNumber);
  const trustedBodies = comments
    .filter((comment) => comment.user?.login === TRUSTED_COMMENT_LOGIN)
    .map((comment) => typeof comment.body === "string" ? comment.body : "")
    .filter(Boolean);
  const priorRequests = parsePlanRequestRecords(trustedBodies, issueNumber);
  const decision = decideEditedPlanStart({ currentRequirementDigest, priorRequests });

  output("start", decision.outcome === "START");
  output("outcome", decision.outcome);
  output("distinct_requirements", decision.distinctRequirements);
  output("requirement_digest", currentRequirementDigest);
}

await main();
