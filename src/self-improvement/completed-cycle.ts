import { createHash } from "node:crypto";

export interface CompletedCycleEvidence {
  readonly repository: string;
  readonly requirement: {
    readonly issueNumber: number;
    readonly digest: string;
  };
  readonly mergedPullRequest: {
    readonly number: number;
    readonly merged: boolean;
    readonly headSha: string;
    readonly mergeCommitSha: string | null;
    readonly mergedAt: string | null;
  };
  readonly source: {
    readonly requirement: {
      readonly issueNumber: number;
      readonly digest: string;
    };
    readonly review: {
      readonly decision: string;
      readonly reviewedHeadSha: string;
    };
    readonly trustedRail: {
      readonly runId: number;
      readonly runAttempt: number;
      readonly controlPlaneSha: string;
    };
    readonly orchestrationProvenance: {
      readonly artifact: {
        readonly name: string;
        readonly id: number;
        readonly digest: string;
      };
    };
    readonly frameworkSourceSha: string;
  };
}

export interface CompletedCycleRecordPayload {
  readonly schemaVersion: 1;
  readonly kind: "trusted-completed-cycle-record";
  readonly repository: string;
  readonly requirement: {
    readonly issueNumber: number;
    readonly digest: string;
  };
  readonly humanMerge: {
    readonly pullRequestNumber: number;
    readonly headSha: string;
    readonly mergeCommitSha: string;
    readonly mergedAt: string;
  };
  readonly source: {
    readonly requirement: {
      readonly issueNumber: number;
      readonly digest: string;
    };
    readonly review: {
      readonly decision: "PASS";
      readonly reviewedHeadSha: string;
    };
    readonly trustedRail: {
      readonly runId: number;
      readonly runAttempt: number;
      readonly controlPlaneSha: string;
    };
    readonly orchestrationProvenance: {
      readonly artifact: {
        readonly name: string;
        readonly id: number;
        readonly digest: string;
      };
    };
    readonly frameworkSourceSha: string;
  };
}

export interface CompletedCycleRecord extends CompletedCycleRecordPayload {
  readonly digestAlgorithm: "sha256";
  readonly recordDigest: string;
}

const SHA256 = /^[0-9a-f]{64}$/;
const SHA256_WITH_PREFIX = /^sha256:([0-9a-f]{64})$/;
const GIT_SHA = /^[0-9a-f]{40,64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
}

function assertNonempty(name: string, value: string): void {
  if (!value.trim()) throw new Error(`${name} must be non-empty`);
}

function normalizeSha256(name: string, value: string): string {
  if (SHA256.test(value)) return value;
  const prefixed = SHA256_WITH_PREFIX.exec(value);
  if (prefixed?.[1]) return prefixed[1];
  throw new Error(`${name} must be a lowercase SHA-256 digest`);
}

function assertGitSha(name: string, value: string): void {
  if (!GIT_SHA.test(value)) throw new Error(`${name} must be a lowercase Git commit SHA`);
}

function assertMergedAt(value: string): void {
  if (!ISO_UTC.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error("mergedPullRequest.mergedAt must be a UTC ISO timestamp");
  }
}

