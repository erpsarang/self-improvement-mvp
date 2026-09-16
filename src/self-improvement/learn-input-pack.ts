import { createHash } from "node:crypto";
import {
  verifyCompletedCycleRecord,
  type CompletedCycleRecord,
} from "./completed-cycle.js";

export type LearnEvidenceKind =
  | "requirement-summary"
  | "final-review"
  | "orchestration-summary"
  | "recovery-event"
  | "human-boundary";

export type LearnEvidenceSource =
  | { readonly kind: "issue"; readonly issueNumber: number }
  | { readonly kind: "pull-request"; readonly pullRequestNumber: number }
  | { readonly kind: "workflow-run"; readonly runId: number; readonly runAttempt: number }
  | {
      readonly kind: "artifact";
      readonly artifactId: number;
      readonly name: string;
      readonly digest: string;
    };

export interface LearnEvidenceInput {
  readonly evidenceId: string;
  readonly kind: LearnEvidenceKind;
  readonly repository: string;
  readonly cycle: {
    readonly recordDigest: string;
    readonly requirementIssueNumber: number;
    readonly humanMergePullRequestNumber: number;
    readonly reviewedHeadSha: string;
  };
  readonly source: LearnEvidenceSource;
  readonly content: string;
}

export interface LearnEvidence extends LearnEvidenceInput {
  readonly byteLength: number;
  readonly digestAlgorithm: "sha256";
  readonly contentDigest: string;
}

export interface LearnInputPackPayload {
  readonly schemaVersion: 1;
  readonly kind: "trusted-learn-input-pack";
  readonly completedCycle: {
    readonly recordDigest: string;
    readonly repository: string;
    readonly requirementIssueNumber: number;
    readonly humanMergePullRequestNumber: number;
    readonly reviewedHeadSha: string;
    readonly mergeCommitSha: string;
    readonly trustedRailRunId: number;
    readonly trustedRailRunAttempt: number;
  };
  readonly frameworkSourceSha: string;
  readonly budget: {
    readonly maxEvidenceItems: number;
    readonly maxItemBytes: number;
    readonly maxTotalBytes: number;
  };
  readonly evidence: readonly LearnEvidence[];
  readonly evidenceCount: number;
  readonly totalEvidenceBytes: number;
}

export interface LearnInputPack extends LearnInputPackPayload {
  readonly digestAlgorithm: "sha256";
  readonly packDigest: string;
}

export const LEARN_INPUT_BUDGET = Object.freeze({
  maxEvidenceItems: 16,
  maxItemBytes: 8_192,
  maxTotalBytes: 65_536,
});

const SHA256 = /^[0-9a-f]{64}$/;
const SHA256_WITH_PREFIX = /^sha256:([0-9a-f]{64})$/;
const GIT_SHA = /^[0-9a-f]{40,64}$/;
const EVIDENCE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const EVIDENCE_KINDS = new Set<string>([
  "requirement-summary",
  "final-review",
  "orchestration-summary",
  "recovery-event",
  "human-boundary",
]);

