import { pathToFileURL } from 'node:url';
import { collectAiUsageEvidence, type AiUsageStage } from './ai-usage-evidence-collector.js';
import { parseInvocationEvidence } from './ai-usage-evidence.js';
import { aggregateAiUsageRecord, type AiUsageRecord, type StageExecutionObservation } from './ai-usage-record.js';
import { createGithubActionsAdapter, type HttpTransport } from './ai-usage-github-actions.js';
import { selectInvocationFragments } from './ai-usage-log-boundaries.js';

export const COLLECTION_STAGES = [
  'PLAN', 'IMPLEMENT/FIX', 'SEMANTIC_REVIEW', 'LEARN', 'PRODUCT_EVALUATION',
] as const satisfies readonly AiUsageStage[];

/** The trusted caller attests completion and stage/run provenance; no discovery. */
export interface CompletedCycleInput {
  readonly owner: string;
  readonly repository: string;
  readonly cycleRef: string;
  readonly runIds: Readonly<Record<AiUsageStage, readonly number[]>>;
}

function validate(input: CompletedCycleInput): CompletedCycleInput {
  if (!input || typeof input.owner !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(input.owner) ||
      typeof input.repository !== 'string' ||
      !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(input.repository) ||
      typeof input.cycleRef !== 'string' || input.cycleRef.trim() === '' ||
      !input.runIds || typeof input.runIds !== 'object' || Array.isArray(input.runIds) ||
      Reflect.ownKeys(input.runIds).length !== COLLECTION_STAGES.length ||
      !COLLECTION_STAGES.every(stage => Object.prototype.hasOwnProperty.call(input.runIds, stage))) {
    throw new TypeError('Explicit completed-cycle identity and all five stage run lists are required');
  }
  const runIds = {} as Record<AiUsageStage, number[]>;
  const seen = new Set<number>();
  for (const stage of COLLECTION_STAGES) {
    const values = input.runIds[stage];
    if (!Array.isArray(values) || values.length === 0) throw new TypeError('Stage run list must be nonempty');
    const snapshot: number[] = [];
    for (const value of values) {
      if (!Number.isSafeInteger(value) || value <= 0 || seen.has(value)) {
        throw new TypeError('Run IDs must be distinct positive safe integers');
      }
      seen.add(value);
      snapshot.push(value);
    }
    runIds[stage] = snapshot.sort((a, b) => a - b);
  }
  return { owner: input.owner, repository: input.repository, cycleRef: input.cycleRef, runIds };
}

export async function collectCompletedCycle(
  input: CompletedCycleInput,
  token: string,
  transport?: HttpTransport,
): Promise<AiUsageRecord> {
  // Validate and snapshot the entire input before the first external request.
  const target = validate(input);
  const adapter = createGithubActionsAdapter(token, transport);
  const observations: StageExecutionObservation[] = [];
  for (const collectionStage of COLLECTION_STAGES) {
    const stage = collectionStage === 'IMPLEMENT/FIX' ? 'IMPLEMENT' : collectionStage;
    const jobs = await collectAiUsageEvidence(target.runIds[collectionStage].map(runId => ({
      owner: target.owner, repo: target.repository, runId, stage: collectionStage,
    })), {
      ...adapter,
      parseEvidence: ({ owner, repo, runId, jobId, rawLog }) =>
        selectInvocationFragments(rawLog).map(fragment => parseInvocationEvidence({
          owner, repo, runId: String(runId), jobId: String(jobId), stage, ...fragment,
        })),
    });
    for (const job of jobs) {
      for (const { sourceRef, model, tokenUsage } of job.evidence) {
        observations.push({ stage, sourceRef, model, tokenUsage });
      }
    }
  }
  return aggregateAiUsageRecord({ cycleRef: target.cycleRef, observations });
}

function environmentRunId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) throw new TypeError('Explicit run ID required');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError('Unsafe run ID');
  return parsed;
}

export async function runCollectionCli(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const repository = env.GITHUB_REPOSITORY?.split('/');
  if (!repository || repository.length !== 2) throw new TypeError('Trusted repository identity required');
  const record = await collectCompletedCycle({
    owner: repository[0]!, repository: repository[1]!, cycleRef: env.CYCLE_REF ?? '',
    runIds: {
      PLAN: [environmentRunId(env.PLAN_RUN_ID)],
      'IMPLEMENT/FIX': [environmentRunId(env.IMPLEMENT_RUN_ID)],
      SEMANTIC_REVIEW: [environmentRunId(env.SEMANTIC_REVIEW_RUN_ID)],
      LEARN: [environmentRunId(env.LEARN_RUN_ID)],
      PRODUCT_EVALUATION: [environmentRunId(env.PRODUCT_EVALUATION_RUN_ID)],
    },
  }, env.GITHUB_TOKEN ?? '');
  return JSON.stringify(record, null, 2) + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCollectionCli().then(json => process.stdout.write(json)).catch(() => {
    process.stderr.write('AI usage collection failed; no record produced.\n');
    process.exitCode = 1;
  });
}
