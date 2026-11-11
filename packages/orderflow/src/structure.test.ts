import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PRIMARY_INTERVAL,
  buildMultiTimeframeContext,
  midIntervalForPrimary,
  resolvePrimaryInterval,
  softIntervalForPrimary,
} from "./structure.js";

describe("buildMultiTimeframeContext", () => {
  it("defaults primary to 5m desk interval", () => {
    assert.equal(PRIMARY_INTERVAL, "5m");
    assert.equal(resolvePrimaryInterval("bogus"), "5m");
    assert.equal(softIntervalForPrimary("5m"), "1m");
    assert.equal(softIntervalForPrimary("15m"), "5m");
    assert.equal(midIntervalForPrimary("5m"), "15m");
    assert.equal(midIntervalForPrimary("15m"), undefined);
  });

  it("counts higher-TF trends and detects conflict with primary", () => {
    const mtf = buildMultiTimeframeContext(
      [
        { interval: "1d", trend: "bearish" },
        { interval: "4h", trend: "bearish" },
        { interval: "1h", trend: "range" },
        { interval: "15m", trend: "bullish" },
        { interval: "5m", trend: "bullish" },
        { interval: "1m", trend: "bullish" },
      ],
      "15m",
    );
    assert.equal(mtf.primaryInterval, "15m");
    assert.equal(mtf.higherTfBullish, 0);
    assert.equal(mtf.higherTfBearish, 2);
    assert.equal(mtf.higherTfRange, 1);
    assert.equal(mtf.conflictWithPrimary, true);
    assert.deepEqual(
      mtf.frames.map((f) => f.interval),
      ["1d", "4h", "1h", "15m", "5m", "1m"],
    );
  });

  it("does not conflict when HTF majority agrees with primary", () => {
    const mtf = buildMultiTimeframeContext(
      [
        { interval: "1d", trend: "bullish" },
        { interval: "4h", trend: "bullish" },
        { interval: "1h", trend: "bullish" },
        { interval: "5m", trend: "bullish" },
      ],
      "5m",
    );
    assert.equal(mtf.conflictWithPrimary, false);
    assert.equal(mtf.higherTfBullish, 3);
    assert.equal(mtf.primaryInterval, "5m");
  });
});
