import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createImplementContextPack } from "../src/self-improvement/context-pack.js";
import { createImplementContract } from "../src/self-improvement/implement-contract.js";
import {
  createPlanImplementHandoffManifest,
  planImplementHandoffArtifactName,
} from "../src/self-improvement/plan-implement-handoff.js";
import {
  createPlanAuthorizeArtifact,
  planAuthorizeArtifactName,
  type PlanAuthorizeArtifact,
} from "../src/self-improvement/plan-authorization.js";
import {
  createWorkerCandidateProvenance,
  validatePlanImplementWorkerSource,
  verifyPlanImplementWorkerBundle,
  workerCandidateArtifactName,
  type HandoffArtifactMetadata,
  type PlanImplementWorkerSourceRun,
} from "../src/self-improvement/plan-implement-worker.js";
import {
  createCandidateChangeSet,
  createSinglePassPrompt,
  WORKER_OUTPUT_SCHEMA,
} from "../src/self-improvement/single-pass-worker.js";

const targetSha = "b".repeat(40);

function authorization(): PlanAuthorizeArtifact {
  return createPlanAuthorizeArtifact({
    normalizedPlan: {
      requirement: { issueNumber: 83, digest: "a".repeat(64) },
      repository: "erpsarang/self-improvement-mvp",
      targetSha,
      plan: {
        runId: 34730034257,
        runAttempt: 1,
        artifact: {
          name: "plan-issue-83-34730034257-attempt-1",
          id: 10308609510,
          digest: "c".repeat(64),
        },
        provenanceArtifact: { name: "", id: 0, digest: "" },
      },
    },
    provenanceArtifact: {
      name: "plan-issue-83-34730034257-attempt-1-provenance",
      id: 10308699321,
      digest: "d".repeat(64),
    },
    currentRequirementDigest: "a".repeat(64),
    currentTargetSha: targetSha,
    approvalCommentId: 5649914569,
    approverUserId: 8370921,
    authorizationRunId: 34730287415,
    authorizationRunAttempt: 1,
  });
}

function fixture() {
  const approved = authorization();
  const contract = createImplementContract({
    requirement: approved.requirement,
    repository: approved.repository,
    targetSha: approved.targetSha,
    plan: approved.plan,
    approval: approved.approval,
  }, {
    allowedPaths: ["README.md"],
    requiredChanges: ["README 첫 제목 아래에 상태 설명 한 줄을 추가한다"],
    forbiddenChanges: ["README.md 외 파일 변경 금지", "commit/push/PR 생성 금지"],
    validationCommands: ["npm test"],
    maxFilesChanged: 1,
    maxContextBytes: 50_000,
    maxPatchBytes: 50_000,
  });

  const root = mkdtempSync(join(tmpdir(), "plan-worker-test-"));
  writeFileSync(join(root, "README.md"), "# Framework\n\n기존 설명\n");
  const context = createImplementContextPack(contract, root, targetSha);
  rmSync(root, { recursive: true, force: true });

  const sourcePlanAuthorizeArtifact = {
    name: planAuthorizeArtifactName(approved),
    id: 10309133636,
    digest: "e".repeat(64),
  };
  const handoff = createPlanImplementHandoffManifest({
    authorization: approved,
    sourceArtifact: sourcePlanAuthorizeArtifact,
    contract,
    contextDigest: context.contextDigest,
  });
  const source = { authorization: approved, sourceArtifact: sourcePlanAuthorizeArtifact };
  const prompt = createSinglePassPrompt(contract, context);
  const bundle = verifyPlanImplementWorkerBundle({
    contract,
    context,
    handoff,
    source,
    prompt,
    schema: WORKER_OUTPUT_SCHEMA,
  });
  return { approved, contract, context, handoff, source, prompt, bundle };
}

function sourceRun(overrides: Partial<PlanImplementWorkerSourceRun> = {}): PlanImplementWorkerSourceRun {
  return {
    id: 34730300737,
    runAttempt: 1,
    repository: "erpsarang/self-improvement-mvp",
    workflowName: "Trusted PLAN IMPLEMENT Handoff",
    workflowPath: ".github/workflows/plan-implement-handoff.yml",
    event: "workflow_run",
    conclusion: "success",
    headBranch: "main",
    defaultBranch: "main",
    headSha: targetSha,
    currentDefaultSha: targetSha,
    ...overrides,
  };
}

function handoffArtifact(approved = authorization(), overrides: Partial<HandoffArtifactMetadata> = {}): HandoffArtifactMetadata {
  return {
    name: planImplementHandoffArtifactName(approved),
    id: 10308809422,
    digest: "f".repeat(64),
    ...overrides,
  };
}

test("canonical production handoff bundle을 Worker input으로 exact 검증한다", () => {
  const { bundle, contract, context, handoff } = fixture();
  assert.equal(bundle.contract.contractDigest, contract.contractDigest);
  assert.equal(bundle.context.contextDigest, context.contextDigest);
  assert.equal(bundle.handoff.handoffDigest, handoff.handoffDigest);
  assert.equal(bundle.authorization.requirement.issueNumber, 83);
});

