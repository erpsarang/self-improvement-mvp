import { readFile } from "node:fs/promises";
import {
  APPROVAL_COMMAND,
  authorize,
  type AuthorizationProvenance,
  type TrustedApproverPolicy,
} from "./authorization.js";

export const markerFor = (commentId: number): string =>
  `<!-- self-improvement:AUTHORIZE:approval-comment:${commentId} -->`;

export interface IssueCommentEvent {
  readonly action: string;
  readonly issue: { readonly number: number; readonly pull_request?: unknown };
  readonly comment: {
    readonly id: number;
    readonly body: string;
    readonly created_at: string;
    readonly user: { readonly login: string };
  };
}

export interface AuthorizationCommentStore {
  listBodies(issueNumber: number): Promise<readonly string[]>;
  create(issueNumber: number, body: string): Promise<void>;
}

export type HandleResult = "authorized" | "already-authorized" | "ignored";

/** GitHub event를 검증하고 같은 approval comment에 대해 정확히 한 번 기록한다. */
export async function handleAuthorization(
  event: IssueCommentEvent,
  policy: TrustedApproverPolicy,
  store: AuthorizationCommentStore,
): Promise<HandleResult> {
  if (
    event.action !== "created" ||
    event.issue.pull_request !== undefined ||
    event.comment.body !== APPROVAL_COMMAND
  ) {
    return "ignored";
  }

  const provenance = authorize(
    {
      issueNumber: event.issue.number,
      approvalCommentId: event.comment.id,
      approver: event.comment.user.login,
      command: event.comment.body,
      approvedAt: event.comment.created_at,
    },
    policy,
  );
  const marker = markerFor(event.comment.id);
  if ((await store.listBodies(event.issue.number)).some((body) => body.includes(marker))) {
    return "already-authorized";
  }

  await store.create(event.issue.number, formatAuthorizationComment(marker, provenance));
  return "authorized";
}

function formatAuthorizationComment(
  marker: string,
  provenance: AuthorizationProvenance,
): string {
  return `${marker}\n\`\`\`json\n${JSON.stringify(provenance, null, 2)}\n\`\`\``;
}

export function parseTrustedApproverPolicy(source: string): TrustedApproverPolicy {
  const version = /^version:\s*(\d+)\s*$/m.exec(source)?.[1];
  const approversBlock = /^approvers:\s*$([\s\S]*)/m.exec(source)?.[1] ?? "";
  const approvers = [...approversBlock.matchAll(/^\s+-\s+([A-Za-z0-9-]+)\s*$/gm)].map(
    (match) => match[1]!,
  );
  if (version === undefined || approvers.length === 0) {
    throw new Error("trusted approver policy 형식이 올바르지 않습니다");
  }
  return { version: Number(version), approvers };
}

async function main(): Promise<void> {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!eventPath || !repository || !token) throw new Error("GitHub 실행 환경이 필요합니다");

  const event = JSON.parse(await readFile(eventPath, "utf8")) as IssueCommentEvent;
  const policy = parseTrustedApproverPolicy(
    await readFile("policy/trusted-approvers.yml", "utf8"),
  );
  const request = async (path: string, init?: RequestInit): Promise<Response> => {
    const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...init?.headers,
      },
    });
    if (!response.ok) throw new Error(`GitHub API 오류: ${response.status}`);
    return response;
  };
  const store: AuthorizationCommentStore = {
    async listBodies(issueNumber) {
      const bodies: string[] = [];
      for (let page = 1; ; page += 1) {
        const response = await request(`/issues/${issueNumber}/comments?per_page=100&page=${page}`);
        const comments = (await response.json()) as Array<{ body?: string }>;
        bodies.push(...comments.map(({ body }) => body ?? ""));
        if (comments.length < 100) return bodies;
      }
    },
    async create(issueNumber, body) {
      await request(`/issues/${issueNumber}/comments`, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
    },
  };
  console.log(await handleAuthorization(event, policy, store));
}

if (process.argv[1]?.endsWith("authorize-handler.ts")) await main();
