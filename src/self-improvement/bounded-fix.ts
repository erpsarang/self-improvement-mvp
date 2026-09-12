import { createHash } from "node:crypto";
import {
  verifyImplementContextPack,
  type ImplementContextPack,
} from "./context-pack.js";
import {
  verifyDeterministicValidationResult,
  type DeterministicValidationResult,
  type ValidationCommandResult,
} from "./deterministic-ci.js";
import {
  verifyImplementContract,
  type ImplementContract,
} from "./implement-contract.js";
import {
  createCandidateChangeSet,
  verifyCandidateChangeSet,
  WORKER_OUTPUT_SCHEMA,
  type CandidateChangeSet,
  type WorkerProposal,
} from "./single-pass-worker.js";

export interface BoundedFixFailureEvidence {
  readonly raw: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface BoundedFixRequestPayload {
  readonly schemaVersion: 1;
  readonly kind: "bounded-fix-request";
  readonly contractDigest: string;
  readonly contextDigest: string;
  readonly candidateDigest: string;
  readonly validationEvidenceDigest: string;
  readonly baseSha: string;
  readonly fixAttempt: 1;
  readonly maxFixAttempts: 1;
  readonly failure: BoundedFixFailureEvidence;
}

export interface BoundedFixRequest extends BoundedFixRequestPayload {
  readonly digestAlgorithm: "sha256";
  readonly fixRequestDigest: string;
}

const SHA256 = /^[0-9a-f]{64}$/;
const MAX_FAILURE_LOG_BYTES = 8 * 1024;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  return `${bytes.subarray(0, maxBytes).toString("utf8")}\n...[truncated]`;
}

function assertExactIdentity(
  contract: ImplementContract,
  contextPack: ImplementContextPack,
  candidate: CandidateChangeSet,
  validation: DeterministicValidationResult,
): void {
  verifyImplementContract(contract);
  verifyImplementContextPack(contextPack, contract);
  verifyCandidateChangeSet(candidate, contract, contextPack);
  verifyDeterministicValidationResult(validation);

  if (
    validation.contractDigest !== contract.contractDigest ||
    validation.contextDigest !== contextPack.contextDigest ||
    validation.candidateDigest !== candidate.candidateDigest ||
    validation.baseSha !== contract.baseSha
  ) {
    throw new Error("bounded FIX validation identity mismatch");
  }
}

function selectFailedCommand(validation: DeterministicValidationResult): ValidationCommandResult {
  if (validation.status !== "FAIL") throw new Error("bounded FIX request requires failed deterministic validation");
  const failed = validation.commands.find(({ status }) => status === "FAIL");
  if (!failed) throw new Error("failed deterministic validation has no failed command evidence");
  return failed;
}

export function boundedFixArtifactName(contract: ImplementContract, candidate: CandidateChangeSet): string {
  verifyImplementContract(contract);
  return `bounded-fix-issue-${contract.requirement.issueNumber}-candidate-${candidate.candidateDigest}-attempt-1`;
}

export function createBoundedFixRequest(
  contract: ImplementContract,
  contextPack: ImplementContextPack,
  candidate: CandidateChangeSet,
  validation: DeterministicValidationResult,
): BoundedFixRequest {
  assertExactIdentity(contract, contextPack, candidate, validation);
  const failed = selectFailedCommand(validation);

  const payload: BoundedFixRequestPayload = {
    schemaVersion: 1,
    kind: "bounded-fix-request",
    contractDigest: contract.contractDigest,
    contextDigest: contextPack.contextDigest,
    candidateDigest: candidate.candidateDigest,
    validationEvidenceDigest: validation.evidenceDigest,
    baseSha: contract.baseSha,
    fixAttempt: 1,
    maxFixAttempts: 1,
    failure: {
      raw: failed.raw,
      executable: failed.executable,
      args: [...failed.args],
      exitCode: failed.exitCode,
      signal: failed.signal,
      stdout: truncateUtf8(failed.stdout, MAX_FAILURE_LOG_BYTES),
      stderr: truncateUtf8(failed.stderr, MAX_FAILURE_LOG_BYTES),
    },
  };
  const fixRequestDigest = sha256(JSON.stringify(payload));
  return { ...payload, digestAlgorithm: "sha256", fixRequestDigest };
}

export function verifyBoundedFixRequest(
  request: BoundedFixRequest,
  contract: ImplementContract,
  contextPack: ImplementContextPack,
  candidate: CandidateChangeSet,
  validation: DeterministicValidationResult,
): void {
  if (request.schemaVersion !== 1 || request.kind !== "bounded-fix-request" || request.digestAlgorithm !== "sha256") {
    throw new Error("unsupported bounded FIX request schema");
  }
  if (!SHA256.test(request.fixRequestDigest)) throw new Error("invalid bounded FIX request digest");
  const expected = createBoundedFixRequest(contract, contextPack, candidate, validation);
  if (JSON.stringify(expected) !== JSON.stringify(request)) throw new Error("bounded FIX request digest or canonical shape mismatch");
}

export function createBoundedFixPrompt(
  request: BoundedFixRequest,
  contract: ImplementContract,
  contextPack: ImplementContextPack,
  candidate: CandidateChangeSet,
  validation: DeterministicValidationResult,
): string {
  verifyBoundedFixRequest(request, contract, contextPack, candidate, validation);

  return `당신은 bounded FIX Worker입니다. deterministic CI가 실패한 candidate를 아래 고정된 증빙만 사용해 한 번 수정하세요.

중요 규칙:
- repository, GitHub, 파일시스템, 네트워크를 탐색하거나 추가 파일을 요청하지 마세요.
- 테스트, 빌드, 설치, commit, push, branch/PR 생성 명령을 실행하지 마세요.
- FIX REQUEST에 포함된 실패 증빙과 기존 Contract / Context Pack / candidate만 사용하세요.
- 요구사항을 다시 설계하거나 allowedPaths 밖의 파일을 변경하지 마세요.
- 현재 candidate와 동일한 결과를 그대로 반환하지 마세요.
- 스스로 테스트하거나 반복 수정하는 loop를 만들지 마세요.
- 최종 응답은 지정된 candidate JSON schema 하나만 반환하세요.

IMPLEMENT CONTRACT:
${JSON.stringify(contract)}

CONTEXT PACK:
${JSON.stringify(contextPack)}

CURRENT CANDIDATE:
${JSON.stringify(candidate)}

FIX REQUEST:
${JSON.stringify(request)}
`;
}

export function createFixedCandidateChangeSet(
  request: BoundedFixRequest,
  contract: ImplementContract,
  contextPack: ImplementContextPack,
  candidate: CandidateChangeSet,
  validation: DeterministicValidationResult,
  proposal: WorkerProposal,
): CandidateChangeSet {
  verifyBoundedFixRequest(request, contract, contextPack, candidate, validation);
  const fixed = createCandidateChangeSet(contract, contextPack, proposal);
  if (JSON.stringify(fixed.changes) === JSON.stringify(candidate.changes)) {
    throw new Error("bounded FIX produced unchanged candidate content");
  }
  return fixed;
}

export const BOUNDED_FIX_OUTPUT_SCHEMA = WORKER_OUTPUT_SCHEMA;
