import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ExecutionService } from "./execution.js";

describe("ExecutionService mode gating", () => {
  it("defaults away from unconfirmed LIVE", () => {
    const svc = new ExecutionService();
    assert.notEqual(svc.getMode(), "LIVE");
  });

  it("requires confirmation to enable LIVE", () => {
    const svc = new ExecutionService();
    assert.throws(() => svc.setMode("LIVE", false), /confirmLiveTrading/);
  });
});
