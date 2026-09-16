import { createHash } from "node:crypto";
import type { LearnInputPack } from "./learn-input-pack.js";

export type LearnConfidence = "high" | "medium" | "low";

export interface LearnReportItem {
  readonly id: string;
  readonly statement: string;
  readonly evidenceIds: readonly string[];
  readonly confidence: LearnConfidence;
}

export interface RawLearnReport {
  readonly schemaVersion: 1;
  readonly kind: "untrusted-learn-report";
  readonly sourcePackDigest: string;
  readonly observations: readonly LearnReportItem[];
  readonly lessons: readonly LearnReportItem[];
  readonly improvementHypotheses: readonly LearnReportItem[];
  readonly uncertainties: readonly LearnReportItem[];
}

export interface LearnReportFinalizeIdentity {
  readonly sourceRun: {
    readonly runId: number;
    readonly runAttempt: number;
  };
  readonly inputPackArtifact: {
    readonly name: string;
    readonly id: number;
    readonly digest: string;
  };
  readonly learner: {
    readonly provider: string;
    readonly action: string;
    readonly model: string;
    readonly reasoningEffort: string;
  };
}

export interface LearnReportPayload {
  readonly schemaVersion: 1;
  readonly kind: "untrusted-learn-report";
  readonly source: {
    readonly inputPack: {
      readonly packDigest: string;
      readonly artifact: {
        readonly name: string;
        readonly id: number;
        readonly digest: string;
      };
      readonly sourceRun: {
        readonly runId: number;
        readonly runAttempt: number;
      };
    };
  };
  readonly completedCycle: LearnInputPack["completedCycle"];
  readonly learner: LearnReportFinalizeIdentity["learner"];
  readonly observations: readonly LearnReportItem[];
  readonly lessons: readonly LearnReportItem[];
  readonly improvementHypotheses: readonly LearnReportItem[];
  readonly uncertainties: readonly LearnReportItem[];
}

export interface LearnReport extends LearnReportPayload {
  readonly digestAlgorithm: "sha256";
  readonly reportDigest: string;
}

export const LEARN_REPORT_BUDGET = Object.freeze({
  maxItemsPerSection: 8,
  maxStatementBytes: 2_048,
  maxReportBytes: 32_768,
});

const SHA256 = /^[0-9a-f]{64}$/;
const SHA256_WITH_PREFIX = /^sha256:([0-9a-f]{64})$/;
const ITEM_ID = /^[a-z][a-z0-9._-]{0,127}$/;
const CONFIDENCES = new Set<string>(["high", "medium", "low"]);
const RAW_KEYS = new Set([
  "schemaVersion",
  "kind",
  "sourcePackDigest",
  "observations",
  "lessons",
  "improvementHypotheses",
  "uncertainties",
]);
const ITEM_KEYS = new Set(["id", "statement", "evidenceIds", "confidence"]);

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

