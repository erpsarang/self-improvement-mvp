import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const trustedRail = readFileSync(".github/workflows/trusted-rail.yml", "utf8");

test("Trusted Rail은 PLAN_BRIDGE에 한해 automatic과 recovery event를 허용한다", () => {
  assert.match(
    trustedRail,
    /const expectedEvents = sourceKind === 'PLAN_BRIDGE'[\s\S]{0,160}new Set\(\['workflow_run', 'workflow_dispatch'\]\)[\s\S]{0,80}new Set\(\['workflow_dispatch'\]\)/,
  );
  assert.match(trustedRail, /!expectedEvents\.has\(run\.event\)/);
});

test("recovery PLAN_BRIDGE도 exact source identity와 artifact 단일성을 유지한다", () => {
  assert.match(trustedRail, /run\.path !== expectedPath/);
  assert.match(trustedRail, /run\.head_branch !== context\.payload\.repository\.default_branch/);
  assert.match(trustedRail, /run\.head_sha !== context\.sha/);
  assert.match(trustedRail, /run\.run_attempt !== runAttempt/);
  assert.match(trustedRail, /exact\.length !== 1 \|\| matches\.length !== 1/);
  assert.match(trustedRail, /unexpected explicit \$\{sourceKind\} candidate artifact/);
});