const ALLOWED_SOURCE_KINDS: Record<LearnEvidenceKind, readonly LearnEvidenceSource["kind"][]> = {
  "requirement-summary": ["issue"],
  "final-review": ["workflow-run", "artifact"],
  "orchestration-summary": ["workflow-run", "artifact"],
  "recovery-event": ["workflow-run", "artifact"],
  "human-boundary": ["pull-request", "issue"],
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
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

function completedCycleIdentity(record: CompletedCycleRecord): LearnInputPackPayload["completedCycle"] {
  return {
    recordDigest: record.recordDigest,
    repository: record.repository,
    requirementIssueNumber: record.requirement.issueNumber,
    humanMergePullRequestNumber: record.humanMerge.pullRequestNumber,
    reviewedHeadSha: record.source.review.reviewedHeadSha,
    mergeCommitSha: record.humanMerge.mergeCommitSha,
    trustedRailRunId: record.source.trustedRail.runId,
    trustedRailRunAttempt: record.source.trustedRail.runAttempt,
  };
}

function validateCycleBinding(input: LearnEvidenceInput, record: CompletedCycleRecord): void {
  if (input.repository !== record.repository) {
    throw new Error(`LEARN evidence repository mismatch: ${input.evidenceId}`);
  }
  if (
    input.cycle.recordDigest !== record.recordDigest ||
    input.cycle.requirementIssueNumber !== record.requirement.issueNumber ||
    input.cycle.humanMergePullRequestNumber !== record.humanMerge.pullRequestNumber ||
    input.cycle.reviewedHeadSha !== record.source.review.reviewedHeadSha
  ) {
    throw new Error(`LEARN evidence completed-cycle identity mismatch: ${input.evidenceId}`);
  }
}

function normalizeSource(
  evidenceKind: LearnEvidenceKind,
  source: LearnEvidenceSource,
  record: CompletedCycleRecord,
): LearnEvidenceSource {
  if (!ALLOWED_SOURCE_KINDS[evidenceKind].includes(source.kind)) {
    throw new Error(`unsupported source kind for ${evidenceKind}: ${source.kind}`);
  }

  switch (source.kind) {
    case "issue":
      assertPositiveInteger("evidence.source.issueNumber", source.issueNumber);
      if (source.issueNumber !== record.requirement.issueNumber) {
        throw new Error("LEARN issue evidence must reference the completed-cycle requirement Issue");
      }
      return { kind: "issue", issueNumber: source.issueNumber };
    case "pull-request":
      assertPositiveInteger("evidence.source.pullRequestNumber", source.pullRequestNumber);
      if (source.pullRequestNumber !== record.humanMerge.pullRequestNumber) {
        throw new Error("LEARN pull-request evidence must reference the completed-cycle Human Merge PR");
      }
      return { kind: "pull-request", pullRequestNumber: source.pullRequestNumber };
    case "workflow-run":
      assertPositiveInteger("evidence.source.runId", source.runId);
      assertPositiveInteger("evidence.source.runAttempt", source.runAttempt);
      return { kind: "workflow-run", runId: source.runId, runAttempt: source.runAttempt };
    case "artifact":
      assertPositiveInteger("evidence.source.artifactId", source.artifactId);
      assertNonempty("evidence.source.name", source.name);
      return {
        kind: "artifact",
        artifactId: source.artifactId,
        name: source.name,
        digest: normalizeSha256("evidence.source.digest", source.digest),
      };
  }
}

function normalizeEvidence(input: LearnEvidenceInput, record: CompletedCycleRecord): LearnEvidence {
  if (!EVIDENCE_ID.test(input.evidenceId)) {
    throw new Error(`invalid LEARN evidenceId: ${input.evidenceId}`);
  }
  if (!EVIDENCE_KINDS.has(input.kind)) {
    throw new Error(`unsupported LEARN evidence kind: ${String(input.kind)}`);
  }
  validateCycleBinding(input, record);
  assertNonempty("LEARN evidence content", input.content);
  assertGitSha("evidence.cycle.reviewedHeadSha", input.cycle.reviewedHeadSha);

  const bytes = Buffer.from(input.content, "utf8");
  if (bytes.byteLength > LEARN_INPUT_BUDGET.maxItemBytes) {
    throw new Error(`LEARN evidence item exceeds maxItemBytes: ${input.evidenceId}`);
  }

  return {
    evidenceId: input.evidenceId,
    kind: input.kind,
    repository: input.repository,
    cycle: { ...input.cycle },
    source: normalizeSource(input.kind, input.source, record),
    content: input.content,
    byteLength: bytes.byteLength,
    digestAlgorithm: "sha256",
    contentDigest: sha256(bytes),
  };
}

function evidenceToInput(evidence: LearnEvidence): LearnEvidenceInput {
  return {
    evidenceId: evidence.evidenceId,
    kind: evidence.kind,
    repository: evidence.repository,
    cycle: { ...evidence.cycle },
    source: { ...evidence.source },
    content: evidence.content,
  };
}

export function learnInputPackArtifactName(record: CompletedCycleRecord): string {
  verifyCompletedCycleRecord(record);
  return `learn-input-issue-${record.requirement.issueNumber}-pr-${record.humanMerge.pullRequestNumber}-record-${record.recordDigest}`;
}

export function createLearnInputPack(
  record: CompletedCycleRecord,
  evidenceInputs: readonly LearnEvidenceInput[],
): LearnInputPack {
  verifyCompletedCycleRecord(record);
  if (evidenceInputs.length === 0) throw new Error("LEARN Input Pack requires at least one evidence item");
  if (evidenceInputs.length > LEARN_INPUT_BUDGET.maxEvidenceItems) {
    throw new Error("LEARN Input Pack exceeds maxEvidenceItems");
  }

  const ids = evidenceInputs.map(({ evidenceId }) => evidenceId);
  if (new Set(ids).size !== ids.length) throw new Error("LEARN evidenceId values must be unique");

  const evidence = evidenceInputs
    .map((input) => normalizeEvidence(input, record))
    .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));

  const totalEvidenceBytes = evidence.reduce((total, item) => total + item.byteLength, 0);
  if (totalEvidenceBytes > LEARN_INPUT_BUDGET.maxTotalBytes) {
    throw new Error("LEARN Input Pack exceeds maxTotalBytes");
  }

  const payload: LearnInputPackPayload = {
    schemaVersion: 1,
    kind: "trusted-learn-input-pack",
    completedCycle: completedCycleIdentity(record),
    frameworkSourceSha: record.source.frameworkSourceSha,
    budget: { ...LEARN_INPUT_BUDGET },
    evidence,
    evidenceCount: evidence.length,
    totalEvidenceBytes,
  };
  const packDigest = sha256(JSON.stringify(payload));
  return { ...payload, digestAlgorithm: "sha256", packDigest };
}

export function verifyLearnInputPack(pack: LearnInputPack, record: CompletedCycleRecord): void {
  verifyCompletedCycleRecord(record);
  if (
    pack.schemaVersion !== 1 ||
    pack.kind !== "trusted-learn-input-pack" ||
    pack.digestAlgorithm !== "sha256"
  ) {
    throw new Error("unsupported LEARN Input Pack schema");
  }
  if (!SHA256.test(pack.packDigest)) throw new Error("packDigest must be a lowercase SHA-256 digest");

  const expectedCycle = completedCycleIdentity(record);
  if (JSON.stringify(pack.completedCycle) !== JSON.stringify(expectedCycle)) {
    throw new Error("LEARN Input Pack completed-cycle identity mismatch");
  }
  if (pack.frameworkSourceSha !== record.source.frameworkSourceSha) {
    throw new Error("LEARN Input Pack Framework source SHA mismatch");
  }
  if (JSON.stringify(pack.budget) !== JSON.stringify(LEARN_INPUT_BUDGET)) {
    throw new Error("LEARN Input Pack resource budget mismatch");
  }
  if (pack.evidenceCount !== pack.evidence.length) {
    throw new Error("LEARN Input Pack evidence count mismatch");
  }

  const regenerated = createLearnInputPack(record, pack.evidence.map(evidenceToInput));
  if (JSON.stringify(regenerated) !== JSON.stringify(pack)) {
    throw new Error("LEARN Input Pack digest or canonical shape mismatch");
  }
}
