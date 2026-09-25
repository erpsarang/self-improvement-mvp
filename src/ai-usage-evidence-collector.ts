/**
 * Internal collection boundary, not an existing provenance or GitHub schema.
 * The trusted caller authenticates cycle completion and stage/run associations.
 * Adapters own authentication, complete job pagination, parser integration and
 * persistence. This core neither interprets usage nor counts invocations.
 */
export type AiUsageStage =
  | 'PLAN'
  | 'IMPLEMENT/FIX'
  | 'SEMANTIC_REVIEW'
  | 'LEARN'
  | 'PRODUCT_EVALUATION';

export interface RunIdentity {
  readonly owner: string;
  readonly repo: string;
  readonly runId: number;
}

export interface StageRunIdentity extends RunIdentity {
  readonly stage: AiUsageStage;
}

export interface JobIdentity extends RunIdentity {
  readonly jobId: number;
}

/** Adapters must return the complete normalized list, in deterministic order. */
export interface NormalizedJob {
  readonly jobId: number;
  readonly skipped: boolean;
}

export interface ListJobsRequest extends RunIdentity {
  readonly method: 'GET';
  readonly endpoint: '/repos/{owner}/{repo}/actions/runs/{run_id}/jobs';
}

export interface JobLogRequest extends JobIdentity {
  readonly method: 'GET';
  readonly endpoint: '/repos/{owner}/{repo}/actions/jobs/{job_id}/logs';
}

export interface EvidenceParserInput extends JobIdentity {
  readonly rawLog: string;
}

export interface CollectorDependencies<T> {
  readonly listJobs: (
    request: ListJobsRequest,
  ) => Promise<readonly NormalizedJob[]>;
  readonly getJobLog: (request: JobLogRequest) => Promise<string>;
  readonly parseEvidence: (input: EvidenceParserInput) => T | Promise<T>;
}

export interface CollectedJobEvidence<T> extends StageRunIdentity {
  readonly jobId: number;
  /** Exact parser return value; no usage fields are synthesized or changed. */
  readonly evidence: T;
}

function validateName(value: string, field: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    /[\s/\\?#]/u.test(value) ||
    value === '.' ||
    value === '..'
  ) {
    throw new TypeError(`${field} must be an explicit repository path segment`);
  }
}

function validateId(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
}

function validateStage(stage: AiUsageStage): void {
  switch (stage) {
    case 'PLAN':
    case 'IMPLEMENT/FIX':
    case 'SEMANTIC_REVIEW':
    case 'LEARN':
    case 'PRODUCT_EVALUATION':
      return;
    default:
      throw new TypeError('Unsupported AI usage stage');
  }
}

export async function collectAiUsageEvidence<T>(
  runs: readonly StageRunIdentity[],
  dependencies: CollectorDependencies<T>,
): Promise<CollectedJobEvidence<T>[]> {
  // Validate and snapshot every requested identity before any external call.
  const targets = runs.map((run) => {
    const { stage, owner, repo, runId } = run;
    validateStage(stage);
    validateName(owner, 'owner');
    validateName(repo, 'repo');
    validateId(runId, 'runId');
    return { stage, owner, repo, runId };
  });
  const collected: CollectedJobEvidence<T>[] = [];

  for (const target of targets) {
    const { stage, owner, repo, runId } = target;
    const listedJobs = await dependencies.listJobs({
      method: 'GET',
      endpoint: '/repos/{owner}/{repo}/actions/runs/{run_id}/jobs',
      owner,
      repo,
      runId,
    });
    const jobs = listedJobs.map((job) => {
      const { jobId, skipped } = job;
      validateId(jobId, 'jobId');
      if (typeof skipped !== 'boolean') {
        throw new TypeError('skipped must be explicit');
      }
      return { jobId, skipped };
    });

    for (const { jobId, skipped } of jobs) {
      if (skipped) continue;
      const identity = { owner, repo, runId, jobId };
      const rawLog = await dependencies.getJobLog({
        method: 'GET',
        endpoint: '/repos/{owner}/{repo}/actions/jobs/{job_id}/logs',
        ...identity,
      });
      if (typeof rawLog !== 'string') {
        throw new TypeError('rawLog must be a string');
      }
      const evidence = await dependencies.parseEvidence({ ...identity, rawLog });
      collected.push({ stage, ...identity, evidence });
    }
  }

  return collected;
}
