import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(".github/workflows/authorize.yml", "utf8");
const marker = "<!-- self-improvement:legacy-implement -->";

test("SI-승인만으로는 legacy IMPLEMENT authorization을 시작하지 않는다", () => {
  assert.match(workflow, /github\.event\.comment\.body == 'SI-승인'/);
  assert.match(workflow, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(workflow, /firstNonEmptyLine === marker \? 'true' : 'false'/);
});

test("legacy marker는 Issue body의 첫 non-empty line과 정확히 일치해야 한다", () => {
  assert.match(workflow, /const firstNonEmptyLine = body/);
  assert.match(workflow, /\.find\(\(line\) => line\.trim\(\)\.length > 0\)/);
  assert.match(workflow, /core\.setOutput\('enabled', firstNonEmptyLine === marker \? 'true' : 'false'\)/);
});

test("legacy opt-in이 없으면 checkout부터 AUTHORIZE artifact 기록까지 모두 skip된다", () => {
  const gate = "if: steps.legacy_intent.outputs.enabled == 'true'";
  assert.ok(workflow.includes(`- uses: actions/checkout@v4\n        ${gate}`));
  assert.ok(workflow.includes(`- uses: actions/setup-node@v4\n        ${gate}`));
  assert.ok(workflow.includes(`- run: npm ci\n        ${gate}`));
  assert.ok(workflow.includes(`- name: Trusted AUTHORIZE 기록\n        ${gate}`));
  assert.ok(workflow.includes(`${gate} && hashFiles('authorize.json') != ''`));
  assert.ok(workflow.includes(`${gate} && hashFiles('authorize-pointer.txt') != ''`));
});

test("Trusted AUTHORIZE workflow는 AI Worker를 직접 호출하지 않는다", () => {
  assert.doesNotMatch(workflow, /openai\/codex-action/);
});
