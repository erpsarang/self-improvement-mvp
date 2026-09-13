import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/plan-implement-handoff.yml", "utf8");

test("handoff는 Trusted PLAN_AUTHORIZE만 source로 사용한다", () => {
  assert.match(workflow, /workflows:\s*\["Trusted PLAN_AUTHORIZE"\]/);
  assert.match(workflow, /run\.path !== '\.github\/workflows\/plan-authorize\.yml'/);
  assert.match(workflow, /workflow_run\.event == 'issue_comment'/);
  assert.doesNotMatch(workflow, /workflows:\s*\["Trusted AUTHORIZE"\]/);
  assert.doesNotMatch(workflow, /SI-승인/);
});

test("handoff workflow는 read-only 권한이고 Worker나 Merge를 실행하지 않는다", () => {
  assert.match(workflow, /permissions:\s*\{\}/);
  assert.match(workflow, /permissions:\n\s+contents: read\n\s+actions: read/);
  assert.doesNotMatch(workflow, /contents: write/);
  assert.doesNotMatch(workflow, /issues: write/);
  assert.doesNotMatch(workflow, /pull-requests: write/);
  assert.doesNotMatch(workflow, /openai\/codex-action/);
  assert.doesNotMatch(workflow, /git push/);
  assert.doesNotMatch(workflow, /pulls\.create/);
});

test("rerun replay는 duplicate handoff 대신 no-op을 명시한다", () => {
  assert.match(workflow, /prior\.length === 1 && matches\.length === 1/);
  assert.match(workflow, /handoff is a no-op/);
  assert.match(workflow, /authorizeJobs\[0\]\.conclusion === 'skipped'/);
});

test("production artifact에는 Contract, Context, Worker input과 provenance manifest가 함께 저장된다", () => {
  for (const file of ["contract.json", "context.json", "prompt.md", "schema.json", "handoff.json", "source.json"]) {
    assert.match(workflow, new RegExp(file.replace(".", "\\.")));
  }
  assert.match(workflow, /exact approved base SHA checkout/);
  assert.match(workflow, /OBSERVED_BASE_SHA/);
});
