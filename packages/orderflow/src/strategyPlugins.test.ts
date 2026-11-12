import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyConfirmationPacks,
  clearConfirmationPacks,
  registerConfirmationPack,
  registerDefaultMicrostructurePack,
} from "./strategyPlugins.js";

describe("strategyPlugins", () => {
  it("forces weight 0 and does not invent exchange_reported source", () => {
    clearConfirmationPacks();
    registerConfirmationPack("test", () => ({
      factors: [
        {
          id: "x",
          family: "orderflow",
          side: "long",
          weight: 99,
          source: "exchange_reported",
          reason: "should be neutralized",
        },
      ],
      evidence: [],
      reasonsAgainst: [],
    }));
    const out = applyConfirmationPacks({
      symbol: "BTC",
      lastPrice: 1,
      timestamp: 1,
    });
    assert.equal(out.factors[0]?.weight, 0);
    assert.equal(out.factors[0]?.source, "heuristic");
    assert.ok(out.evidence.some((e) => /weight-0/i.test(e.note)));
    clearConfirmationPacks();
  });

  it("default iceberg pack stays silent without iceberg on DOM", () => {
    clearConfirmationPacks();
    registerDefaultMicrostructurePack();
    const out = applyConfirmationPacks({
      symbol: "BTC",
      lastPrice: 1,
      timestamp: 1,
      dom: null,
    });
    assert.equal(out.factors.length, 0);
    clearConfirmationPacks();
  });
});
