import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createGithubActionsAdapter, type HttpResponse } from '../src/ai-usage-github-actions.js';

const identity = { owner: 'owner', repo: 'repo', runId: 1 };
const listing = { ...identity, method: 'GET' as const, endpoint: '/repos/{owner}/{repo}/actions/runs/{run_id}/jobs' as const };
const logging = { ...identity, jobId: 2, method: 'GET' as const, endpoint: '/repos/{owner}/{repo}/actions/jobs/{job_id}/logs' as const };
function response(status: number, body = '', location: string | null = null): HttpResponse {
  return { status, headers: { get: () => location }, text: async () => body };
}

test('paginates all jobs, deduplicates and orders by ID', async () => {
  let calls = 0;
  const adapter = createGithubActionsAdapter('credential', async (url, init) => {
    calls += 1;
    assert.equal(url, `https://api.github.com/repos/owner/repo/actions/runs/1/jobs?per_page=100&page=${calls}`);
    assert.equal(init.redirect, 'manual');
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.Authorization, 'Bearer credential');
    const jobs = calls === 1
      ? Array.from({ length: 100 }, (_, i) => ({ id: 100 - i, conclusion: 'success' }))
      : [{ id: 100, conclusion: 'success' }, { id: 101, conclusion: 'skipped' }];
    return response(200, JSON.stringify({ jobs }));
  });
  const jobs = await adapter.listJobs(listing);
  assert.equal(calls, 2);
  assert.equal(jobs.length, 101);
  assert.deepEqual(jobs[0], { jobId: 1, skipped: false });
  assert.deepEqual(jobs[100], { jobId: 101, skipped: true });
});

test('follows exactly one manual log redirect without credentials', async () => {
  const urls: string[] = [];
  const adapter = createGithubActionsAdapter('credential', async (url, init) => {
    urls.push(url);
    assert.equal(init.redirect, 'manual');
    if (urls.length === 1) {
      assert.equal(init.headers.Authorization, 'Bearer credential');
      return response(302, '', 'https://blob.example/log?signature=private');
    }
    assert.deepEqual(init.headers, {});
    return response(200, 'raw log\n');
  });
  assert.equal(await adapter.getJobLog(logging), 'raw log\n');
  assert.deepEqual(urls, [
    'https://api.github.com/repos/owner/repo/actions/jobs/2/logs',
    'https://blob.example/log?signature=private',
  ]);
});

test('rejects invalid redirect destinations before contacting them', async () => {
  for (const location of [null, '/relative', 'http://blob.example/log', 'https://user:password@blob.example/log']) {
    let calls = 0;
    const adapter = createGithubActionsAdapter('credential', async () => {
      calls += 1;
      return response(302, '', location);
    });
    await assert.rejects(adapter.getJobLog(logging), /^Error: GitHub Actions evidence request failed$/);
    assert.equal(calls, 1);
  }
});

test('does not retry, leak transport details or follow a second redirect', async () => {
  let calls = 0;
  const adapter = createGithubActionsAdapter('credential', async () => {
    calls += 1;
    throw new Error('credential https://blob.example/?signature=private raw log');
  });
  await assert.rejects(adapter.listJobs(listing), /^Error: GitHub Actions evidence request failed$/);
  assert.equal(calls, 1);
  calls = 0;
  const redirecting = createGithubActionsAdapter('credential', async () => {
    calls += 1;
    return response(302, '', 'https://blob.example/log');
  });
  await assert.rejects(redirecting.getJobLog(logging));
  assert.equal(calls, 2);
});

test('fails closed on HTTP failures and malformed or inconsistent job pages', async () => {
  for (const value of [
    response(403, 'sensitive response'), response(200, 'invalid json'),
    response(200, JSON.stringify({ jobs: [{ id: 0, conclusion: 'success' }] })),
    response(200, JSON.stringify({ jobs: [{ id: 1, conclusion: null }] })),
    response(200, JSON.stringify({ jobs: [{ id: 1, conclusion: 'success' }, { id: 1, conclusion: 'skipped' }] })),
  ]) {
    let calls = 0;
    const adapter = createGithubActionsAdapter('credential', async () => { calls += 1; return value; });
    await assert.rejects(adapter.listJobs(listing), /^Error: GitHub Actions evidence request failed$/);
    assert.equal(calls, 1);
  }
});
