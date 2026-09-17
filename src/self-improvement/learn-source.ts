import { validateVerifyProvenanceForReview } from "./review.js";
import { parseValidationCommand } from "./deterministic-ci.js";
import { createHash } from "node:crypto";
import {
  completedCycleRecordArtifactName,
  createCompletedCycleRecord,
  verifyCompletedCycleRecord,
  type CompletedCycleRecord,
} from "./completed-cycle.js";
import {
  createLearnInputPack,
  learnInputPackArtifactName,
  verifyLearnInputPack,
  type LearnEvidenceInput,
  type LearnInputPack,
} from "./learn-input-pack.js";

export interface TrustedLearnSourceFacts {
  readonly repository: string;
  readonly defaultBranch: string;
  readonly requirement: {
    readonly issueNumber: number;
    readonly title: string;
    readonly body: string;
    readonly digest: string;
  };
  readonly humanMerge: {
    readonly pullRequestNumber: number;
    readonly merged: boolean;
    readonly headSha: string;
    readonly mergeCommitSha: string | null;
    readonly mergedAt: string | null;
    readonly baseBranch: string;
  };
  readonly trustedRail: {
    readonly runId: number;
    readonly runAttempt: number;
    readonly status: string;
    readonly conclusion: string | null;
    readonly workflowPath: string;
    readonly headBranch: string;
    readonly headSha: string;
  };
  readonly orchestrationArtifact: {
    readonly name: string;
    readonly id: number;
    readonly digest: string;
  };
  readonly frameworkSourceSha: string;
}

export interface TrustedLearnSourceArtifacts {
  readonly completedCycle: CompletedCycleRecord;
  readonly learnInputPack: LearnInputPack;
  readonly completedCycleArtifactName: string;
  readonly learnInputArtifactName: string;
}

type JsonObject = Record<string, unknown>;