test("prompt/schema/handoff/source 위변조는 Worker 실행 전에 fail-closed 한다", () => {
  const { contract, context, handoff, source, prompt } = fixture();
  assert.throws(() => verifyPlanImplementWorkerBundle({
    contract, context, handoff, source, prompt: `${prompt}\n위변조`, schema: WORKER_OUTPUT_SCHEMA,
  }), /prompt mismatch/);
  assert.throws(() => verifyPlanImplementWorkerBundle({
    contract, context, handoff, source, prompt, schema: { ...WORKER_OUTPUT_SCHEMA, extra: true },
  }), /schema mismatch/);
  assert.throws(() => verifyPlanImplementWorkerBundle({
    contract, context, handoff: { ...handoff, contextDigest: "0".repeat(64) }, source, prompt, schema: WORKER_OUTPUT_SCHEMA,
  }), /handoff manifest mismatch/);
  assert.throws(() => verifyPlanImplementWorkerBundle({
    contract, context, handoff, source: { ...source, sourceArtifact: { ...source.sourceArtifact, digest: "1".repeat(64) } }, prompt, schema: WORKER_OUTPUT_SCHEMA,
  }), /handoff manifest mismatch/);
});

test("source handoff workflow/default HEAD/artifact identity가 exact하지 않으면 거부한다", () => {
  const { bundle, approved } = fixture();
  const artifact = handoffArtifact(approved);
  assert.doesNotThrow(() => validatePlanImplementWorkerSource(bundle, sourceRun(), artifact));
  assert.throws(
    () => validatePlanImplementWorkerSource(bundle, sourceRun({ workflowPath: ".github/workflows/implement.yml" }), artifact),
    /unexpected source handoff workflow/,
  );
  assert.throws(
    () => validatePlanImplementWorkerSource(bundle, sourceRun({ currentDefaultSha: "9".repeat(40) }), artifact),
    /re-plan required/,
  );
  assert.throws(
    () => validatePlanImplementWorkerSource(bundle, sourceRun(), { ...artifact, name: "other-artifact" }),
    /artifact name mismatch/,
  );
});

test("validated candidate provenance는 source handoff/Worker attempt/exact digests에 결합된다", () => {
  const { bundle, context, approved } = fixture();
  const file = context.files[0]!;
  assert.equal(file.state, "present");
  const candidate = createCandidateChangeSet(bundle.contract, bundle.context, {
    summary: "README 상태 설명 추가",
    changes: [{
      path: "README.md",
      operation: "modify",
      baseContentDigest: file.contentDigest,
      content: `${file.content}\n상태 설명\n`,
    }],
  });
  const artifact = handoffArtifact(approved);
  const provenance = createWorkerCandidateProvenance({
    bundle,
    source: sourceRun(),
    sourceArtifact: artifact,
    workerRunId: 34740000000,
    workerRunAttempt: 2,
    candidate,
  });
  assert.equal(provenance.sourceHandoff.runId, 34730300737);
  assert.equal(provenance.sourceHandoff.runAttempt, 1);
  assert.equal(provenance.worker.runAttempt, 2);
  assert.equal(provenance.contractDigest, bundle.contract.contractDigest);
  assert.equal(provenance.contextDigest, bundle.context.contextDigest);
  assert.equal(provenance.handoffDigest, bundle.handoff.handoffDigest);
  assert.equal(provenance.candidateDigest, candidate.candidateDigest);
  assert.match(provenance.provenanceDigest, /^[0-9a-f]{64}$/);
});

test("recovery candidate provenance도 exact trusted recovery guard를 유지한다", () => {
  const { bundle, context, approved } = fixture();
  const file = context.files[0]!;
  assert.equal(file.state, "present");
  const candidate = createCandidateChangeSet(bundle.contract, bundle.context, {
    summary: "README 상태 설명 추가",
    changes: [{
      path: "README.md",
      operation: "modify",
      baseContentDigest: file.contentDigest,
      content: `${file.content}\n상태 설명\n`,
    }],
  });
  const artifact = handoffArtifact(approved);
  const movedDefaultSha = "9".repeat(40);
  const movedSource = sourceRun({ currentDefaultSha: movedDefaultSha });

  assert.throws(() => createWorkerCandidateProvenance({
    bundle,
    source: movedSource,
    sourceArtifact: artifact,
    workerRunId: 34740000001,
    workerRunAttempt: 1,
    candidate,
  }), /re-plan required/);

  assert.doesNotThrow(() => createWorkerCandidateProvenance({
    bundle,
    source: movedSource,
    sourceArtifact: artifact,
    recoveryGuard: {
      kind: "trusted-recovery-compare-v1",
      baseSha: targetSha,
      currentDefaultSha: movedDefaultSha,
    },
    workerRunId: 34740000001,
    workerRunAttempt: 1,
    candidate,
  }));
});

