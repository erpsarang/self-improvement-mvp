import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const TARGET_PATH = "test/fixtures/bounded-fix-smoke-target.ts";
const EXPECTED_CONTENT = "export const boundedFixSmokeValue: number = 2;\n";

test("bounded FIX smoke에서는 revised candidate가 정확한 목표 파일을 만든다", () => {
  if (process.env.BOUNDED_FIX_SMOKE !== "1") return;

  const absolute = join(process.cwd(), TARGET_PATH);
  assert.equal(existsSync(absolute), true, "bounded FIX smoke target must exist");
  assert.equal(readFileSync(absolute, "utf8"), EXPECTED_CONTENT);
});
