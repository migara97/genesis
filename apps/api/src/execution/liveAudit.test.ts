import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendLiveAudit, listLiveAudit } from "./liveAudit.js";

describe("live audit", () => {
  it("appends entries without secret-looking fields", () => {
    const entry = appendLiveAudit({
      action: "place",
      mode: "LIVE",
      symbol: "BTCUSDT",
      side: "BUY",
      type: "MARKET",
      quantity: 0.01,
      status: "FILLED",
      exchangeOrderId: "ex-1",
      reason: "api_key=SUPERSECRET secret=ALSOBAD ok",
    });
    assert.equal(entry.action, "place");
    assert.equal(entry.symbol, "BTCUSDT");
    assert.match(entry.reason ?? "", /redacted/);
    assert.doesNotMatch(entry.reason ?? "", /SUPERSECRET|ALSOBAD/);

    const listed = listLiveAudit(5);
    assert.ok(listed.some((e) => e.id === entry.id));
    for (const row of listed) {
      assert.ok(!("apiKey" in row));
      assert.ok(!("apiSecret" in row));
    }
  });
});
