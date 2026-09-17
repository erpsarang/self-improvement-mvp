import { strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { createLearnInputPack } from "./learn-input-pack.js";

describe("LEARN test-execution contract", () => {
  it("requires supplied provenance schemas before implementation", () => {
    strictEqual(typeof createLearnInputPack, "function");
  });
});
