import type { JobLogRequest, ListJobsRequest, NormalizedJob } from './ai-usage-evidence-collector.js';

export interface HttpResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type HttpTransport = (
  url: string,
  init: { method: 'GET'; redirect: 'manual'; headers: Record<string, string> },
) => Promise<HttpResponse>;

export const githubHttpTransport: HttpTransport = (url, init) => fetch(url, init);

function fail(): never {
  // Never expose credentials, response bodies, signed URLs or transport errors.
  throw new Error('GitHub Actions evidence request failed');
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}

function id(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) fail();
  return value;
}

function repositoryPath(owner: string, repo: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(owner) ||
      !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(repo)) fail();
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

export function createGithubActionsAdapter(token: string, transport: HttpTransport = githubHttpTransport) {
  if (typeof token !== 'string' || token.trim() === '' || /[\r\n]/.test(token)) fail();
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  async function request(url: string, authenticated: boolean): Promise<HttpResponse> {
    try {
      return await transport(url, {
        method: 'GET', redirect: 'manual', headers: authenticated ? { ...headers } : {},
      });
    } catch {
      return fail();
    }
  }

  return {
    async listJobs(input: ListJobsRequest): Promise<NormalizedJob[]> {
      try {
        const base = repositoryPath(input.owner, input.repo);
        const runId = id(input.runId);
        const jobs = new Map<number, boolean>();
        for (let page = 1; ; page += 1) {
          const response = await request(`${base}/actions/runs/${runId}/jobs?per_page=100&page=${page}`, true);
          if (response.status !== 200) fail();
          const body = object(JSON.parse(await response.text()) as unknown);
          if (!Array.isArray(body.jobs) || body.jobs.length > 100) fail();
          const previousSize = jobs.size;
          for (const raw of body.jobs) {
            const job = object(raw);
            const jobId = id(job.id);
            // A completed-cycle collection must not silently consume active jobs.
            if (typeof job.conclusion !== 'string' || job.conclusion.length === 0) fail();
            const skipped = job.conclusion === 'skipped';
            if (jobs.has(jobId) && jobs.get(jobId) !== skipped) fail();
            jobs.set(jobId, skipped);
          }
          if (body.jobs.length < 100) break;
          if (jobs.size === previousSize) fail();
        }
        return [...jobs].sort(([a], [b]) => a - b).map(([jobId, skipped]) => ({ jobId, skipped }));
      } catch {
        return fail();
      }
    },

    async getJobLog(input: JobLogRequest): Promise<string> {
      try {
        const base = repositoryPath(input.owner, input.repo);
        id(input.runId);
        const response = await request(`${base}/actions/jobs/${id(input.jobId)}/logs`, true);
        if (response.status !== 302) fail();
        const location = response.headers.get('location');
        if (location === null) fail();
        const destination = new URL(location);
        if (destination.protocol !== 'https:' || destination.username || destination.password || destination.hash) fail();
        // One protocol redirect only, not a retry or fallback. No auth forwarding.
        const log = await request(destination.href, false);
        if (log.status !== 200) fail();
        return await log.text();
      } catch {
        return fail();
      }
    },
  };
}