const SHA256 = /^[0-9a-f]{64}$/;
const SHA256_WITH_PREFIX = /^sha256:([0-9a-f]{64})$/;
const GIT_SHA = /^[0-9a-f]{40,64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function assertNonempty(name: string, value: string): void {
  if (!value.trim()) throw new Error(`${name} must be non-empty`);
}

function assertGitSha(name: string, value: string): void {
  if (!GIT_SHA.test(value)) throw new Error(`${name} must be a lowercase Git commit SHA`);
}

function normalizeSha256(name: string, value: string): string {
  if (SHA256.test(value)) return value;
  const prefixed = SHA256_WITH_PREFIX.exec(value);
  if (prefixed?.[1]) return prefixed[1];
  throw new Error(`${name} must be a lowercase SHA-256 digest`);
}

function asObject(name: string, value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as JsonObject;
}

function requiredString(object: JsonObject, key: string, name: string): string {
  const value = object[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function requiredInteger(object: JsonObject, key: string, name: string): number {
  const value = object[key];
  if (typeof value !== "number") throw new Error(`${name} must be a positive safe integer`);
  assertPositiveInteger(name, value);
  return value;
}

function optionalObjectPath(root: JsonObject, path: readonly string[]): JsonObject | undefined {
  let current: unknown = root;
  for (const segment of path) {
    if (current === undefined) return undefined;
    asObject(path.join("."), current);
    current = (current as JsonObject)[segment];
  }
  if (current === undefined) return undefined;
  return asObject(path.join("."), current);
}

function validateFacts(facts: TrustedLearnSourceFacts): void {
  assertNonempty("repository", facts.repository);
  assertNonempty("defaultBranch", facts.defaultBranch);
  assertPositiveInteger("requirement.issueNumber", facts.requirement.issueNumber);
  assertNonempty("requirement.title", facts.requirement.title);
  assertNonempty("requirement.body", facts.requirement.body);
  const computedRequirementDigest = sha256(JSON.stringify([facts.requirement.title, facts.requirement.body]));
  if (normalizeSha256("requirement.digest", facts.requirement.digest) !== computedRequirementDigest) {
    throw new Error("requirement digest does not match exact title/body");
  }

  assertPositiveInteger("humanMerge.pullRequestNumber", facts.humanMerge.pullRequestNumber);
  if (!facts.humanMerge.merged) throw new Error("Human Merge PR must be actually merged");
  assertGitSha("humanMerge.headSha", facts.humanMerge.headSha);
  if (facts.humanMerge.mergeCommitSha === null) throw new Error("Human Merge commit SHA is required");
  assertGitSha("humanMerge.mergeCommitSha", facts.humanMerge.mergeCommitSha);
  if (facts.humanMerge.mergedAt === null || !ISO_UTC.test(facts.humanMerge.mergedAt) || Number.isNaN(Date.parse(facts.humanMerge.mergedAt))) {
    throw new Error("Human Merge mergedAt must be a UTC ISO timestamp");
  }
  if (facts.humanMerge.baseBranch !== facts.defaultBranch) {
    throw new Error("Human Merge PR must target the repository default branch");
  }

  assertPositiveInteger("trustedRail.runId", facts.trustedRail.runId);
  assertPositiveInteger("trustedRail.runAttempt", facts.trustedRail.runAttempt);
  if (facts.trustedRail.status !== "completed" || facts.trustedRail.conclusion !== "success") {
    throw new Error("Trusted Rail source run must be an exact completed success");
  }
  if (facts.trustedRail.workflowPath !== ".github/workflows/trusted-rail.yml") {
    throw new Error("Trusted Rail source workflow path mismatch");
  }
  if (facts.trustedRail.headBranch !== facts.defaultBranch) {
    throw new Error("Trusted Rail source run must originate from the default branch");
  }
  assertGitSha("trustedRail.headSha", facts.trustedRail.headSha);

  assertNonempty("orchestrationArtifact.name", facts.orchestrationArtifact.name);
  assertPositiveInteger("orchestrationArtifact.id", facts.orchestrationArtifact.id);
  normalizeSha256("orchestrationArtifact.digest", facts.orchestrationArtifact.digest);
  assertGitSha("frameworkSourceSha", facts.frameworkSourceSha);
}

export function createTrustedLearnSourceArtifacts(
  facts: TrustedLearnSourceFacts,
  rawOrchestration: unknown,
): TrustedLearnSourceArtifacts {
  validateFacts(facts);

  const orchestration = asObject("orchestration", rawOrchestration);
  if (requiredString(orchestration, "type", "orchestration.type") !== "ORCHESTRATION") {
    throw new Error("source artifact is not ORCHESTRATION provenance");
  }
  if (requiredString(orchestration, "repository", "orchestration.repository") !== facts.repository) {
    throw new Error("orchestration repository mismatch");
  }
  if (requiredInteger(orchestration, "issueNumber", "orchestration.issueNumber") !== facts.requirement.issueNumber) {
    throw new Error("orchestration requirement Issue mismatch");
  }
  if (requiredString(orchestration, "decision", "orchestration.decision") !== "PASS") {
    throw new Error("orchestration decision must be PASS");
  }
  if (requiredString(orchestration, "nextState", "orchestration.nextState") !== "MERGE_READY") {
    throw new Error("orchestration nextState must be MERGE_READY");
  }

  const requirementsDigest = normalizeSha256(
    "orchestration.requirementsDigest",
    requiredString(orchestration, "requirementsDigest", "orchestration.requirementsDigest"),
  );
  const exactRequirementDigest = normalizeSha256("requirement.digest", facts.requirement.digest);
  if (requirementsDigest !== exactRequirementDigest) {
    throw new Error("orchestration requirement digest mismatch");
  }

  const reviewedHeadSha = requiredString(orchestration, "reviewedHeadSha", "orchestration.reviewedHeadSha");
  assertGitSha("orchestration.reviewedHeadSha", reviewedHeadSha);
  if (reviewedHeadSha !== facts.humanMerge.headSha) {
    throw new Error("Human Merge PR head SHA must equal orchestration reviewed exact SHA");
  }

  const orchestratorWorkflow = asObject(
    "orchestration.orchestratorWorkflow",
    orchestration.orchestratorWorkflow,
  );
  if (requiredString(orchestratorWorkflow, "workflowPath", "orchestratorWorkflow.workflowPath") !== ".github/workflows/orchestrator.yml") {
    throw new Error("orchestrator workflow path mismatch");
  }
  const orchestrationRunId = requiredInteger(orchestratorWorkflow, "runId", "orchestratorWorkflow.runId");
  const orchestrationRunAttempt = requiredInteger(
    orchestratorWorkflow,
    "runAttempt",
    "orchestratorWorkflow.runAttempt",
  );
  const orchestrationTrustedCodeSha = requiredString(
    orchestratorWorkflow,
    "trustedCodeSha",
    "orchestratorWorkflow.trustedCodeSha",
  );
  assertGitSha("orchestratorWorkflow.trustedCodeSha", orchestrationTrustedCodeSha);
  if (
    orchestrationRunId !== facts.trustedRail.runId ||
    orchestrationRunAttempt !== facts.trustedRail.runAttempt ||
    orchestrationTrustedCodeSha !== facts.trustedRail.headSha
  ) {
    throw new Error("orchestration run identity does not match exact Trusted Rail source run");
  }

  const expectedArtifactName =
    `orchestration-provenance-issue-${facts.requirement.issueNumber}-${facts.trustedRail.runId}-attempt-${facts.trustedRail.runAttempt}`;
  if (facts.orchestrationArtifact.name !== expectedArtifactName) {
    throw new Error("orchestration artifact name does not match exact Trusted Rail identity");
  }

  const sourceReview = asObject("orchestration.sourceReview", orchestration.sourceReview);
  if (requiredString(sourceReview, "decision", "sourceReview.decision") !== "PASS") {
    throw new Error("final Semantic REVIEW decision must be PASS");
  }
  const reviewHeadSha = requiredString(sourceReview, "reviewedHeadSha", "sourceReview.reviewedHeadSha");
  if (reviewHeadSha !== reviewedHeadSha) {
    throw new Error("Semantic REVIEW and orchestration reviewed SHA mismatch");
  }
  const reviewRequirementsDigest = normalizeSha256(
    "sourceReview.requirementsDigest",
    requiredString(sourceReview, "requirementsDigest", "sourceReview.requirementsDigest"),
  );
  if (reviewRequirementsDigest !== exactRequirementDigest) {
    throw new Error("Semantic REVIEW requirement digest mismatch");
  }
  const reviewWorkflow = asObject("sourceReview.reviewWorkflow", sourceReview.reviewWorkflow);
  if (requiredString(reviewWorkflow, "workflowPath", "sourceReview.reviewWorkflow.workflowPath") !== ".github/workflows/trusted-rail.yml") {
    throw new Error("Semantic REVIEW workflow path mismatch");
  }
  if (
    requiredInteger(reviewWorkflow, "runId", "sourceReview.reviewWorkflow.runId") !== facts.trustedRail.runId ||
    requiredInteger(reviewWorkflow, "runAttempt", "sourceReview.reviewWorkflow.runAttempt") !== facts.trustedRail.runAttempt ||
    requiredString(reviewWorkflow, "trustedCodeSha", "sourceReview.reviewWorkflow.trustedCodeSha") !== facts.trustedRail.headSha
  ) {
    throw new Error("Semantic REVIEW workflow identity mismatch");
  }

  const mergeBoundary = asObject("orchestration.mergeBoundary", orchestration.mergeBoundary);
  if (requiredString(mergeBoundary, "type", "mergeBoundary.type") !== "HUMAN_PULL_REQUEST") {
    throw new Error("MERGE_READY boundary must be Human Pull Request");
  }
  if (requiredInteger(mergeBoundary, "number", "mergeBoundary.number") !== facts.humanMerge.pullRequestNumber) {
    throw new Error("Human Merge PR number does not match MERGE_READY boundary");
  }
  if (requiredString(mergeBoundary, "headSha", "mergeBoundary.headSha") !== reviewedHeadSha) {
    throw new Error("Human Merge PR head does not match MERGE_READY boundary");
  }
  if (requiredString(mergeBoundary, "baseBranch", "mergeBoundary.baseBranch") !== facts.defaultBranch) {
    throw new Error("MERGE_READY base branch mismatch");
  }

  const completedCycle = createCompletedCycleRecord({
    repository: facts.repository,
    requirement: {
      issueNumber: facts.requirement.issueNumber,
      digest: exactRequirementDigest,
    },
    mergedPullRequest: {
      number: facts.humanMerge.pullRequestNumber,
      merged: facts.humanMerge.merged,
      headSha: facts.humanMerge.headSha,
      mergeCommitSha: facts.humanMerge.mergeCommitSha,
      mergedAt: facts.humanMerge.mergedAt,
    },
    source: {
      requirement: {
        issueNumber: facts.requirement.issueNumber,
        digest: exactRequirementDigest,
      },
      review: {
        decision: "PASS",
        reviewedHeadSha,
      },
      trustedRail: {
        runId: facts.trustedRail.runId,
        runAttempt: facts.trustedRail.runAttempt,
        controlPlaneSha: facts.trustedRail.headSha,
      },
      orchestrationProvenance: {
        artifact: {
          name: facts.orchestrationArtifact.name,
          id: facts.orchestrationArtifact.id,
          digest: normalizeSha256("orchestrationArtifact.digest", facts.orchestrationArtifact.digest),
        },
      },
      frameworkSourceSha: facts.frameworkSourceSha,
    },
  });
  verifyCompletedCycleRecord(completedCycle);

  const cycleBinding = {
    recordDigest: completedCycle.recordDigest,
    requirementIssueNumber: completedCycle.requirement.issueNumber,
    humanMergePullRequestNumber: completedCycle.humanMerge.pullRequestNumber,
    reviewedHeadSha: completedCycle.source.review.reviewedHeadSha,
  };

  const evidence: LearnEvidenceInput[] = [
    {
      evidenceId: "requirement-01",
      kind: "requirement-summary",
      repository: facts.repository,
      cycle: cycleBinding,
      source: { kind: "issue", issueNumber: facts.requirement.issueNumber },
      content: JSON.stringify({
        title: facts.requirement.title,
        body: facts.requirement.body,
        digest: exactRequirementDigest,
      }),
    },
    {
      evidenceId: "final-review-01",
      kind: "final-review",
      repository: facts.repository,
      cycle: cycleBinding,
      source: {
        kind: "workflow-run",
        runId: facts.trustedRail.runId,
        runAttempt: facts.trustedRail.runAttempt,
      },
      content: JSON.stringify({
        decision: "PASS",
        reviewedHeadSha,
        summary: typeof sourceReview.summary === "string" ? sourceReview.summary : "",
        findings: Array.isArray(sourceReview.findings) ? sourceReview.findings : [],
      }),
    },
    {
      evidenceId: "orchestration-01",
      kind: "orchestration-summary",
      repository: facts.repository,
      cycle: cycleBinding,
      source: {
        kind: "artifact",
        artifactId: facts.orchestrationArtifact.id,
        name: facts.orchestrationArtifact.name,
        digest: facts.orchestrationArtifact.digest,
      },
      content: JSON.stringify({
        fromState: typeof orchestration.fromState === "string" ? orchestration.fromState : "",
        decision: "PASS",
        nextState: "MERGE_READY",
        completedFixCount: typeof orchestration.completedFixCount === "number" ? orchestration.completedFixCount : 0,
        reviewedHeadSha,
        trustedRailRunId: facts.trustedRail.runId,
        trustedRailRunAttempt: facts.trustedRail.runAttempt,
        trustedCodeSha: facts.trustedRail.headSha,
      }),
    },
    {
      evidenceId: "human-boundary-01",
      kind: "human-boundary",
      repository: facts.repository,
      cycle: cycleBinding,
      source: { kind: "pull-request", pullRequestNumber: facts.humanMerge.pullRequestNumber },
      content: JSON.stringify({
        pullRequestNumber: facts.humanMerge.pullRequestNumber,
        reviewedHeadSha,
        mergeCommitSha: facts.humanMerge.mergeCommitSha,
        mergedAt: facts.humanMerge.mergedAt,
        baseBranch: facts.humanMerge.baseBranch,
      }),
    },
  ];

  const planSource = optionalObjectPath(orchestration, [
    "sourceReview", "sourceVerify", "sourcePublish", "sourceSeal", "sourcePlanBridge",
  ]);
  const bridge = planSource === undefined ? undefined : asObject("sourcePlanBridge.bridge", planSource.bridge);
  // Older recovery-only records have no execution provenance.
  const recoveryOnly = bridge !== undefined && Object.keys(bridge).length === 1 && Object.hasOwn(bridge, "recoveryGuard");
  if (bridge !== undefined && !recoveryOnly) {
    // Validate the original nested objects, before projecting or bounding their content.
    // This includes the canonical validation/bridge digests and artifact/run bindings.
    const verify = validateVerifyProvenanceForReview({
      verify: sourceReview.sourceVerify,
      verifyArtifactName: requiredString(sourceReview, "sourceVerifyArtifactName", "sourceReview.sourceVerifyArtifactName"),
      repository: facts.repository,
    });
    const publish = verify.sourcePublish;
    const seal = publish.sourceSeal;
    const source = seal.sourcePlanBridge!;
    const validatedBridge = source.bridge;
    const validation = validatedBridge.deterministicValidation;
    if (
      verify.issueNumber !== facts.requirement.issueNumber ||
      verify.verifiedHeadSha !== reviewedHeadSha ||
      verify.verifyWorkflow.runId !== facts.trustedRail.runId ||
      verify.verifyWorkflow.runAttempt > facts.trustedRail.runAttempt ||
      [verify.verifyWorkflow, publish.publishWorkflow, seal.sealWorkflow].some(
        (workflow) => workflow.trustedCodeSha !== facts.trustedRail.headSha,
      ) ||
      validatedBridge.requirement.digest !== exactRequirementDigest ||
      validatedBridge.candidatePatchDigest !== seal.sealedPatchDigest ||
      validation.baseSha !== seal.baseSha
    ) {
      throw new Error("test-execution exact content chain mismatch");
    }
    if (validation.status !== "PASS" || !Array.isArray(validation.commands) || validation.commands.length === 0) {
      throw new Error("test-execution requires executed PASS commands");
    }
    const commands = validation.commands.map((command) => {
      const spec = parseValidationCommand(command.raw);
      if (
        command.status !== "PASS" || command.exitCode !== 0 || command.signal !== null ||
        command.executable !== spec.executable || JSON.stringify(command.args) !== JSON.stringify(spec.args) ||
        typeof command.stdout !== "string" || typeof command.stderr !== "string"
      ) {
        throw new Error("test-execution command result mismatch");
      }
      // Logs remain bound by evidenceDigest; omit them from the bounded Input Pack.
      return {
        raw: command.raw, executable: command.executable, args: command.args,
        status: command.status, exitCode: command.exitCode, signal: command.signal,
        stdoutBytes: Buffer.byteLength(command.stdout), stdoutDigest: sha256(command.stdout),
        stderrBytes: Buffer.byteLength(command.stderr), stderrDigest: sha256(command.stderr),
      };
    });
    evidence.push({
      evidenceId: "test-execution-01",
      kind: "test-execution",
      repository: facts.repository,
      cycle: cycleBinding,
      source: {
        kind: "artifact", artifactId: facts.orchestrationArtifact.id,
        name: facts.orchestrationArtifact.name, digest: facts.orchestrationArtifact.digest,
      },
      content: JSON.stringify({
        executionMethod: "trusted-content-chain",
        conclusion: "success",
        status: validation.status, commands,
        evidenceDigest: validation.evidenceDigest,
        contractDigest: validation.contractDigest, contextDigest: validation.contextDigest,
        candidateDigest: validation.candidateDigest, baseSha: validation.baseSha,
        candidatePatchDigest: validatedBridge.candidatePatchDigest, sealedPatchDigest: seal.sealedPatchDigest,
        publishedHeadSha: publish.publishedHeadSha, verifiedHeadSha: verify.verifiedHeadSha, reviewedHeadSha,
        bridgeWorkflow: validatedBridge.bridgeWorkflow, candidateArtifactName: source.candidateArtifactName,
        worker: { runId: validatedBridge.sourceWorker.runId, runAttempt: validatedBridge.sourceWorker.runAttempt,
          artifact: validatedBridge.sourceWorker.artifact },
        sealWorkflow: seal.sealWorkflow, publishWorkflow: publish.publishWorkflow,
        verifyWorkflow: verify.verifyWorkflow, reviewWorkflow,
        sourceSealArtifactName: publish.sourceSealArtifactName,
        sourcePublishArtifactName: verify.sourcePublishArtifactName,
        sourceVerifyArtifactName: sourceReview.sourceVerifyArtifactName,
      }),
    });
  }

  const recoveryGuard = optionalObjectPath(orchestration, [
    "sourceReview",
    "sourceVerify",
    "sourcePublish",
    "sourceSeal",
    "sourcePlanBridge",
    "bridge",
    "recoveryGuard",
  ]);
  if (recoveryGuard !== undefined) {
    if (requiredString(recoveryGuard, "kind", "recoveryGuard.kind") !== "trusted-recovery-compare-v1") {
      throw new Error("unsupported recovery guard kind");
    }
    const baseSha = requiredString(recoveryGuard, "baseSha", "recoveryGuard.baseSha");
    const currentDefaultSha = requiredString(
      recoveryGuard,
      "currentDefaultSha",
      "recoveryGuard.currentDefaultSha",
    );
    assertGitSha("recoveryGuard.baseSha", baseSha);
    assertGitSha("recoveryGuard.currentDefaultSha", currentDefaultSha);
    evidence.push({
      evidenceId: "recovery-01",
      kind: "recovery-event",
      repository: facts.repository,
      cycle: cycleBinding,
      source: {
        kind: "artifact",
        artifactId: facts.orchestrationArtifact.id,
        name: facts.orchestrationArtifact.name,
        digest: facts.orchestrationArtifact.digest,
      },
      content: JSON.stringify({
        kind: "trusted-recovery-compare-v1",
        baseSha,
        currentDefaultSha,
        outcome: "candidate-reused-after-trusted-revalidation",
      }),
    });
  }

  const learnInputPack = createLearnInputPack(completedCycle, evidence);
  verifyLearnInputPack(learnInputPack, completedCycle);

  return {
    completedCycle,
    learnInputPack,
    completedCycleArtifactName: completedCycleRecordArtifactName({
      repository: completedCycle.repository,
      requirement: completedCycle.requirement,
      mergedPullRequest: {
        number: completedCycle.humanMerge.pullRequestNumber,
        merged: true,
        headSha: completedCycle.humanMerge.headSha,
        mergeCommitSha: completedCycle.humanMerge.mergeCommitSha,
        mergedAt: completedCycle.humanMerge.mergedAt,
      },
      source: completedCycle.source,
    }),
    learnInputArtifactName: learnInputPackArtifactName(completedCycle),
  };
}
