import { LEARN_INPUT_BUDGET } from "./learn-input-pack.js";
import { explicitPlanPaths, PLAN_IMPLEMENT_MAX_FILES } from "./planner.js";

// 요구 접수 사전 점검(requirement lint, #392).
// 사람이 쓴 [업무 요구] Issue 본문을 결정적 규칙으로 점검해 조언 댓글 한 개로 알려 준다.
// 조언일 뿐이다: PLAN 시작, 검증기, 승인 경로를 바꾸지 않고 권한도 없다. AI를 호출하지 않는다.
// 한도와 경로 추출은 실제 검증기가 쓰는 값과 함수를 import한다. 여기에 숫자나 정규식을 다시 적지 않는다.

export const REQUIREMENT_LINT_MARKER = "<!-- ai-dev-framework:REQUIREMENT_LINT v=1 -->";

// plan.yml의 "Freeze user requirement and target SHA" 단계(github-script)가 쓰는 정규식과 같아야 한다.
// workflow 안의 인라인 JS라 import할 수 없으므로 test/requirement-lint-workflow.test.ts가 두 정의가 같은지 고정한다.
export const COMPLEX_REQUIREMENT_CHECKBOX = /^[ \t]*[-*][ \t]+\[[xX]\][ \t]+복잡한 요구입니다/m;