function assertExactKeys(name: string, object: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  const unknown = Object.keys(object).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${name} contains unsupported fields: ${unknown.join(", ")}`);
}

function asObject(name: string, value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function normalizeItem(
  section: string,
  value: unknown,
  knownEvidenceIds: ReadonlySet<string>,
): LearnReportItem {
  const item = asObject(`${section} item`, value);
  assertExactKeys(`${section} item`, item, ITEM_KEYS);

  if (typeof item.id !== "string" || !ITEM_ID.test(item.id)) {
    throw new Error(`${section} item id is invalid`);
  }
  if (typeof item.statement !== "string") throw new Error(`${section} item statement must be a string`);
  assertNonempty(`${section} item statement`, item.statement);
  if (Buffer.byteLength(item.statement, "utf8") > LEARN_REPORT_BUDGET.maxStatementBytes) {
    throw new Error(`${section} item statement exceeds maxStatementBytes`);
  }
  if (!Array.isArray(item.evidenceIds) || item.evidenceIds.length === 0) {
    throw new Error(`${section} item requires at least one evidenceId`);
  }
  if (!item.evidenceIds.every((id) => typeof id === "string" && knownEvidenceIds.has(id))) {
    throw new Error(`${section} item references unknown evidenceId`);
  }
  const evidenceIds = [...item.evidenceIds] as string[];
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    throw new Error(`${section} item evidenceIds must be unique`);
  }
  evidenceIds.sort((left, right) => left.localeCompare(right));

  if (typeof item.confidence !== "string" || !CONFIDENCES.has(item.confidence)) {
    throw new Error(`${section} item confidence is unsupported`);
  }

  return {
    id: item.id,
    statement: item.statement,
    evidenceIds,
    confidence: item.confidence as LearnConfidence,
  };
}

function normalizeSection(
  name: string,
  value: unknown,
  knownEvidenceIds: ReadonlySet<string>,
): LearnReportItem[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  if (value.length > LEARN_REPORT_BUDGET.maxItemsPerSection) {
    throw new Error(`${name} exceeds maxItemsPerSection`);
  }
  return value
    .map((item) => normalizeItem(name, item, knownEvidenceIds))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeRawReport(raw: unknown, pack: LearnInputPack): RawLearnReport {
  const object = asObject("LEARN report", raw);
  assertExactKeys("LEARN report", object, RAW_KEYS);
  if (object.schemaVersion !== 1 || object.kind !== "untrusted-learn-report") {
    throw new Error("unsupported LEARN report schema");
  }
  if (typeof object.sourcePackDigest !== "string" || object.sourcePackDigest !== pack.packDigest) {
    throw new Error("LEARN report source pack digest mismatch");
  }

  const knownEvidenceIds = new Set(pack.evidence.map(({ evidenceId }) => evidenceId));
  const observations = normalizeSection("observations", object.observations, knownEvidenceIds);
  const lessons = normalizeSection("lessons", object.lessons, knownEvidenceIds);
  const improvementHypotheses = normalizeSection(
    "improvementHypotheses",
    object.improvementHypotheses,
    knownEvidenceIds,
  );
  const uncertainties = normalizeSection("uncertainties", object.uncertainties, knownEvidenceIds);
  const allIds = [
    ...observations,
    ...lessons,
    ...improvementHypotheses,
    ...uncertainties,
  ].map(({ id }) => id);
  if (new Set(allIds).size !== allIds.length) throw new Error("LEARN report item IDs must be globally unique");

  return {
    schemaVersion: 1,
    kind: "untrusted-learn-report",
    sourcePackDigest: pack.packDigest,
    observations,
    lessons,
    improvementHypotheses,
    uncertainties,
  };
}

function normalizeFinalizeIdentity(identity: LearnReportFinalizeIdentity): LearnReportFinalizeIdentity {
  assertPositiveInteger("sourceRun.runId", identity.sourceRun.runId);
  assertPositiveInteger("sourceRun.runAttempt", identity.sourceRun.runAttempt);
  assertNonempty("inputPackArtifact.name", identity.inputPackArtifact.name);
  assertPositiveInteger("inputPackArtifact.id", identity.inputPackArtifact.id);
  const artifactDigest = normalizeSha256("inputPackArtifact.digest", identity.inputPackArtifact.digest);
  assertNonempty("learner.provider", identity.learner.provider);
  assertNonempty("learner.action", identity.learner.action);
  assertNonempty("learner.model", identity.learner.model);
  assertNonempty("learner.reasoningEffort", identity.learner.reasoningEffort);
  return {
    sourceRun: { ...identity.sourceRun },
    inputPackArtifact: { ...identity.inputPackArtifact, digest: artifactDigest },
    learner: { ...identity.learner },
  };
}

export function createLearnReport(
  pack: LearnInputPack,
  raw: unknown,
  finalizeIdentity: LearnReportFinalizeIdentity,
): LearnReport {
  const normalizedRaw = normalizeRawReport(raw, pack);
  const identity = normalizeFinalizeIdentity(finalizeIdentity);

  const payload: LearnReportPayload = {
    schemaVersion: 1,
    kind: "untrusted-learn-report",
    source: {
      inputPack: {
        packDigest: pack.packDigest,
        artifact: {
          name: identity.inputPackArtifact.name,
          id: identity.inputPackArtifact.id,
          digest: identity.inputPackArtifact.digest,
        },
        sourceRun: { ...identity.sourceRun },
      },
    },
    completedCycle: { ...pack.completedCycle },
    learner: { ...identity.learner },
    observations: normalizedRaw.observations,
    lessons: normalizedRaw.lessons,
    improvementHypotheses: normalizedRaw.improvementHypotheses,
    uncertainties: normalizedRaw.uncertainties,
  };

  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > LEARN_REPORT_BUDGET.maxReportBytes) {
    throw new Error("LEARN report exceeds maxReportBytes");
  }
  const reportDigest = sha256(JSON.stringify(payload));
  return { ...payload, digestAlgorithm: "sha256", reportDigest };
}

export function verifyLearnReport(report: LearnReport, pack: LearnInputPack): void {
  if (
    report.schemaVersion !== 1 ||
    report.kind !== "untrusted-learn-report" ||
    report.digestAlgorithm !== "sha256" ||
    !SHA256.test(report.reportDigest)
  ) {
    throw new Error("unsupported LEARN report schema or digest");
  }
  if (JSON.stringify(report.completedCycle) !== JSON.stringify(pack.completedCycle)) {
    throw new Error("LEARN report completed-cycle identity mismatch");
  }

  const regenerated = createLearnReport(
    pack,
    {
      schemaVersion: 1,
      kind: "untrusted-learn-report",
      sourcePackDigest: report.source.inputPack.packDigest,
      observations: report.observations,
      lessons: report.lessons,
      improvementHypotheses: report.improvementHypotheses,
      uncertainties: report.uncertainties,
    },
    {
      sourceRun: report.source.inputPack.sourceRun,
      inputPackArtifact: report.source.inputPack.artifact,
      learner: report.learner,
    },
  );
  if (JSON.stringify(regenerated) !== JSON.stringify(report)) {
    throw new Error("LEARN report digest or canonical shape mismatch");
  }
}

export function learnReportArtifactName(pack: LearnInputPack, runId: number, runAttempt: number): string {
  assertPositiveInteger("runId", runId);
  assertPositiveInteger("runAttempt", runAttempt);
  return `learn-report-issue-${pack.completedCycle.requirementIssueNumber}-pr-${pack.completedCycle.humanMergePullRequestNumber}-${runId}-attempt-${runAttempt}`;
}

export function createLearnReportPrompt(pack: LearnInputPack): string {
  return [
    "# 역할",
    "당신은 완료된 개발 cycle을 분석하는 read-only AI Learner입니다.",
    "아래 Trusted LEARN Input Pack만 근거로 사용하십시오. GitHub, repository, 웹, 다른 run/artifact를 탐색하거나 추정하지 마십시오.",
    "",
    "# 출력 규칙",
    "- JSON schema에 맞는 JSON만 출력합니다.",
    "- statement는 한국어로 작성하고 id, enum 값은 English 형식을 유지합니다.",
    "- observations, lessons, improvementHypotheses, uncertainties의 모든 항목은 최소 1개의 evidenceId를 참조합니다.",
    "- Input Pack에 없는 사실을 단정하지 않습니다. 근거가 부족하면 uncertainties에 기록합니다.",
    "- 코드 수정, Issue/PR 생성, workflow 실행, 승인, Merge를 제안된 행동으로 실행하지 않습니다.",
    "- improvementHypotheses는 다음 단계에서 사람이 판단할 가설일 뿐 authority가 아닙니다.",
    "",
    "# Trusted LEARN Input Pack",
    "```json",
    JSON.stringify(pack, null, 2),
    "```",
  ].join("\n");
}

function reportItemSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["id", "statement", "evidenceIds", "confidence"],
    properties: {
      id: { type: "string", pattern: "^[a-z][a-z0-9._-]{0,127}$" },
      statement: { type: "string", minLength: 1 },
      evidenceIds: {
        type: "array",
        minItems: 1,
        items: { type: "string" },
      },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
    },
  };
}

export function createLearnReportOutputSchema(pack: LearnInputPack): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "kind",
      "sourcePackDigest",
      "observations",
      "lessons",
      "improvementHypotheses",
      "uncertainties",
    ],
    properties: {
      schemaVersion: { type: "integer", const: 1 },
      kind: { type: "string", const: "untrusted-learn-report" },
      sourcePackDigest: { type: "string", const: pack.packDigest },
      observations: { type: "array", maxItems: LEARN_REPORT_BUDGET.maxItemsPerSection, items: reportItemSchema() },
      lessons: { type: "array", maxItems: LEARN_REPORT_BUDGET.maxItemsPerSection, items: reportItemSchema() },
      improvementHypotheses: { type: "array", maxItems: LEARN_REPORT_BUDGET.maxItemsPerSection, items: reportItemSchema() },
      uncertainties: { type: "array", maxItems: LEARN_REPORT_BUDGET.maxItemsPerSection, items: reportItemSchema() },
    },
  };
}