function validateEvidence(evidence: CompletedCycleEvidence): {
  requirementDigest: string;
  sourceRequirementDigest: string;
  orchestrationArtifactDigest: string;
  mergeCommitSha: string;
  mergedAt: string;
} {
  assertNonempty("repository", evidence.repository);
  assertPositiveInteger("requirement.issueNumber", evidence.requirement.issueNumber);
  const requirementDigest = normalizeSha256("requirement.digest", evidence.requirement.digest);

  assertPositiveInteger("mergedPullRequest.number", evidence.mergedPullRequest.number);
  if (!evidence.mergedPullRequest.merged) throw new Error("Human Merge PR must be actually merged");
  assertGitSha("mergedPullRequest.headSha", evidence.mergedPullRequest.headSha);
  if (evidence.mergedPullRequest.mergeCommitSha === null) {
    throw new Error("mergedPullRequest.mergeCommitSha is required");
  }
  assertGitSha("mergedPullRequest.mergeCommitSha", evidence.mergedPullRequest.mergeCommitSha);
  if (evidence.mergedPullRequest.mergedAt === null) {
    throw new Error("mergedPullRequest.mergedAt is required");
  }
  assertMergedAt(evidence.mergedPullRequest.mergedAt);

  assertPositiveInteger("source.requirement.issueNumber", evidence.source.requirement.issueNumber);
  const sourceRequirementDigest = normalizeSha256(
    "source.requirement.digest",
    evidence.source.requirement.digest,
  );
  if (
    evidence.requirement.issueNumber !== evidence.source.requirement.issueNumber ||
    requirementDigest !== sourceRequirementDigest
  ) {
    throw new Error("requirement identity does not match source provenance");
  }

  if (evidence.source.review.decision !== "PASS") {
    throw new Error("final REVIEW decision must be PASS");
  }
  assertGitSha("source.review.reviewedHeadSha", evidence.source.review.reviewedHeadSha);
  if (evidence.mergedPullRequest.headSha !== evidence.source.review.reviewedHeadSha) {
    throw new Error("Human Merge PR head SHA must equal reviewed exact SHA");
  }

  assertPositiveInteger("source.trustedRail.runId", evidence.source.trustedRail.runId);
  assertPositiveInteger("source.trustedRail.runAttempt", evidence.source.trustedRail.runAttempt);
  assertGitSha("source.trustedRail.controlPlaneSha", evidence.source.trustedRail.controlPlaneSha);
  assertNonempty(
    "source.orchestrationProvenance.artifact.name",
    evidence.source.orchestrationProvenance.artifact.name,
  );
  assertPositiveInteger(
    "source.orchestrationProvenance.artifact.id",
    evidence.source.orchestrationProvenance.artifact.id,
  );
  const orchestrationArtifactDigest = normalizeSha256(
    "source.orchestrationProvenance.artifact.digest",
    evidence.source.orchestrationProvenance.artifact.digest,
  );
  assertGitSha("source.frameworkSourceSha", evidence.source.frameworkSourceSha);

  return {
    requirementDigest,
    sourceRequirementDigest,
    orchestrationArtifactDigest,
    mergeCommitSha: evidence.mergedPullRequest.mergeCommitSha,
    mergedAt: evidence.mergedPullRequest.mergedAt,
  };
}

export function completedCycleRecordArtifactName(evidence: CompletedCycleEvidence): string {
  validateEvidence(evidence);
  return `completed-cycle-issue-${evidence.requirement.issueNumber}-pr-${evidence.mergedPullRequest.number}`;
}

export function createCompletedCycleRecord(evidence: CompletedCycleEvidence): CompletedCycleRecord {
  const normalized = validateEvidence(evidence);

  const payload: CompletedCycleRecordPayload = {
    schemaVersion: 1,
    kind: "trusted-completed-cycle-record",
    repository: evidence.repository,
    requirement: {
      issueNumber: evidence.requirement.issueNumber,
      digest: normalized.requirementDigest,
    },
    humanMerge: {
      pullRequestNumber: evidence.mergedPullRequest.number,
      headSha: evidence.mergedPullRequest.headSha,
      mergeCommitSha: normalized.mergeCommitSha,
      mergedAt: normalized.mergedAt,
    },
    source: {
      requirement: {
        issueNumber: evidence.source.requirement.issueNumber,
        digest: normalized.sourceRequirementDigest,
      },
      review: {
        decision: "PASS",
        reviewedHeadSha: evidence.source.review.reviewedHeadSha,
      },
      trustedRail: { ...evidence.source.trustedRail },
      orchestrationProvenance: {
        artifact: {
          name: evidence.source.orchestrationProvenance.artifact.name,
          id: evidence.source.orchestrationProvenance.artifact.id,
          digest: normalized.orchestrationArtifactDigest,
        },
      },
      frameworkSourceSha: evidence.source.frameworkSourceSha,
    },
  };

  const recordDigest = createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
  return { ...payload, digestAlgorithm: "sha256", recordDigest };
}

export function verifyCompletedCycleRecord(record: CompletedCycleRecord): void {
  if (
    record.schemaVersion !== 1 ||
    record.kind !== "trusted-completed-cycle-record" ||
    record.digestAlgorithm !== "sha256"
  ) {
    throw new Error("unsupported completed cycle record schema");
  }
  normalizeSha256("recordDigest", record.recordDigest);

  const regenerated = createCompletedCycleRecord({
    repository: record.repository,
    requirement: record.requirement,
    mergedPullRequest: {
      number: record.humanMerge.pullRequestNumber,
      merged: true,
      headSha: record.humanMerge.headSha,
      mergeCommitSha: record.humanMerge.mergeCommitSha,
      mergedAt: record.humanMerge.mergedAt,
    },
    source: record.source,
  });

  if (JSON.stringify(regenerated) !== JSON.stringify(record)) {
    throw new Error("completed cycle record digest or canonical shape mismatch");
  }
}