test("candidate artifact 이름은 source handoff와 Worker run attempt를 모두 고정한다", () => {
  const { bundle } = fixture();
  assert.equal(
    workerCandidateArtifactName({
      bundle,
      sourceRunId: 34730300737,
      sourceRunAttempt: 1,
      workerRunId: 34740000000,
      workerRunAttempt: 3,
    }),
    "bounded-worker-candidate-issue-83-plan-34730034257-approval-5649914569-handoff-34730300737-attempt-1-worker-34740000000-attempt-3",
  );
});

// #244 Worker run 35997858096: Handoff가 plan-excerpt 표현으로 pack을 만들었는데 Worker가 full로 재계산해 manifest mismatch로 멈췄다.
// Worker는 Context 표현을 pack에서 다시 도출해 같은 manifest를 얻어야 한다.
function excerptFixture() {
  const approved = authorization();
  const contract = createImplementContract({
    requirement: approved.requirement,
    repository: approved.repository,
    targetSha: approved.targetSha,
    plan: approved.plan,
    approval: approved.approval,
  }, {
    allowedPaths: ["README.md"],
    contextPaths: ["docs/reference.md"],
    requiredChanges: ["README 첫 제목 아래에 상태 설명 한 줄을 추가한다"],
    forbiddenChanges: ["README.md 외 파일 변경 금지"],
    validationCommands: ["npm test"],
    maxFilesChanged: 1,
    maxContextBytes: 2_048,
    maxPatchBytes: 50_000,
  });

  const root = mkdtempSync(join(tmpdir(), "plan-worker-excerpt-"));
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "README.md"), "# Framework\n\n기존 설명\n");
  const reference = `# 참고 (한글 포함)\n${"x".repeat(3000)}\n## 핵심 절\n핵심 문장.\n${"y".repeat(3000)}\n`;
  writeFileSync(join(root, "docs", "reference.md"), reference);
  const start = reference.indexOf("## 핵심 절");
  const excerpt = reference.slice(start, start + "## 핵심 절\n핵심 문장.".length);
  const evidence = [{ path: "docs/reference.md", startOffset: start, content: excerpt, contentDigest: createHash("sha256").update(excerpt, "utf8").digest("hex") }];
  const context = createImplementContextPack(contract, root, targetSha, { approvedPlanEvidence: evidence });
  rmSync(root, { recursive: true, force: true });
  assert.equal(context.files.find((file) => file.path === "docs/reference.md")?.state, "excerpt");

  const sourcePlanAuthorizeArtifact = { name: planAuthorizeArtifactName(approved), id: 10309133636, digest: "e".repeat(64) };
  const approvedPlanContextDigest = "7".repeat(64);
  const handoff = createPlanImplementHandoffManifest({
    authorization: approved,
    sourceArtifact: sourcePlanAuthorizeArtifact,
    contract,
    contextDigest: context.contextDigest,
    contextMaterialization: { representation: "plan-excerpt", excerptPaths: ["docs/reference.md"], approvedPlanContextDigest },
  });
  const source = { authorization: approved, sourceArtifact: sourcePlanAuthorizeArtifact };
  const prompt = createSinglePassPrompt(contract, context);
  return { contract, context, handoff, source, prompt, approvedPlanContextDigest };
}

test("plan-excerpt Context를 가진 handoff bundle은 Worker가 표현을 pack에서 재도출해 exact 검증한다", () => {
  const { contract, context, handoff, source, prompt, approvedPlanContextDigest } = excerptFixture();
  const bundle = verifyPlanImplementWorkerBundle({ contract, context, handoff, source, prompt, schema: WORKER_OUTPUT_SCHEMA });
  assert.equal(bundle.handoff.handoffDigest, handoff.handoffDigest);
  assert.deepEqual(bundle.handoff.contextMaterialization, {
    representation: "plan-excerpt",
    excerptPaths: ["docs/reference.md"],
    approvedPlanContextDigest,
  });
});

test("Context 표현과 어긋나는 handoff manifest는 Worker 실행 전에 fail-closed 한다", () => {
  const { contract, context, handoff, source, prompt } = excerptFixture();
  const run = (manifest: unknown) => verifyPlanImplementWorkerBundle({ contract, context, handoff: manifest, source, prompt, schema: WORKER_OUTPUT_SCHEMA });

  // pack에는 발췌가 있는데 manifest가 full이라고 주장.
  const full = createPlanImplementHandoffManifest({ authorization: source.authorization, sourceArtifact: source.sourceArtifact, contract, contextDigest: context.contextDigest });
  assert.throws(() => run(full), /handoff manifest mismatch/);
  // 근거 PLAN Context digest가 빠짐.
  assert.throws(() => run({ ...handoff, contextMaterialization: { ...handoff.contextMaterialization, approvedPlanContextDigest: null } }), /handoff manifest mismatch/);
  // 발췌 경로 목록 위조 (digest는 그대로).
  assert.throws(() => run({ ...handoff, contextMaterialization: { ...handoff.contextMaterialization, excerptPaths: [] } }), /handoff manifest mismatch/);
  // 표현만 바꿈.
  assert.throws(() => run({ ...handoff, contextMaterialization: { ...handoff.contextMaterialization, representation: "full" } }), /handoff manifest mismatch/);
});
