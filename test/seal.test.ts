import assert from "node:assert/strict";
import test from "node:test";
import { sha256, type ImplementProvenance } from "../src/self-improvement/implement.js";
import {
  sealImplementCandidate,
  validateImplementCandidateForSeal,
  type ImplementSourceRun,
} from "../src/self-improvement/seal.js";

const candidatePatch = Buffer.from(
  "diff --git a/example.txt b/example.txt\nnew file mode 100644\nindex 0000000..ce01362\n--- /dev/null\n+++ b/example.txt\n@@ -0,0 +1 @@\n+hello\n",
  "utf8",
);

const implement: ImplementProvenance = {
  type: "IMPLEMENT",
  repository: "erpsarang/self-improvement-mvp",
  issueNumber: 12,
  baseSha: "a".repeat(40),
  sourceAuthorization: {
    runId: 100,
    runAttempt: 1,
    approvalCommentId: 200,
    policySnapshot: "sha256:" + "b".repeat(64),
    requirementsDigest: "sha256:" + "c".repeat(64),
  },
  implementWorkflow: {
    workflowPath: ".github/workflows/implement.yml",
    runId: 300,
    runAttempt: 2,
  },
  candidatePatchDigest: sha256(candidatePatch),
  aiExecution: {
    provider: "openai-codex-action",
    resultId: "codex-action-run:300:2",
  },
};

const sourceRun: ImplementSourceRun = {
  id: 300,
  runAttempt: 2,
  headSha: implement.baseSha,
  repository: implement.repository,
  conclusion: "success",
  workflowPath: ".github/workflows/implement.yml",
};

const validSealRun = {
  runId: 400,
  runAttempt: 1,
  trustedCodeSha: "e".repeat(40),
};

test("exact IMPLEMENT run과 candidate digest만 SEAL 입력으로 허용한다", () => {
  assert.equal(
    validateImplementCandidateForSeal(implement, candidatePatch, sourceRun),
    implement,
  );
});

test("candidate patch digest 변조는 fail-closed 한다", () => {
  const tamperedPatch = Buffer.concat([candidatePatch, Buffer.from("tampered")]);
  assert.throws(() =>
    validateImplementCandidateForSeal(implement, tamperedPatch, sourceRun),
  );
});

test("IMPLEMENT source workflow identity와 base SHA mismatch를 거부한다", () => {
  const cases: ImplementSourceRun[] = [
    { ...sourceRun, conclusion: "failure" },
    { ...sourceRun, workflowPath: ".github/workflows/other.yml" },
    { ...sourceRun, repository: "other/repo" },
    { ...sourceRun, id: 301 },
    { ...sourceRun, runAttempt: 3 },
    { ...sourceRun, headSha: "d".repeat(40) },
  ];

  for (const candidate of cases) {
    assert.throws(() =>
      validateImplementCandidateForSeal(implement, candidatePatch, candidate),
    );
  }
});

test("malformed IMPLEMENT provenance는 fail-closed 한다", () => {
  const malformed: unknown[] = [
    null,
    {},
    { ...implement, type: "FIX" },
    { ...implement, baseSha: "bad" },
    { ...implement, candidatePatchDigest: "bad" },
    { ...implement, sourceAuthorization: undefined },
    { ...implement, implementWorkflow: { ...implement.implementWorkflow, runId: 0 } },
    { ...implement, aiExecution: { ...implement.aiExecution, resultId: "" } },
  ];

  for (const candidate of malformed) {
    assert.throws(() =>
      validateImplementCandidateForSeal(candidate, candidatePatch, sourceRun),
    );
  }
});

test("SEAL은 candidate patch bytes를 변경하지 않고 provenance chain을 보존한다", () => {
  const sealed = sealImplementCandidate({
    implement,
    candidatePatch,
    sourceRun,
    sealRun: validSealRun,
    candidateArtifactName: "implement-candidate-100-300-attempt-2",
  });

  assert.equal(sealed.sealedPatch.equals(candidatePatch), true);
  assert.equal(sealed.provenance.type, "SEAL");
  assert.equal(sealed.provenance.repository, implement.repository);
  assert.equal(sealed.provenance.issueNumber, implement.issueNumber);
  assert.equal(sealed.provenance.baseSha, implement.baseSha);
  assert.deepEqual(sealed.provenance.sourceAuthorization, implement.sourceAuthorization);
  assert.equal(sealed.provenance.sourceImplement.runId, 300);
  assert.equal(sealed.provenance.sourceImplement.runAttempt, 2);
  assert.equal(
    sealed.provenance.sourceImplement.candidatePatchDigest,
    implement.candidatePatchDigest,
  );
  assert.deepEqual(sealed.provenance.sourceImplement.aiExecution, implement.aiExecution);
  assert.equal(
    sealed.provenance.sealWorkflow.workflowPath,
    ".github/workflows/trusted-rail.yml",
  );
  assert.equal(sealed.provenance.sealWorkflow.runId, 400);
  assert.equal(sealed.provenance.sealWorkflow.trustedCodeSha, "e".repeat(40));
  assert.notEqual(sealed.provenance.sealWorkflow.trustedCodeSha, implement.baseSha);
  assert.equal(sealed.provenance.sealedPatchDigest, implement.candidatePatchDigest);
});

test("candidate artifact 이름도 AUTHORIZE와 IMPLEMENT provenance에 exact 결합한다", () => {
  const invalidNames = [
    "candidate",
    "implement-candidate-999-300-attempt-2",
    "implement-candidate-100-999-attempt-2",
    "implement-candidate-100-300-attempt-9",
    " implement-candidate-100-300-attempt-2",
  ];

  for (const candidateArtifactName of invalidNames) {
    assert.throws(() =>
      sealImplementCandidate({
        implement,
        candidatePatch,
        sourceRun,
        sealRun: validSealRun,
        candidateArtifactName,
      }),
    );
  }
});

test("잘못된 SEAL run identity와 trusted control-plane SHA는 거부한다", () => {
  assert.throws(() =>
    sealImplementCandidate({
      implement,
      candidatePatch,
      sourceRun,
      sealRun: { ...validSealRun, runId: 0 },
      candidateArtifactName: "implement-candidate-100-300-attempt-2",
    }),
  );
  assert.throws(() =>
    sealImplementCandidate({
      implement,
      candidatePatch,
      sourceRun,
      sealRun: { ...validSealRun, trustedCodeSha: "bad" },
      candidateArtifactName: "implement-candidate-100-300-attempt-2",
    }),
  );
});
