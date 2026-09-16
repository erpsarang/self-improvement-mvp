import { createHash } from "node:crypto";
import type { LearnConfidence, LearnReport } from "./learn-report.js";
import { verifyLearnReport } from "./learn-report.js";
import type { LearnInputPack } from "./learn-input-pack.js";

export interface ImprovementCandidateSourceIdentity {
  readonly learnRun: {
    readonly runId: number;
    readonly runAttempt: number;
  };
  readonly reportArtifact: {
    readonly name: string;
    readonly id: number;
    readonly digest: string;
  };
}

export interface ImprovementCandidate {
  readonly id: string;
  readonly sourceHypothesisId: string;
  readonly statement: string;
  readonly evidenceIds: readonly string[];
  readonly confidence: LearnConfidence;
  readonly decision: "pending-human";
}

export interface ImprovementCandidatePackPayload {
  readonly schemaVersion: 1;
  readonly kind: "improvement-candidate-pack";
  readonly authority: "proposal-only";
  readonly source: {
    readonly learnReportDigest: string;
    readonly inputPackDigest: string;
    readonly learnRun: {
      readonly runId: number;
      readonly runAttempt: number;
    };
    readonly reportArtifact: {
      readonly name: string;
      readonly id: number;
      readonly digest: string;
    };
  };
  readonly completedCycle: LearnReport["completedCycle"];
  readonly candidates: readonly ImprovementCandidate[];
}

export interface ImprovementCandidatePack extends ImprovementCandidatePackPayload {
  readonly digestAlgorithm: "sha256";
  readonly candidatePackDigest: string;
}

const SHA256 = /^[0-9a-f]{64}$/;
const SHA256_WITH_PREFIX = /^sha256:([0-9a-f]{64})$/;

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

function normalizeSourceIdentity(identity: ImprovementCandidateSourceIdentity): ImprovementCandidateSourceIdentity {
  assertPositiveInteger("learnRun.runId", identity.learnRun.runId);
  assertPositiveInteger("learnRun.runAttempt", identity.learnRun.runAttempt);
  assertNonempty("reportArtifact.name", identity.reportArtifact.name);
  assertPositiveInteger("reportArtifact.id", identity.reportArtifact.id);
  const digest = normalizeSha256("reportArtifact.digest", identity.reportArtifact.digest);
  return {
    learnRun: { ...identity.learnRun },
    reportArtifact: { ...identity.reportArtifact, digest },
  };
}

function candidateId(sourceHypothesisId: string): string {
  return `candidate-${sourceHypothesisId}`;
}

export function createImprovementCandidatePack(
  report: LearnReport,
  pack: LearnInputPack,
  sourceIdentity: ImprovementCandidateSourceIdentity,
): ImprovementCandidatePack {
  verifyLearnReport(report, pack);
  if (report.source.inputPack.packDigest !== pack.packDigest) {
    throw new Error("Improvement Candidate source input pack digest mismatch");
  }

  const identity = normalizeSourceIdentity(sourceIdentity);
  const candidates: ImprovementCandidate[] = report.improvementHypotheses.map((hypothesis) => ({
    id: candidateId(hypothesis.id),
    sourceHypothesisId: hypothesis.id,
    statement: hypothesis.statement,
    evidenceIds: [...hypothesis.evidenceIds],
    confidence: hypothesis.confidence,
    decision: "pending-human",
  }));

  const ids = candidates.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Improvement Candidate IDs must be unique");
  }

  const payload: ImprovementCandidatePackPayload = {
    schemaVersion: 1,
    kind: "improvement-candidate-pack",
    authority: "proposal-only",
    source: {
      learnReportDigest: report.reportDigest,
      inputPackDigest: pack.packDigest,
      learnRun: { ...identity.learnRun },
      reportArtifact: { ...identity.reportArtifact },
    },
    completedCycle: { ...report.completedCycle },
    candidates,
  };

  return {
    ...payload,
    digestAlgorithm: "sha256",
    candidatePackDigest: sha256(JSON.stringify(payload)),
  };
}

export function verifyImprovementCandidatePack(
  candidatePack: ImprovementCandidatePack,
  report: LearnReport,
  pack: LearnInputPack,
): void {
  if (
    candidatePack.schemaVersion !== 1 ||
    candidatePack.kind !== "improvement-candidate-pack" ||
    candidatePack.authority !== "proposal-only" ||
    candidatePack.digestAlgorithm !== "sha256" ||
    !SHA256.test(candidatePack.candidatePackDigest)
  ) {
    throw new Error("unsupported Improvement Candidate Pack schema or digest");
  }

  const regenerated = createImprovementCandidatePack(
    report,
    pack,
    {
      learnRun: candidatePack.source.learnRun,
      reportArtifact: candidatePack.source.reportArtifact,
    },
  );

  if (JSON.stringify(regenerated) !== JSON.stringify(candidatePack)) {
    throw new Error("Improvement Candidate Pack source, candidate mapping, or digest mismatch");
  }
}

export function improvementCandidatePackArtifactName(
  report: LearnReport,
  runId: number,
  runAttempt: number,
): string {
  assertPositiveInteger("runId", runId);
  assertPositiveInteger("runAttempt", runAttempt);
  return `improvement-candidates-issue-${report.completedCycle.requirementIssueNumber}-pr-${report.completedCycle.humanMergePullRequestNumber}-learn-${runId}-attempt-${runAttempt}`;
}
