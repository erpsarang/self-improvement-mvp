import { appendFileSync } from "node:fs";
import {
  classifyPlanFailure,
  decidePlanRetry,
  MAX_AUTO_PLAN_RETRY_PER_REQUIREMENT,
  parsePlanRetryRecords,
  planRetryMarker,
  planRetryStopMarker,
  type PlanRetryKey,
} from "./plan-retry.js";

const SHA256 = /^[0-9a-f]{64}$/;
const TRUSTED_COMMENT_LOGIN = "github-actions[bot]";

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}

function optional(name: string): string {
  return process.env[name] ?? "";
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

function repositoryParts(): { owner: string; repo: string; repository: string } {
  const repository = required("GITHUB_REPOSITORY");
  const [owner, repo, ...extra] = repository.split("/");
  if (!owner || !repo || extra.length > 0) throw new Error("invalid GITHUB_REPOSITORY");
  return { owner, repo, repository };
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${required("GITHUB_TOKEN")}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "self-improvement-mvp-plan-retry",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path}`);
  return response;
}

async function api<T>(path: string): Promise<T> {
  return await (await request(path)).json() as T;
}

async function allComments(owner: string, repo: string, issueNumber: number): Promise<any[]> {
  const comments: any[] = [];
  for (let page = 1; ; page += 1) {
    const batch = await api<any[]>(`/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`);
    comments.push(...batch);
    if (batch.length < 100) return comments;
  }
}

function planIdentity(repository: string): PlanRetryKey & { readonly targetSha: string } {
  const identity = JSON.parse(required("PLAN_IDENTITY")) as any;
  if (identity?.schemaVersion !== 1 || identity.repository !== repository) throw new Error("PLAN identity repository mismatch");
  const issueNumber = Number(identity.requirement?.issueNumber);
  const requirementDigest = String(identity.requirement?.digest ?? "");
  const targetSha = String(identity.targetSha ?? "");
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new Error("PLAN identity issue number is invalid");
  if (!SHA256.test(requirementDigest)) throw new Error("PLAN identity requirement digest is invalid");
  if (!/^[0-9a-f]{40}$/.test(targetSha)) throw new Error("PLAN identity target SHA is invalid");
  return { issueNumber, requirementDigest, targetSha };
}

async function main(): Promise<void> {
  const { owner, repo, repository } = repositoryParts();
  const key = planIdentity(repository);
  const sourceRunId = positiveInteger("SOURCE_RUN_ID");
  const sourceRunAttempt = positiveInteger("SOURCE_RUN_ATTEMPT");
  // 저장소 변수 AUTO_REPLAN이 정확히 "off"일 때만 끈다. 없으면 켜져 있어 App bootstrap 설정이 늘지 않는다.
  const enabled = optional("AUTO_REPLAN").trim() !== "off";

  const classification = classifyPlanFailure({
    executorFailureReason: optional("PLAN_EXECUTOR_FAILURE_REASON"),
    validationFailureReason: optional("PLAN_FAILURE_REASON"),
    resultTimedOut: optional("PLAN_RESULT_TIMEOUT"),
    requestResult: optional("REQUEST_RESULT"),
    resolveResult: optional("RESOLVE_RESULT"),
  });
  output("failure_code", classification.code);
  output("retryable", classification.retryable);

  const issue = await api<any>(`/repos/${owner}/${repo}/issues/${key.issueNumber}`);
  if (issue.pull_request) throw new Error("requirement Issue expected");
  if (issue.state !== "open") {
    output("outcome", "ISSUE_CLOSED");
    output("dispatched", false);
    return;
  }

  // 예산과 중복 판정은 trusted bot 댓글의 marker에서만 읽는다. Issue 본문이나 사람 댓글은 입력이 아니다.
  const comments = await allComments(owner, repo, key.issueNumber);
  const trustedBodies = comments
    .filter((comment) => comment.user?.login === TRUSTED_COMMENT_LOGIN)
    .map((comment) => typeof comment.body === "string" ? comment.body : "")
    .filter(Boolean);
  const priorRecords = parsePlanRetryRecords(trustedBodies, key);
  const decision = decidePlanRetry({ enabled, classification, priorRecords, sourceRunId });
  output("outcome", decision.outcome);
  output("retry_count", priorRecords.length);

  const runUrl = `https://github.com/${repository}/actions/runs/${sourceRunId}`;

  if (decision.outcome === "BUDGET_EXHAUSTED" || decision.outcome === "SAME_CODE_REPEATED") {
    const stopMarker = planRetryStopMarker(key);
    if (!trustedBodies.some((body) => body.includes(stopMarker))) {
      const codes = priorRecords.map((record) => `\`${record.code}\``).join(", ");
      const stopBody = [
        stopMarker,
        "## PLAN 자동 재시도 중지",
        decision.outcome === "SAME_CODE_REPEATED"
          ? `같은 사유 코드 \`${classification.code}\`로 다시 실패했습니다. 같은 입력을 다시 불러도 결과가 달라질 근거가 없어 멈춥니다.`
          : `이 요구 본문으로 자동 재시도 ${priorRecords.length}회를 이미 사용했습니다(상한 ${MAX_AUTO_PLAN_RETRY_PER_REQUIREMENT}회).`,
        `지금까지의 사유 코드: ${codes || "없음"} → 이번: \`${classification.code}\``,
        `원 run: ${runUrl}`,
        "### HumanStatus: PLAN_FAILED",
        "**현재 상황:** 승인할 PLAN이 없고, 자동 재시도는 더 하지 않습니다.",
        "**다음 행동:** 같은 사유가 반복되면 프레임워크나 executor 쪽 결함일 수 있습니다. 원인을 먼저 확인하고, 필요하면 Issue 본문을 보완한 뒤 Actions → Read-only AI PLAN을 이 Issue 번호로 다시 실행하세요. 진행하지 않으려면 사유를 남기고 Issue를 닫으세요.",
      ].join("\n\n");
      await request(`/repos/${owner}/${repo}/issues/${key.issueNumber}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: stopBody }),
      });
    }
    output("dispatched", false);
    return;
  }

  if (decision.outcome !== "RETRY") {
    output("dispatched", false);
    return;
  }

  const marker = planRetryMarker(key, {
    attempt: decision.attempt,
    code: classification.code,
    sourceRunId,
    sourceRunAttempt,
  });
  const pendingBody = [
    marker,
    `## PLAN 자동 재시도 (${decision.attempt}/${MAX_AUTO_PLAN_RETRY_PER_REQUIREMENT})`,
    `실패 사유 코드: \`${classification.code}\``,
    `원 run: ${runUrl}`,
    "같은 요구 본문으로 Read-only AI PLAN을 다시 시작합니다. Actions에서 사람이 다시 실행할 필요가 없습니다.",
    "새 PLAN이 생성되면 Human `PLAN-승인`이 필요합니다. 자동 재시도는 승인을 대신하지 않습니다.",
    "### HumanStatus: PLAN_REQUEST",
    "**현재 상황:** 자동 재시도로 새 PLAN을 요청하는 중입니다. 아직 승인할 PLAN이 없습니다.",
    "**다음 행동:** 새 PLAN 댓글이 달릴 때까지 기다리세요. 다시 실패하면 같은 사유에서는 자동으로 멈춥니다.",
  ].join("\n\n");

  const pending = await (await request(`/repos/${owner}/${repo}/issues/${key.issueNumber}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: pendingBody }),
  })).json() as any;

  const repositoryInfo = await api<any>(`/repos/${owner}/${repo}`);
  const defaultBranch = repositoryInfo.default_branch;
  if (typeof defaultBranch !== "string" || !defaultBranch) throw new Error("default branch missing");

  try {
    // dispatch input은 Issue 번호뿐이다. 사유 텍스트나 본문은 넘기지 않고, 새 run이 본문과 target SHA를 다시 얼린다.
    await request(`/repos/${owner}/${repo}/actions/workflows/plan.yml/dispatches`, {
      method: "POST",
      body: JSON.stringify({ ref: defaultBranch, inputs: { issue_number: String(key.issueNumber) } }),
    });
  } catch (error) {
    if (Number.isSafeInteger(Number(pending.id))) {
      try {
        await request(`/repos/${owner}/${repo}/issues/comments/${Number(pending.id)}`, { method: "DELETE" });
      } catch {
        // Best effort cleanup. Original dispatch error is authoritative.
      }
    }
    throw error;
  }

  output("dispatched", true);
}

await main();
