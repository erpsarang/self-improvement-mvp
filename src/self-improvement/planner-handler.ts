import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertOutsideTarget, createPlanPrompt, PLAN_SCHEMA, snapshot, validatePlan } from "./planner.js";

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
  const prompt = createPlanPrompt(requirement, target);
  const sha = env("PLAN_SHA");
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid target SHA");
  writeFileSync(file("input.json"), JSON.stringify({ requirement, repository: env("PLAN_REPOSITORY"), sha, files: snapshot(target) }, null, 2));
  writeFileSync(file("prompt.md"), prompt);
  writeFileSync(file("schema.json"), JSON.stringify(PLAN_SCHEMA));
} else if (command === "artifact") {
  const input = JSON.parse(readFileSync(file("input.json"), "utf8"));
  if (JSON.stringify(snapshot(target)) !== JSON.stringify(input.files)) throw new Error("Target repository changed during planning");
  const plan = validatePlan(JSON.parse(readFileSync(file("raw-plan.json"), "utf8")), target, input.files);
  writeFileSync(file("PLAN.json"), JSON.stringify({ kind: "untrusted-plan", repository: input.repository, sha: input.sha, requirement: input.requirement, plan }, null, 2));
  const sections = [["구현 접근", "approach"], ["변경 후보", "changeCandidates"], ["완료조건", "acceptanceCriteria"], ["테스트 전략", "testStrategy"], ["확인할 사항", "questions"]];
  writeFileSync(file("PLAN.md"), `# PLAN (AI 제안)\n\nRepository: ${input.repository}\nSHA: ${input.sha}\n\n## 업무 요구\n\n${input.requirement}\n\n## 요약\n\n${plan.summary}\n\n## 기존 코드/테스트 분석\n\n${(plan.analysis as Array<{path: string; quote: string; finding: string}>).map(e => `- ${e.path}: ${e.finding}\n\n${e.quote.split("\n").map(line => `> ${line}`).join("\n")}`).join("\n\n")}\n\n${sections.map(([title, key]) => `## ${title}\n\n${(plan[key!] as string[]).map(item => `- ${item}`).join("\n")}`).join("\n\n")}\n`);
} else {
  throw new Error("Expected prepare or artifact");
}