// LEARN 증거의 digest 자리(learn-source.ts가 소문자 64자 hex로 정규화한 값을 넣는다).
const PLACEHOLDER_DIGEST = "0".repeat(64);
const NEAR_LIMIT_RATIO = 0.9;
const MAX_LISTED_PATHS = 10;
const SCOPE_HEADING_TEXT = "변경 범위";
const HEADING = /^(#{1,6})[ \t]+\S/;
const FENCE = /^[ \t]*(?:```|~~~)/;
const LIST_ITEM = /^[ \t]*(?:[-*]|\d+\.)[ \t]+/;
// "예상 변경 범위" 목록에서 변경 파일을 읽는 용도다. 검증기의 경로 추출은 폴더 없는 파일(`ui5.yaml` 등)을 잡지 못해
// 개수가 모자라게 나오므로 따로 읽는다. 경로 검증에는 쓰지 않는다.
const FILE_TOKEN = /`((?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.[A-Za-z][A-Za-z0-9._-]*)`/g;
const URL_SHAPE = /https?:\/\/[^\s)>\]"'`]+/g;

export type LintStatus = "ok" | "info" | "warning" | "error";
export type LintRuleId = "R1" | "R2" | "R3" | "R4";

export interface LintResult {
  readonly id: LintRuleId;
  readonly status: LintStatus;
  readonly summary: string;
  readonly details: readonly string[];
}

export interface RequirementLintReport {
  readonly results: readonly LintResult[];
  readonly errorCount: number;
  readonly warningCount: number;
}

export interface RequirementLintInput {
  readonly title: string;
  readonly body: string;
  // 사람이 쓴 본문인지. plan.yml은 사람이 쓴 본문(source.kind === 'HUMAN')에서만 복잡한 요구 체크를 opus로 올린다. 기본값은 사람이다.
  readonly authoredByHuman?: boolean;
}

// 점검할 수 있는 ‘예상 변경 범위’ 파일 목록. files가 null이면 점검하지 않고 이유만 알린다.
interface ScopeFiles {
  readonly files: readonly string[] | null;
  readonly reason: string;
}

// "변경 범위"가 들어간 제목 아래 절(같거나 더 높은 수준의 다음 제목 전까지)을 돌려준다. 코드 블록 안의 줄은 제목으로 보지 않는다.
function scopeSection(body: string): string[] | null {
  const lines = body.split("\n");
  let inFence = false;
  let start = -1;
  let level = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = HEADING.exec(line);
    if (heading && line.includes(SCOPE_HEADING_TEXT)) {
      start = index + 1;
      level = heading[1]!.length;
      break;
    }
  }
  if (start === -1) return null;
  const section: string[] = [];
  inFence = false;
  for (const line of lines.slice(start)) {
    if (FENCE.test(line)) inFence = !inFence;
    else if (!inFence) {
      const next = HEADING.exec(line);
      if (next && next[1]!.length <= level) break;
    }
    section.push(line);
  }
  return section;
}

// 목록 항목(줄머리 -, *, 1.)에 백틱으로 적은 파일 표기를 모두 읽는다. "그대로 둡니다"처럼 문장 속에 나열한 파일은 변경 대상이 아니라서 세지 않는다.
function readScopeFiles(body: string): ScopeFiles {
  const section = scopeSection(body);
  if (section === null) return { files: null, reason: "‘예상 변경 범위’ 절을 찾지 못했습니다" };
  const files: string[] = [];
  for (const line of section) {
    if (!LIST_ITEM.test(line)) continue;
    for (const match of line.matchAll(FILE_TOKEN)) {
      if (!files.includes(match[1]!)) files.push(match[1]!);
    }
  }
  if (files.length === 0) {
    return { files: null, reason: "‘예상 변경 범위’ 절에서 파일 목록을 읽지 못했습니다(목록 항목에 `경로`를 백틱으로 적어 주세요)" };
  }
  return { files, reason: "" };
}

function codeSpans(paths: readonly string[]): string {
  const shown = paths.slice(0, MAX_LISTED_PATHS).map((path) => `\`${path}\``).join(", ");
  return paths.length > MAX_LISTED_PATHS ? `${shown} 외 ${paths.length - MAX_LISTED_PATHS}개` : shown;
}

function lintSize(input: RequirementLintInput): LintResult {
  const limit = LEARN_INPUT_BUDGET.maxItemBytes;
  const evidenceBytes = Buffer.byteLength(
    JSON.stringify({ title: input.title, body: input.body, digest: PLACEHOLDER_DIGEST }),
    "utf8",
  );
  const bodyBytes = Buffer.byteLength(input.body, "utf8");
  const summary = `LEARN 증거 ${evidenceBytes}바이트 / 한도 ${limit}바이트 (본문 ${bodyBytes}바이트)`;
  if (evidenceBytes > limit) {
    return {
      id: "R1",
      status: "error",
      summary,
      details: [
        `${evidenceBytes - limit}바이트를 줄여야 합니다. 머지 뒤 LEARN이 \`maxItemBytes\`로 실패합니다.`,
        `한도는 본문이 아니라 제목·형식·줄바꿈 표기를 더한 값에 걸리므로, 본문이 ${limit}바이트보다 짧아도 넘을 수 있습니다.`,
      ],
    };
  }
  if (evidenceBytes >= limit * NEAR_LIMIT_RATIO) {
    return {
      id: "R1",
      status: "warning",
      summary,
      details: [`한도의 ${Math.round(NEAR_LIMIT_RATIO * 100)}%를 넘었습니다. 조금만 더 늘어도 LEARN이 실패합니다.`],
    };
  }
  return { id: "R1", status: "ok", summary, details: [] };
}

function lintModel(input: RequirementLintInput): LintResult {
  const checked = COMPLEX_REQUIREMENT_CHECKBOX.test(input.body);
  const human = input.authoredByHuman !== false;
  if (checked && !human) {
    return { id: "R2", status: "info", summary: "PLAN 모델: sonnet (사람이 쓴 본문이 아니라서 복잡한 요구 체크를 쓰지 않음)", details: [] };
  }
  return {
    id: "R2",
    status: "info",
    summary: checked ? "PLAN 모델: opus (복잡한 요구 체크됨)" : "PLAN 모델: sonnet (복잡한 요구 체크 없음)",
    details: [],
  };
}

function lintScopeSize(scope: ScopeFiles): LintResult {
  if (scope.files === null) {
    return { id: "R3", status: "info", summary: `${scope.reason} 파일 수는 점검하지 않았습니다`, details: [] };
  }
  const allowed = scope.files;
  const max = PLAN_IMPLEMENT_MAX_FILES;
  const summary = `예상 변경 파일 ${allowed.length}개 / 한도 ${max}개`;
  const details: string[] = [];
  if (allowed.length > max) {
    details.push(
      `${allowed.length - max}개를 줄이거나 요구를 둘로 나누세요. 변경 대상을 import하는 기존 테스트는 자동으로 범위에 더해지므로 여유를 두는 편이 안전합니다.`,
    );
  }
  if (allowed.includes("package.json") && !allowed.includes("package-lock.json") && allowed.length >= max) {
    details.push("`package.json`을 바꾸면 `package-lock.json`이 자동으로 더해집니다. 그 자리를 위해 파일 수를 한 개 줄이세요.");
  }
  return { id: "R3", status: details.length > 0 ? "warning" : "ok", summary, details };
}

function lintPathShapes(input: RequirementLintInput, scope: ScopeFiles): LintResult {
  const urlCount = (input.body.match(URL_SHAPE) ?? []).length;
  const details: string[] = [];
  const outside: string[] = [];
  const shortNames: string[] = [];
  if (scope.files !== null) {
    for (const path of explicitPlanPaths([input.body])) {
      if (scope.files.includes(path)) continue;
      if (scope.files.some((candidate) => candidate.endsWith(`/${path}`))) shortNames.push(path);
      else outside.push(path);
    }
  }
  if (outside.length > 0) {
    details.push(
      `‘예상 변경 범위’에 없는 경로 모양: ${codeSpans(outside)}. “바꾸지 않는다”는 뜻으로 적었더라도 PLAN이 되풀이하면 범위 밖 경로로 거부될 수 있으니 말로 풀어 쓰는 편이 안전합니다.`,
    );
  }
  if (shortNames.length > 0) {
    details.push(
      `허용 경로의 끝부분만 쓴 짧은 이름: ${codeSpans(shortNames)}. PLAN이 이 이름을 따라 쓰면 허용 경로와 글자가 달라 거부됩니다. 본문에서는 전체 경로를 쓰거나 이름을 빼세요.`,
    );
  }
  if (urlCount > 0) {
    details.push(`주소(URL) 모양 ${urlCount}건. PLAN이 주소의 끝부분을 파일 경로로 오인할 수 있으니 주소 문자열은 말로 설명하세요.`);
  }
  if (details.length > 0) {
    return { id: "R4", status: "warning", summary: "PLAN이 되풀이하면 거부될 수 있는 표기가 있습니다", details };
  }
  return scope.files === null
    ? { id: "R4", status: "info", summary: `${scope.reason} 경로 모양은 판단하지 않았습니다`, details: [] }
    : { id: "R4", status: "ok", summary: "본문의 경로 표기가 모두 ‘예상 변경 범위’와 같습니다", details: [] };
}

export function lintRequirement(input: RequirementLintInput): RequirementLintReport {
  const scope = readScopeFiles(input.body);
  const results = [lintSize(input), lintModel(input), lintScopeSize(scope), lintPathShapes(input, scope)];
  return {
    results,
    errorCount: results.filter((result) => result.status === "error").length,
    warningCount: results.filter((result) => result.status === "warning").length,
  };
}

const STATUS_LABEL: Record<LintStatus, string> = { ok: "통과", info: "정보", warning: "경고", error: "오류" };

// 댓글에는 본문 문장을 되풀이하지 않는다. 규칙 ID, 숫자, 정규식이 걸러 낸 경로(코드 스팬)만 쓴다.
export function renderRequirementLintComment(report: RequirementLintReport): string {
  const headline = report.errorCount + report.warningCount === 0
    ? "고칠 점이 없습니다."
    : `오류 ${report.errorCount}건, 경고 ${report.warningCount}건이 있습니다.`;
  const rows = report.results.map((result) => `| ${result.id} | ${STATUS_LABEL[result.status]} | ${result.summary} |`);
  const detailLines = report.results.flatMap((result) =>
    result.details.map((detail) => `- **${result.id}** ${detail}`));
  return [
    REQUIREMENT_LINT_MARKER,
    "## 요구 본문 점검 (조언)",
    "",
    `**${headline}**`,
    "",
    "| 규칙 | 결과 | 내용 |",
    "| --- | --- | --- |",
    ...rows,
    ...(detailLines.length > 0 ? ["", "### 고칠 점", "", ...detailLines] : []),
    "",
    "이 점검은 조언입니다. PLAN 시작, 검증, 승인에는 영향을 주지 않습니다. 본문을 고쳤다면 Actions → Read-only AI PLAN을 이 Issue 번호로 다시 실행해야 새 본문으로 PLAN이 만들어집니다(본문 수정만으로는 PLAN이 다시 시작되지 않습니다).",
    "",
    "_결정적 규칙 R1~R4 · AI 호출 없음. 본문을 고치면 이 댓글이 갱신됩니다._",
  ].join("\n");
}
