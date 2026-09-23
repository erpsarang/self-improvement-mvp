import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * MERGE_READY PR은 Framework 전용 GitHub App identity로 만들어져 PR CI가 사람의 Approve 없이 실행된다.
 * 그 자동 실행이 Trusted Rail VERIFY가 이미 감수하는 범위를 넘지 않으려면,
 * PR이 열리거나 갱신될 때 실행되는 workflow는 어떤 secret도 참조해서는 안 된다.
 * (merge 시점에만 도는 `types: [closed]` workflow는 사람이 merge한 뒤 사람의 actor로 실행되므로 이 경계 밖이다.)
 */
const WORKFLOWS = ".github/workflows";
const OPEN_TYPES = new Set(["opened", "synchronize", "reopened", "edited", "ready_for_review"]);

function pullRequestOpenTriggered(source: string): boolean {
  const trigger = /\n  pull_request:\n((?:    .*\n|\n)*)/.exec(source);
  if (!trigger) return /\n  pull_request:\s*\n\s*\n/.test(source) || /\n  pull_request: \{\}/.test(source);
  const block = trigger[1] ?? "";
  const types = /types: \[([^\]]*)\]/.exec(block);
  if (!types) return true;
  return types[1]!.split(",").map((type) => type.trim()).some((type) => OPEN_TYPES.has(type));
}

test("PR이 열릴 때 실행되는 workflow는 secret을 참조하지 않는다", () => {
  const files = readdirSync(WORKFLOWS).filter((name) => name.endsWith(".yml"));
  const guarded = files.filter((name) => pullRequestOpenTriggered(readFileSync(join(WORKFLOWS, name), "utf8")));
  assert.deepEqual(guarded, ["ci.yml"], "PR open 시점에 실행되는 workflow 목록이 바뀌면 이 경계를 다시 검토해야 한다");
  for (const name of guarded) {
    const source = readFileSync(join(WORKFLOWS, name), "utf8");
    assert.doesNotMatch(source, /secrets\.|secrets\[/, `${name}는 PR open 시점에 secret을 참조할 수 없다`);
    assert.doesNotMatch(source, /pull_request_target/, `${name}는 pull_request_target을 쓸 수 없다`);
    assert.match(source, /permissions:\n  contents: read/, `${name}는 contents: read만 가진다`);
  }
});

test("merge 시점 workflow는 closed 이벤트에서만 동작한다", () => {
  for (const name of ["post-merge-learn.yml", "product-evaluation.yml"]) {
    const source = readFileSync(join(WORKFLOWS, name), "utf8");
    assert.match(source, /\n  pull_request:\n    types: \[closed\]/, name);
    assert.equal(pullRequestOpenTriggered(source), false, name);
  }
});
