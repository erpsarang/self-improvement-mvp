import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertOutsideTarget,
  createPlanPrompt,
  PLAN_SCHEMA,
  selectPlanContext,
  snapshot,
  validatePlan,
  verifyPlanContextPack,
  type PlanContextPack,
  type PlanImplementationScope,
} from "./planner.js";
import { augmentPlanContextWithHumanOutputSurfaces } from "./plan-human-output-context.js";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

const target = realpathSync(env("PLAN_TARGET"));
const output = realpathSync(env("PLAN_OUTPUT"));
assertOutsideTarget(target, output);
const file = (name: string) => join(output, name);
const command = process.argv[2];

if (command === "prepare") {
  const requirement = readFileSync(env("PLAN_REQUIREMENT"), "utf8");
  const repository = env("PLAN_REPOSITORY");
  const sha = env("PLAN_SHA");
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid target SHA");

  const before = snapshot(target);
  const selectedContext = selectPlanContext(requirement, target, repository, sha);
  const context = augmentPlanContextWithHumanOutputSurfaces(requirement, target, selectedContext);
  writeFileSync(file("input.json"), JSON.stringify({
    requirement,
    repository,
    sha,
    files: before,
    contextDigest: context.contextDigest,
    contextEvidence: context.files.map((entry) => ({
      evidenceId: entry.evidenceId,
      path: entry.path,
      contentDigest: entry.contentDigest,
    })),
  }, null, 2));
  writeFileSync(file("PLAN-context.json"), JSON.stringify(context, null, 2));
  writeFileSync(file("prompt.md"), createPlanPrompt(requirement, context));
  writeFileSync(file("schema.json"), JSON.stringify(PLAN_SCHEMA));
} else if (command === "artifact") {
  const input = JSON.parse(readFileSync(file("input.json"), "utf8"));
  const context = JSON.parse(readFileSync(file("PLAN-context.json"), "utf8")) as PlanContextPack;
  verifyPlanContextPack(context);
  if (context.repository !== input.repository || context.sha !== input.sha || context.contextDigest !== input.contextDigest) {
    throw new Error("PLAN context identity mismatch");
  }
  const contextEvidence = context.files.map((entry) => ({
    evidenceId: entry.evidenceId,
    path: entry.path,
    contentDigest: entry.contentDigest,
  }));
  if (JSON.stringify(contextEvidence) !== JSON.stringify(input.contextEvidence)) {
    throw new Error("PLAN context evidence identity mismatch");
  }
  if (JSON.stringify(snapshot(target)) !== JSON.stringify(input.files)) throw new Error("Target repository changed during planning");

  const plan = validatePlan(JSON.parse(readFileSync(file("raw-plan.json"), "utf8")), target, context);
  writeFileSync(file("PLAN.json"), JSON.stringify({
    kind: "untrusted-plan",
    repository: input.repository,
    sha: input.sha,
    requirement: input.requirement,
    context: {
      digestAlgorithm: "sha256",
      digest: context.contextDigest,
      evidence: contextEvidence,
      totalBytes: context.totalBytes,
    },
    plan,
  }, null, 2));

  const sections = [["구현 접근", "approach"], ["변경 후보", "changeCandidates"], ["완료조건", "acceptanceCriteria"], ["테스트 전략", "testStrategy"], ["확인할 사항", "questions"]];
  const contextLines = context.files.map((entry) => `- ${entry.evidenceId} → ${entry.path} (${entry.byteLength} bytes)`).join("\n");
  const analysisLines = (plan.analysis as Array<{ evidenceId: string; path: string; contentDigest: string; finding: string }>)
    .map((entry) => `- [${entry.evidenceId}] ${entry.path}: ${entry.finding}`)
    .join("\n");
  const scope = plan.implementationScope as PlanImplementationScope;
  const scopeLines = scope.ready
    ? [
        "- 준비 상태: **IMPLEMENT 가능**",
        `- 허용 경로: ${scope.allowedPaths.map((path) => `\`${path}\``).join(", ")}`,
        `- 필수 변경: ${scope.requiredChanges.join(" / ")}`,
        `- 금지 변경: ${scope.forbiddenChanges.length > 0 ? scope.forbiddenChanges.join(" / ") : "없음"}`,
        `- 검증 명령: ${scope.validationCommands.map((command) => `\`${command}\``).join(", ")}`,
      ].join("\n")
    : "- 준비 상태: **IMPLEMENT 보류**\n- 이유: PLAN의 blocking question 또는 exact scope 미확정. 이 PLAN은 자동 IMPLEMENT authority로 승격할 수 없습니다.";
  writeFileSync(file("PLAN.md"), `# PLAN (AI 제안)\n\nRepository: ${input.repository}\nSHA: ${input.sha}\nContext SHA-256: ${context.contextDigest}\n\n## AI가 본 제한된 문맥\n\n${contextLines}\n\n## 업무 요구\n\n${input.requirement}\n\n## 요약\n\n${plan.summary}\n\n## 기존 코드/테스트 분석\n\n${analysisLines}\n\n## IMPLEMENT 실행 범위\n\n${scopeLines}\n\n${sections.map(([title, key]) => `## ${title}\n\n${(plan[key!] as string[]).map(item => `- ${item}`).join("\n")}`).join("\n\n")}\n`);
} else {
  throw new Error("Expected prepare or artifact");
}
