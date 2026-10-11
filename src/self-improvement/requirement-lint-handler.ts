import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { lintRequirement, renderRequirementLintComment } from "./requirement-lint.js";

// 요구 Issue의 제목·본문(workflow가 읽어 JSON으로 저장)을 점검해 조언 댓글 본문과 요약 출력을 만든다.
// 이 핸들러는 GitHub에 쓰지 않는다. 댓글 게시는 issues: write 권한이 있는 별도 job이 한다.

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} 환경변수가 필요합니다`);
  return value;
}

function writeOutput(name: string, value: string | number): void {
  appendFileSync(requiredEnv("GITHUB_OUTPUT"), `${name}=${String(value)}\n`, "utf8");
}

const input = JSON.parse(readFileSync(requiredEnv("REQUIREMENT_LINT_INPUT_JSON"), "utf8")) as unknown;
if (
  !input ||
  typeof input !== "object" ||
  typeof (input as Record<string, unknown>).title !== "string" ||
  typeof (input as Record<string, unknown>).body !== "string"
) {
  throw new Error("REQUIREMENT_LINT_INPUT_JSON must contain string title and body");
}
const { title, body, authoredByHuman } = input as { title: string; body: string; authoredByHuman?: unknown };
if (authoredByHuman !== undefined && typeof authoredByHuman !== "boolean") {
  throw new Error("REQUIREMENT_LINT_INPUT_JSON authoredByHuman must be a boolean when present");
}

const report = lintRequirement({ title, body, ...(authoredByHuman === undefined ? {} : { authoredByHuman }) });
const comment = renderRequirementLintComment(report);
writeFileSync(requiredEnv("REQUIREMENT_LINT_COMMENT_MD"), `${comment}\n`, "utf8");
writeOutput("error_count", report.errorCount);
writeOutput("warning_count", report.warningCount);

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) appendFileSync(summaryPath, `${comment}\n`, "utf8");
