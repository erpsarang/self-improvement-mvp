import assert from "node:assert/strict";
import test from "node:test";
import type { LearnInputPack } from "../src/self-improvement/learn-input-pack.js";
import { createLearnReportOutputSchema } from "../src/self-improvement/learn-report.js";

const pack = {
  packDigest: "a".repeat(64),
} as unknown as LearnInputPack;

test("Codex structured output용 const 필드에 JSON Schema type을 명시한다", () => {
  const schema = createLearnReportOutputSchema(pack) as {
    properties: Record<string, { type?: string; const?: unknown }>;
  };

  assert.deepEqual(schema.properties.schemaVersion, { type: "integer", const: 1 });
  assert.deepEqual(schema.properties.kind, { type: "string", const: "untrusted-learn-report" });
  assert.deepEqual(schema.properties.sourcePackDigest, { type: "string", const: pack.packDigest });
});
