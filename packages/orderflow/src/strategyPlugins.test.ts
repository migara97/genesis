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
    assert.equal(
      out.factors.filter((f) => f.id.includes("iceberg")).length,
      0,
    );
    clearConfirmationPacks();
  });

  it("auction shadow pack is weight-0 observational only", () => {
    clearConfirmationPacks();
    registerDefaultMicrostructurePack();
    const out = applyConfirmationPacks({
      symbol: "BTC",
      lastPrice: 100,
      timestamp: 1,
      volumeProfile: {
        symbol: "BTC",
        from: 0,
        to: 1,
        tickSize: 0.1,
        levels: [],
        poc: 100,
        vah: 102,
        val: 98,
        hvn: [],
        lvn: [],
        totalVolume: 10,
      },
    });
    const auction = out.factors.find((f) => f.id.includes("auction_shadow"));
    assert.ok(auction);
    assert.equal(auction!.weight, 0);
    assert.equal(auction!.side, "neutral");
    assert.ok(out.evidence.some((e) => /never mutates/i.test(e.note)));
    clearConfirmationPacks();
  });
});
