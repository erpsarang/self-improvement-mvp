import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const workflow = readFileSync(".github/workflows/plan.yml", "utf8");
const scripts = [...workflow.matchAll(/          script: \|\n((?:            .*\n|\n)+)/g)]
  .map(match => match[1]!.split("\n").map(line => line.slice(12)).join("\n"));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const require = createRequire(import.meta.url);

async function freeze(title: string, body: string, attempt = "1") {
  const root = mkdtempSync(join(tmpdir(), "plan-provenance-"));
  const outputs: Record<string, string> = {};
  try {
    await new AsyncFunction("require", "process", "github", "context", "core", scripts[0])(
      require, { env: { RUNNER_TEMP: root, ISSUE_NUMBER: "60", GITHUB_RUN_ID: "1234", GITHUB_RUN_ATTEMPT: attempt } },
      { rest: {
        issues: { get: async () => ({ data: { number: 60, title, body } }) },
        repos: { get: async () => ({ data: { default_branch: "main" } }), getCommit: async () => ({ data: { sha: "a".repeat(40) } }) },
      } },
      { repo: { owner: "example", repo: "app" }, sha: "b".repeat(40) },
      { setOutput: (key: string, value: string) => { outputs[key] = value; } },
    );
    const identity = JSON.parse(outputs.identity!);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "ai-plan/identity.json"), "utf8")), identity);
    return identity;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("trusted freeze records exact requirement, repository, SHA and run attempt", async () => {
  const identity = await freeze("요구\r\n제목", "본문\n");
  assert.equal(identity.requirement.issueNumber, 60);
  assert.equal(identity.requirement.digest, createHash("sha256").update(JSON.stringify(["요구\r\n제목", "본문\n"])).digest("hex"));
  assert.equal(identity.repository, "example/app");
  assert.equal(identity.targetSha, "a".repeat(40));
  assert.deepEqual(identity.workflow, { runId: "1234", runAttempt: "1", sha: "b".repeat(40) });
  assert.equal(identity.artifactName, "plan-issue-60-1234-attempt-1");
  assert.notEqual(identity.requirement.digest, (await freeze("changed", "본문\n")).requirement.digest);
  assert.notEqual(identity.requirement.digest, (await freeze("요구\r\n제목", "본문")).requirement.digest);
  assert.notEqual((await freeze("a\n\nb", "c")).requirement.digest, (await freeze("a", "b\n\nc")).requirement.digest);
  assert.notEqual(identity.artifactName, (await freeze("요구\r\n제목", "본문\n", "2")).artifactName);
});

test("provenance binds upload outputs and pointer contains only trusted metadata", async () => {
  const identity = await freeze("untrusted title", "untrusted body");
  const root = mkdtempSync(join(tmpdir(), "plan-binding-"));
  const env = {
    RUNNER_TEMP: root, PLAN_IDENTITY: JSON.stringify(identity), PLAN_ARTIFACT_ID: "456",
    PLAN_ARTIFACT_DIGEST: "c".repeat(64), PLAN_ARTIFACT_URL: "https://github.com/example/app/actions/runs/1234/artifacts/456",
    PROVENANCE_URL: "https://github.com/example/app/actions/runs/1234/artifacts/457",
  };
  try {
    const bind = (values: typeof env) => new AsyncFunction("require", "process", "core", scripts[1])(require, { env: values }, { setOutput() {} });
    await bind(env);
    const provenance = JSON.parse(readFileSync(join(root, "PLAN-provenance.json"), "utf8"));
    assert.deepEqual(provenance.artifact, { name: identity.artifactName, id: "456", digestAlgorithm: "sha256", digest: env.PLAN_ARTIFACT_DIGEST, url: env.PLAN_ARTIFACT_URL });
    assert.deepEqual(provenance.requirement, identity.requirement);
    assert.equal(provenance.targetSha, identity.targetSha);
    await assert.rejects(bind({ ...env, PLAN_ARTIFACT_DIGEST: "" }), /exact uploaded PLAN identity/);
    await assert.rejects(bind({ ...env, PLAN_ARTIFACT_ID: "bad" }), /exact uploaded PLAN identity/);
    let comment: any;
    await new AsyncFunction("process", "github", "context", scripts[2])(
      { env }, { rest: { issues: { createComment: async (value: unknown) => { comment = value; } } } },
      { repo: { owner: "example", repo: "app" } },
    );
    assert.equal(comment.issue_number, 60);
    for (const value of [identity.artifactName, identity.requirement.digest, env.PLAN_ARTIFACT_DIGEST, env.PROVENANCE_URL, identity.targetSha]) assert.ok(comment.body.includes(value));
    assert.doesNotMatch(comment.body, /untrusted title|untrusted body/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("workflow isolates write permission and uses upload result rather than planner claims", () => {
  assert.equal(scripts.length, 3);
  const [planner, provenance] = workflow.split("  provenance:");
  assert.match(planner!, /if: github.ref == format\('refs\/heads\/\{0\}', github.event.repository.default_branch\)/);
  assert.match(planner!, /ai-plan\/identity.json/);
  assert.match(planner!, /name: \$\{\{ fromJSON\(steps.input.outputs.identity\).artifactName \}\}/);
  assert.match(planner!, /artifact_digest: \$\{\{ steps.upload.outputs.artifact-digest \}\}/);
  assert.doesNotMatch(planner!, /issues: write/);
  assert.match(provenance!, /needs: plan/);
  assert.match(provenance!, /issues: write/);
  assert.doesNotMatch(provenance!, /checkout@|codex-action|download-artifact|raw-plan/);
});
