import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fixTargetReader } from "../src/self-improvement/fix-handler.js";

test("bounded FIX target reader는 checkout 안 일반 파일만 읽고 symlink·경로 탈출은 거부한다", () => {
  const root = mkdtempSync(join(tmpdir(), "fix-target-"));
  const outside = mkdtempSync(join(tmpdir(), "fix-outside-"));
  writeFileSync(join(outside, "secret.txt"), "secret");
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "a.md"), "a");
  symlinkSync(join(outside, "secret.txt"), join(root, "link.md"));
  symlinkSync(outside, join(root, "linked"));

  const read = fixTargetReader(root);
  assert.equal(read("docs/a.md")?.toString("utf8"), "a");
  assert.equal(read("docs/new.md"), null);
  assert.equal(read("new/dir/file.md"), null);
  assert.throws(() => read("link.md"), /symlink/);
  assert.throws(() => read("linked/secret.txt"), /symlink/);
  assert.throws(() => read("linked/new.md"), /symlink/);
  assert.throws(() => read("docs"), /일반 파일이 아닙니다/);
  assert.throws(() => read("docs/a.md/x"), /일반 파일이 아닙니다/);
  for (const path of ["../escape.md", "/etc/passwd", "docs//a.md", "./docs/a.md"]) {
    assert.throws(() => read(path), /target path가 올바르지 않습니다/, path);
  }
});
