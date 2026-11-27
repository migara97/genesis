# Genesis Order-Flow Signal Engine — Factual Audit

**Date:** 2026-11-27  
**Scope:** `packages/orderflow` and `apps/api` validation/execution  
**Method:** Code and documentation audit (no speculation)

---

## 1. Signal Generation Inputs, Confirmations, A+ Gates, Scoring, WAIT Rules

### Core Entry: `generateSignal(input, config)` → `TradingSignal`
**File:** `packages/orderflow/src/signals.ts`

### Inputs (`SignalInput`, lines 22–40)
```typescript
{
  symbol, lastPrice, timestamp,
  footprint?: FootprintBar | null,
  cvd?: CvdState | null,
  dom?: DomMetrics | null,
  volumeProfile?: VolumeProfile | null,
  structure?: MarketStructureState | null,
  mtf?: MultiTimeframeContext | null,
  zones?: StructureZonesState | null,
  chartOverlay?: ChartOverlayState | null,
  breakRetest?: BreakRetestState | null
}
```

### DEFAULT_SIGNAL_CONFIG (lines 106–148)

**Weights:**
```typescript
structureTrend: 1, structureBos: 0.75, structureChochAlign: 0.5,
mtfHigherAlign: 0.75, mtfSoftAlign: 0.25,
orderBlock: 0.5, fairValueGap: 0.5, liquiditySweep: 0.5,
cvdDivergence: 1, cvdAligned: 0.5,
stackedImbalance: 1, barDelta: 0.5, domImbalance: 0.5,
volumeProfileExtreme: 0.5, lvnContinuation: 0.5,
breakRetestAccept: 0.85
```

**Gates (lines 128–148):**
```typescript
entryQuality: "a_plus",           // Default; "standard" available
minIndependent: 2,                // Distinct confirmation families required
minScore: 2,                      // Min weighted score for LONG/SHORT
minLead: 1,                       // Leading side must exceed opposing by ≥1
levelProximityPct: 0.0015,        // 0.15% price distance for "near" levels
domRequiresTradeDelta: true,      // DOM scores only when footprint/CVD supports
mtfMinHigherAgree: 2,             // Min 4h/1h frames agreeing for HTF align
sweepMaxAgeMs: 14_400_000,        // 4h max sweep age
requireDataReady: true,           // Reject LONG/SHORT without footprint+VP
minVpTotalVolume: 1,              // VP minimum volume threshold
icebergVetoEnabled: false,        // Hard opposing iceberg veto (default OFF)
icebergVetoMinConfidence: 0.4,
icebergVetoProximityPct: 0.0015,
swingProximityPct: 0.001,         // Reject entry within 0.1% of opposing swing
minRoomToRunR: 1.5,               // Require ≥1.5R to first opposing structure
stopBufferPct: 0.001,             // 0.1% buffer beyond protective stop level
minStructuralRR: 1.5,             // Min R:R from entry to TP1 at structure level
enableStrategyPlugins: false      // Phase 11 weight-0 packs default OFF
```

**Confidence Formula (lines 1002–1009):**
```typescript
confidenceRaw = max(longScore, shortScore) / 5  // confidenceDivisor=5
  + (independent ≥ 2 ? 0.15 : 0)                // multiConfirmBonus
  + (entryGrade === "A+" ? 0.05 : 0);
confidence = min(0.95, direction === "WAIT" ? min(confidenceRaw, 0.35) : confidenceRaw);
```
**Note (line 156):** *"Confidence is a model score, not a calibrated win probability. A+ ≠ 100% accuracy."*

### Confirmation Families (lines 799–829)
Four **independent** families must contribute ≥2 for base gates:
1. **structure** — trend, BOS, CHoCH, MTF, OB, FVG, sweep, break-retest
2. **delta** — CVD divergence, session CVD (soft only)
3. **orderflow** — stacked imbalances, bar delta, DOM (with trade-delta gate)
4. **volume** — VP VAL/VAH discount/premium, LVN continuation, POC/HVN warnings

### A+ Entry Checklist (`evaluateAPlusEntry`, lines 1125–1207)
**Default when `entryQuality: "a_plus"` (line 129)**

Requires ALL (line 859–882):
1. `structureOk === true` — at least one structure/MTF/zone factor scored
2. **HTF permission** (lines 1149–1165):
   - `mtf` context present (not null/empty)
   - No `conflictWithPrimary` (HTF majority vs primary trend)
   - For LONG: `higherTfBullish ≥ mtfMinHigherAgree` and `> higherTfBearish`
   - For SHORT: `higherTfBearish ≥ mtfMinHigherAgree` and `> higherTfBullish`
3. **OF trigger** (`orderFlowOk === true`, lines 1168–1172):
   - Stacked imbalances OR bar delta confirmation
   - **Session CVD alone does NOT set `orderFlowOk`** (lines 489–509: CVD is soft-score `cvdAligned` only)
4. **Location** (lines 1175–1198):
   - Must have one: `ob_bullish/bearish_zone`, `fvg_bullish/bearish_zone`, `sweep_ssl/bsl_reclaim`, `price_at_val_discount/vah_premium`, `lvn_bullish/bearish_continuation`, `break_retest_bullish/bearish`
5. **No opposing CHoCH warning** (lines 1200–1205)

**Failure → `direction = "WAIT"`, `entryGrade = "WAIT"`** (lines 870–878)

### WAIT Rules Summary (lines 832–851, 891–989)

**Base Gates (before A+):**
- `independent.size < minIndependent` (default 2)
- `longScore < shortScore + minLead` or `< minScore`
- `shortScore < longScore + minLead` or `< minScore`

**A+ Vetos (lines 859–882):** Any of the 5 A+ checks fails

**Safety Hard Vetos (lines 891–989):**
1. **Data not ready** (lines 901–914): Missing `footprint` or `volumeProfile.totalVolume < minVpTotalVolume` when `requireDataReady: true`
2. **Opposing iceberg** (lines 916–932): When `icebergVetoEnabled: true`, opposing bid/ask refill near entry with `confidence ≥ 0.4` within `0.0015` price proximity
3. **Swing proximity** (lines 934–963): Entry within `0.001` (0.1%) of opposing swing high/low
4. **Insufficient room to run** (lines 965–987): Structural R:R below `minRoomToRunR=1.5` or missing opposing S/R level

**Result:** `direction = demote(...) → "WAIT"`, `entryGrade = "WAIT"`, factors added as neutrals (lines 895–899)

---

## 2. Footprint / CVD / DOM / VP / Structure / Zones / Break-Retest Capabilities

### 2.1 Footprint (`packages/orderflow/src/footprint.ts`)

**Function:** `buildFootprintBar(symbol, trades, openTime, closeTime, options)`

**Inputs:** Aggressor-classified `TradeTick[]` with `{price, quantity, timestamp, buyerAggressor}`

**Outputs (`FootprintBar`, lines 1–86):**
```typescript
{
  cells: FootprintCell[] // { price, bidVolume, askVolume, delta, trades }
  totalDelta, totalVolume,
  imbalances: FootprintImbalance[], // {price, side, ratio, stacked, diagonal}
  absorption: boolean,  // heuristic: high-volume node with muted net delta
  exhaustion: boolean,  // heuristic: thin volume at extremes after directional push
  unfinishedAuction: boolean // zero opposing volume at bar high/low
}
```

**Aggressor Side (lines 20, 86–91):**
- **Exchange-reported** when adapter provides `buyerAggressor` flag
- Bid volume = seller-initiated (hit bid); Ask volume = buyer-initiated (lifted ask)
- Evidence: *"Aggressor side uses exchange trade flags when provided by the adapter."*

**Imbalance Rules (lines 97–139):**
- `imbalanceRatio` default 3:1 (ask/bid or bid/ask volume ratio)
- **Stacked:** ≥3 consecutive same-side imbalances (default `stackedCount`)
- **Diagonal:** Ask at price vs bid at price below (or reverse)

**Heuristics (lines 156–194):**
- **Absorption:** Node volume >25% of total with net delta <15% → possible absorption (line 163)
- **Exhaustion:** Thin volume (<40% avg) at extremes (±15% of range) after directional move (lines 166–185)
- **Unfinished auction:** Zero opposing volume at bar high/low (lines 189–194)
- Evidence: *"Absorption/exhaustion/unfinished auction are pattern heuristics, not institutional identity."*

### 2.2 CVD (`packages/orderflow/src/cvd.ts`)

**State:** `CvdState` = `{symbol, sessionStart, cvd, points: CvdPoint[], divergence, exhaustion}`

**Update:** `applyTradeToCvd(state, trade, maxPoints=2000)`
- Cumulative delta: `cvd += (buyerAggressor ? quantity : -quantity)` (line 23)
- Keeps rolling window of last 2000 points (line 30)

**Divergence Detection (lines 36–47):**
- Requires ≥40 points
- **Bullish:** Price down ≥0.05% while CVD up over 40-point window
- **Bearish:** Price up ≥0.05% while CVD down
- Evidence: *"CVD and divergence are derived from aggressor-signed trades; divergence is a heuristic."* (lines 465–469)

**Exhaustion Heuristic (lines 50–57):**
- Last 20 points: late-window absolute activity <45% of early-window
- Net delta <10% of total activity

**Usage in Signals (lines 464–523):**
- `cvdDivergence` (weight 1) sets `deltaOk=true` → unlocks A+ OF gate
- `cvdAligned` (weight 0.5) is **soft-only** when session CVD sign matches trend
- **Session CVD sign alone does NOT set `deltaOk`** (lines 489–507 comments)

### 2.3 DOM (`packages/orderflow/src/dom.ts`)

**Function:** `computeDomMetrics(book: OrderBookSnapshot, options)`

**Inputs:** Exchange-visible `{bids: BookLevel[], asks: BookLevel[]}` with `{price, quantity}`

**Outputs (`DomMetrics`, lines 11–70):**
```typescript
{
  bestBid, bestAsk, mid, spread,
  bidLiquidity, askLiquidity, // sum of top N levels (default 20)
  imbalance: (bid-ask)/(bid+ask), // safeDiv
  largeBidLevels, largeAskLevels, // ≥4× avg level size (default multiple)
  pullStackHint: "none"|"bid_stack"|"bid_pull"|"ask_stack"|"ask_pull",
  spoofingRisk: "low"|"unknown"|"elevated",
  evidence: [...]
}
```

**Pull/Stack Heuristic (lines 38–44):**
- Compare current liquidity to prior snapshot (stored in module-level `Map`)
- `>15%` increase → stack; `>15%` decrease → pull

**Spoofing Risk (lines 73–83):**
- **Elevated:** Large wall far from touch (level index ≥5) with pull event
- Evidence: *"Pull/stack and spoofingRisk are uncertain heuristics — not proof of spoofing or institutional intent."*

**Signal Integration (lines 603–664):**
- **Phase 3 gate:** `domImbalance` scores ONLY when `tradeDeltaLong/tradeDeltaShort` from footprint/CVD supports (line 609, `domRequiresTradeDelta: true`)
- Without trade-delta: `addNeutral("dom_bid/ask_unconfirmed")` → not counted toward gates (lines 619–643)
- Sets `orderFlowOk=true` when gated score fires (lines 617, 633)

### 2.4 Volume Profile (`packages/orderflow/src/volumeProfile.ts`)

**Function:** `buildVolumeProfile(symbol, trades, tickSize, from?, to?)`

**Inputs:** `TradeTick[]`, optional time window

**Outputs (`VolumeProfile`, lines 4–46):**
```typescript
{
  levels: VolumeProfileLevel[], // {price, volume, buyVolume, sellVolume}
  poc: number,  // price of control (highest volume level)
  vah: number,  // value area high (70% volume bracket)
  val: number,  // value area low
  hvn: number[], // high-volume nodes (≥80th percentile)
  lvn: number[], // low-volume nodes (≤20th percentile)
  totalVolume: number
}
```

**Value Area Algorithm (lines 51–78):**
- Start from POC, expand high/low alternately to capture 70% of total volume (default `pct=0.7`)

**Evidence:** *"POC/VAH/VAL/HVN/LVN are derived from session trades, not exchange-published levels."* (lines 670–672)

**Signal Usage (lines 668–754):**
- `price_at_val_discount` / `price_at_vah_premium` (weight 0.5, sets `volumeOk=true`)
- `price_at_poc` / `price_near_hvn` → neutrals (balance warnings)
- `lvn_bullish/bearish_continuation` (weight 0.5) only when `structure.trend` aligns (sets `volumeOk`)
- **Data readiness:** `requireDataReady: true` vetoes without `volumeProfile.totalVolume ≥ minVpTotalVolume` (lines 902–913)

### 2.5 Structure (`packages/orderflow/src/structure.ts`)

**Function:** `analyzeMarketStructure(symbol, candles, lookback=3, prevSessionHigh?, prevSessionLow?)`

**Inputs:** `Candle[]` (OHLC+volume)

**Outputs (`MarketStructureState`, lines 52–103):**
```typescript
{
  symbol, trend: "bullish"|"bearish"|"range",
  swings: SwingPoint[], // {kind: "high"|"low", price, timestamp, type: "HH"|"HL"|"LH"|"LL"}
  lastBos?: {direction, price, timestamp}, // Break of Structure
  lastChoch?: {direction, price, timestamp}, // Change of Character
  support: number[], // swing lows below current price (nearest 5)
  resistance: number[], // swing highs above current price (nearest 5)
  liquidityPools: [{side: "SSL"|"BSL", price, label}],
  previousSessionHigh?, previousSessionLow?,
  evidence: [...]
}
```

**Swing Detection (lines 105–120):**
- Pivot: candle high/low that is highest/lowest within `lookback` bars before & after
- Classify as HH/HL/LH/LL relative to prior same-kind swing

**BOS / CHoCH Heuristics (lines 142–182):**
- **Bullish BOS:** HH > prior high AND HL > prior low (lines 157–159)
- **Bearish BOS:** LH < prior high AND LL < prior low (lines 160–162)
- **CHoCH:** Break against prior trend using last opposite swing (lines 166–181)
- Evidence: *"BOS/CHoCH and liquidity pools are price-structure inferences, not order-flow proof of smart money."* (lines 98–101)

**Signal Usage (lines 199–287):**
- `structure_bullish/bearish` (weight 1), `structure_bos_bullish/bearish` (weight 0.75), `structure_choch_bullish/bearish` (weight 0.5)
- Sets `structureOk=true` for any scored structure factor (lines 200, 210, etc.)
- `structure_choch_warning` → veto in A+ when opposing CHoCH present (lines 271–277, 1200–1205)

**Multi-Timeframe (MTF) Context (`buildMultiTimeframeContext`, lines 203–238):**
- **Intervals:** 4h, 1h, 15m, 5m, 1m (default primary: 5m, soft LTF: 1m) (lines 10–24)
- **HTF Voting:** Count `higherTfBullish`, `higherTfBearish`, `higherTfRange` from 4h/1h only
- **Conflict:** Primary is directional but HTF majority opposes (lines 222–227)
- Signal factors: `mtf_htf_bullish/bearish` (weight 0.75) when ≥2 of 4h/1h agree (lines 302–325), `mtf_ltf_bullish/bearish` (weight 0.25) for soft LTF alignment (lines 327–346)

### 2.6 Zones (OB / FVG / Sweeps) (`packages/orderflow/src/priceZones.ts`)

**Function:** `detectStructureZones(symbol, candles, config, updatedAt)`

**Order Blocks (lines 122–173):**
- **Bullish OB:** Last down-candle (close < open) before a close above its high within N bars (default `obConfirmBars=5`); zone = [low, high]; invalidated on close < low
- **Bearish OB:** Last up-candle before a close below its low; invalidated on close > high
- Definition strings embedded (lines 36–38): *"Bullish OB: ... Invalidated on close < zone.low."*

**Fair Value Gaps (lines 72–119):**
- **Bullish FVG:** For candles i-2, i-1, i: `high[i-2] < low[i]`; zone = [high[i-2], low[i]]; mitigated when later low ≤ zone.low
- **Bearish FVG:** `low[i-2] > high[i]`; zone = [high[i], low[i-2]]; mitigated when later high ≥ zone.high
- Keep last 8 unmitigated FVGs (default `maxFvgs`)

**Liquidity Sweeps (lines 176–216):**
- **SSL sweep:** Bar low pierces prior swing-low, then close reclaims above that level on same bar
- **BSL sweep:** Bar high pierces prior swing-high, then close reclaims below
- **Swing lookback:** Default 3 bars (line 29)
- Bias: bullish for SSL reclaim, bearish for BSL reclaim
- Keep last 6 sweeps (default `maxSweeps`)

**Evidence (lines 64–68):** *"Order blocks, FVGs, and liquidity sweeps are mechanical OHLC heuristics with explicit rules — not exchange labels and not proof of institutional activity."*

**Signal Usage (lines 380–460):**
- `ob_bullish/bearish_zone` (weight 0.5), `fvg_bullish/bearish_zone` (weight 0.5), `sweep_ssl/bsl_reclaim` (weight 0.5)
- All set `structureOk=true` and count toward A+ **location** requirement (lines 1176–1191)
- `priceInZone(lastPrice, zone.low, zone.high)` checks for active price inside zone (lines 220–224)

### 2.7 Break-Retest (`packages/orderflow/src/breakoutRetest.ts`)

**State Machine:** `advanceBreakRetest(previous, input, config)`

**Phases (`BreakRetestPhase`, line 1):**
- `idle` → `balance` → `broken` → `retesting` → `accepted` | `failed` | `invalidated`
- Terminal hold: 60s before reset to idle (default `terminalHoldMs`, line 19)

**Balance Detection (lines 385–397):**
- Requires ≥8 bars (default `balanceBars`) with closes inside [demandBand.high, supplyBand.low]
- Max range: (supplyLow - demandHigh) / mid ≤ 8% (default `maxRangePct`, line 15)
- Uses nearest `ChartZoneBand` from `chartOverlay?.bands` (demand vs supply)

**Break Confirmation (lines 317–369):**
- Close beyond supply.high (bullish) or demand.low (bearish)
- **Requires OF continuation** via `ofSupports(side, footprint, cvd, config)` (lines 329, 349, 441–453):
  - Footprint `totalDelta` matches side with `|delta| ≥ minDeltaAbs` (default 0)
  - OR CVD slope over last N points (default `cvdSlopePoints=20`) matches side

**Retest Logic (lines 173–261):**
- Price returns to broken band within `retestMaxBars=12` (default, line 17)
- Reclaim hold: Close beyond broken band + OF continuation
- **Accepted:** Reclaim close + OF OK (lines 233–245)
- **Failed:** Retest window expires OR close back through range mid without hold (lines 165–172, 207–225)
- **Invalidated:** Close accepts through opposite band (LSK-style, lines 150–161)

**Evidence (lines 45–47):** *"Break/retest phases are mechanical heuristics on chart bands + order-flow deltas — not path forecasts or institutional labels."*

**Signal Usage (lines 757–795):**
- `break_retest_bullish/bearish` (weight 0.85) only when `phase === "accepted"` (lines 763–784)
- Sets `structureOk=true` and counts toward A+ **location** (lines 773, 783, 1182–1183)
- `break_retest_failed/invalidated` → neutral warnings (lines 785–793)

---

## 3. Paper Trading / Lifecycle / Validation Metrics

### 3.1 Lifecycle Transitions (`packages/orderflow/src/signalLifecycle.ts`)

**Function:** `applySignalLifecycle(previous, candidate, price, now, config)`

**Lifecycles:** `WATCHING` → `PENDING_CONFIRM` → `CONFIRMED` → `ACTIVE` → `HIT_TP` | `HIT_SL` | `INVALIDATED` | `TIMEOUT` | `EXPIRED`

**Rules (lines 46–293):**
1. **Terminal hold:** 60s suppression for same `setupId` after HIT_TP/SL/INVALIDATED/EXPIRED/TIMEOUT (lines 59–73)
2. **Same setupId continuation:** CONFIRMED → ACTIVE on first tick after confirmation; tracks TP/SL/CHoCH invalidation (lines 76–293)
3. **New setupId replacement:** Old non-terminal LONG/SHORT replaced with note (lines 82–90)
4. **Lost confirmations:** Directional → WAIT candidate triggers INVALIDATED (lines 133–154)
5. **PENDING timeout:** `age > pendingMaxAgeMs` (default 5min) without LONG/SHORT → TIMEOUT (lines 157–160)
6. **ACTIVE timeout:** `age > activeMaxAgeMs` (default 30min) without TP/SL → TIMEOUT (lines 266–273)
7. **SL hit:** `price ≤ stop` (LONG) or `≥ stop` (SHORT) → HIT_SL (lines 186–203)
8. **Phase 12 scale-out** (lines 206–249):
   - Default fractions: `[0.5, 0.3, 0.2]` per TP1/TP2/TP3 (line 29)
   - `tpHits` increments, `scaleRemainingFrac` decrements
   - Last TP or remaining ≤1e-9 → HIT_TP terminal
   - Else → stay ACTIVE with `SCALE_TP{n}:{frac}|...` note (line 246)
9. **Opposing CHoCH:** While CONFIRMED/ACTIVE, opposing CHoCH in `reasonsAgainst` → INVALIDATED (lines 253–263)
10. **Duplicate suppression:** First CONFIRMED prints alert; subsequent same-setupId ticks → ACTIVE (no re-alert) (lines 276–289)

**Config Defaults (`DEFAULT_LIFECYCLE_CONFIG`, lines 23–31):**
```typescript
pendingMaxAgeMs: 300_000,  // 5 min
activeMaxAgeMs: 1_800_000, // 30 min
terminalHoldMs: 60_000,    // 60 sec
scaleOut: { enabled: true, fractions: [0.5, 0.3, 0.2], fullCloseAtTp1: false }
```

**TP/SL Policy:**
- **Live tick:** SL-before-TP (line 186: check SL first)
- **OHLC helper:** Conservative `sl_first` mode (Phase 7 docs)

**Structure Targets (lines 173–183):**
- `tagStructureTargetHits(structureTargets, side, price, now)` marks when price touches MM/swing/session/VP targets
- `newlyHit` added to `lifecycleNote` (lines 180–183): *"Structure swing touched @ {price}"*

### 3.2 Paper Ledger (`apps/api/src/validation/paperLedger.ts`)

**Function:** `syncPaperTradeFromLifecycle({ previous, next, price, exchange, candles, ... })`

**Row Schema (`PaperTradeRow`, lines 35–69):**
```typescript
{
  id, setupId, symbol, exchange, marketType, pair, direction, lifecycle, outcome,
  generatedAt, openedAt, closedAt, primaryTimeframe, setupClass,
  entry, stopLoss, takeProfit: number[], exitPrice,
  confidence, confirmations: string[],
  grossPnl, fees, funding, netPnl, rMultiple, mfe, mae, holdMs,
  engineVersion, configVersion, regimeTags: MarketRegimeTag[],
  remainingFrac?, scaleFills: ScaleFillLeg[]
}
```

**Freeze Tags (lines 10, 185):**
- `engineVersion: "0.16.3-rr-1.5"` (`SIGNAL_ENGINE_VERSION`)
- `configVersion: fingerprintConfig({})` → SHA-256 hash of default signal+lifecycle+cost configs (16 chars)

**Opening (lines 134–227):**
- First CONFIRMED/ACTIVE tick for a new setupId → `INSERT OR IGNORE` with `outcome='OPEN'`
- `setupClass: deriveSetupClass(confirmations)` → `"RANGE_BREAK_RETEST"` if break-retest factor present, else `"OTHER"` (lines 8–14 in `paperStrata.ts`)
- `regimeTags: tagPaperRegimes({ structure, candles, quoteVolume24h, changePct24h })` (lines 46–74 in `paperStrata.ts`):
  - Structure/vol tags: `bullish_trending`, `bearish_trending`, `high_vol`, `ranging_low_vol`, etc. (from `altScanner.ts`)
  - Liquidity bucket: `liq_high` (≥$50M), `liq_mid` (≥$5M), `liq_low` (from 24h quote volume)
  - Range context: `post_pump_compression`, `clean_range` (from regime detection)
- `ofSnapshot` frozen with footprint/CVD/DOM/VP/structure/MTF/zones/break-retest snapshots + `structureTargets` + `quoteVolume24h` + `rangeContext`

**MFE/MAE Tracking (lines 125–132):**
- While `outcome='OPEN'`: update `mfe` (max favorable excursion) and `mae` (max adverse excursion) on each price tick
- Signed per side: LONG → `price - entry`; SHORT → `entry - price`

**Phase 12 Scale Fills (lines 231–321):**
- Detect `nextHits > prevHits` while ACTIVE/CONFIRMED (line 243)
- Parse note for `SCALE_TP{n}:{frac}` or compute from `scaleRemainingFrac` delta (lines 251–253)
- Compute costs per leg with `computeCostedPnl({ sizeFraction: frac })` (lines 256–266)
- Append to `scaleFills` JSON array: `{tpIndex, price, fraction, at, grossPnl, fees, funding, netPnl}` (lines 267–275)
- Accumulate partial `gross_pnl`, `fees`, `funding`, `net_pnl` (lines 277–280)
- Refresh `remaining_frac` and `r_multiple` (lines 282, 310)

**Terminal Closes (lines 323–388):**
- On HIT_TP/HIT_SL/INVALIDATED/TIMEOUT/EXPIRED: close remaining fraction with `computeCostedPnl({ sizeFraction: remaining })`
- **Outcomes (lines 420–426):**
  - `HIT_TP` / `HIT_SL` → resolved (wins/losses)
  - `INVALIDATED` / `TIMEOUT` / `EXPIRED` → unresolved (not counted in win rate)
  - `OPEN` → still active
- Include PnL for INVALIDATED/TIMEOUT/EXPIRED at exit price (line 341)
- Final `r_multiple = netPnl / risk` where `risk = |entry - stopLoss|` (lines 338, 348)

**Cost Model (`DEFAULT_COST_MODEL`, `packages/orderflow/src/validation/costModel.ts`):**
```typescript
feeBps: 4,              // 0.04% round-trip (4 bps notional per side)
slippageBps: 1,         // 0.01% slippage per side
fundingRateBpsPerDay: 0 // 0 bps/day funding (configurable)
```
- **Entry/exit fills:** `entryFill = entry * (1 ± slippage/10000)`, `exitFill = exit * (1 ± slippage/10000)` (lines 25–27)
- **Fees:** `feesPerUnit = feeBps/10000 * (entryNotional + exitNotional) * sizeFraction` (line 29)
- **Funding:** `fundingPerUnit = fundingRateBpsPerDay/10000 * avgNotional * (holdMs/86400000) * sizeFraction` (line 32)
- **Gross PnL:** `(exitFill - entryFill) * direction_multiplier` (line 36)
- **Net PnL:** `grossPnl - fees - funding` (line 37)

### 3.3 Validation Analytics (`packages/orderflow/src/validation/analytics.ts`)

**Sample Type:** `ClosedTradeSample` (lines 1–26)
- Requires `isResolvedWinLoss: true` for HIT_TP/HIT_SL only (line 10)
- `won: boolean | null` (true for TP, false for SL, null for unresolved)
- Includes `netPnl, grossPnl, fees, funding, rMultiple, confidence, holdMs, mfe, mae, regimeTags, setupClass, primaryTimeframe, configVersion`

**Performance Report (`computePerformance`, lines 154–216):**
```typescript
{
  totalSetups: n, openOrUnresolved: n, closedTrades: n (HIT_TP+HIT_SL),
  winningTrades: n, losingTrades: n,
  winRate: wins / closedTrades | null,
  winRateCi95: wilsonInterval(wins, closedTrades, z=1.96) | null,  // Wilson score CI
  grossProfit: Σ(max(0, netPnl)), grossLoss: |Σ(min(0, netPnl))|,
  netProfit: Σ(netPnl), profitFactor: grossProfit / grossLoss | null,
  averageR: mean(rMultiple) | null, expectancy: netProfit / closedTrades | null,
  maxDrawdown: peak-equity decline from closed trades,
  averageHoldMs, averageMfe, averageMae,
  falsePositiveRate: (INVALIDATED+TIMEOUT+EXPIRED) / (closedTrades + fps) | null,
  sampleNote: "Win rate and expectancy from N resolved TP/SL trades only. Open/invalidated/timeout excluded."
}
```

**Wilson Interval (lines 137–152):**
- Binomial proportion confidence interval (conservative vs Wald)
- Formula: `center ± margin / (1 + z²/n)` with continuity correction
- Returns `{low, high}` or `null` if `n ≤ 0`

**Calibration Report (`computeCalibration`, lines 219–275):**
- **Buckets:** [0–0.2, 0.2–0.35, 0.35–0.5, 0.5–0.65, 0.65–0.8, 0.8–1.0] (lines 224)
- For each bucket: `{label, minConf, maxConf, count, empiricalWinRate, avgConfidence, gap: empirical - avg}`
- **Brier score:** Mean squared error `Σ(confidence - outcome)²` (lines 248–258)
- **Log loss:** Negative log-likelihood `-Σ(y*log(p) + (1-y)*log(1-p))` with `eps=1e-6` (line 256)
- **`sufficient: true`** only when `resolved ≥ 40` (default `minPerBucket * 2 = 20 * 2`, line 263)
- **Note:** *"Confidence is still a model score until gap≈0 across buckets."* (line 270)

**Accuracy Gates (`evaluateAccuracyGates`, lines 40–94, Phase 8):**
```typescript
{
  overallClaimable: resolvedCount ≥ 100,  // PHASE8_GATES.overallMinResolved
  calibrationSufficient: calibration.sufficient (≥40 resolved),
  byRegimeClaimable: { [tag]: closedTrades ≥ 30 },  // stratumMinResolved
  bySetupClassClaimable: { [class]: closedTrades ≥ 30 },
  activeConfigVersion, locked: boolean,
  resolvedCount, overallMinResolved, stratumMinResolved,
  notes: ["Overall claimable at n=... | not claimable (...); Calibration insufficient; Claimable regimes: ..."]
}
```
**Rule:** *"Until overallClaimable === true: accuracy = undefined; no weight edits."* (Phase 8 docs)

**Grouping (lines 276–307):**
- `groupByRegime(samples)` → splits by each tag in `regimeTags[]` array
- `groupByKey(samples, keyFn)` → generic split by string key or key array

### 3.4 Tape Archive & Parity (`apps/api/src/validation/parityRunner.ts`, `packages/orderflow/src/tapeReplay.ts`)

**Tape Capture:**
- `archiveTradeTick(tick)` → `INSERT INTO trade_tape` on every focused symbol trade (Phase 7 docs)
- Columns: `symbol, timestamp, price, quantity, buyer_aggressor, trade_id, insert_time`

**Parity Runner (`GET /api/validation/parity?run=1`):**
1. Load `trade_tape` rows within time window (default `maxTicks=50_000`)
2. Reconstruct footprint/CVD/VP from tape ticks
3. Reconstruct structure/MTF/zones/break-retest from candle series sliced to each tick time
4. Call `generateSignal(input, DEFAULT_SIGNAL_CONFIG)` → full gates (not `structureOnlyMode`)
5. Apply `applySignalLifecycle` with tick prices for SL-before-TP
6. Compare to `paper_trades` rows: match by `setupId` or fuzzy (same side, ≤15min open, ≤0.25% entry band)
7. Report direction/outcome agreement rates, unmatched live/replay counts

**Status (Phase 9 docs, lines 29–39):**
- `no_tape` → nothing archived
- `ready_partial_of` → tape present, replay available (DOM still absent)
- `ready_with_overlap` → replay ran with live paper overlap
- `fullEngineParity: false` always until book archive exists
- `green: true` when tape count > 0

**Limitations (Phase 9 docs, lines 10–18):**
| Input | Reconstructed | Missing |
|-------|---------------|---------|
| Footprint/CVD/VP | ✅ from `trade_tape` | |
| Structure/MTF/zones/break-retest | ✅ from candles | |
| DOM/L2 | | ❌ Never archived |
| Lifecycle TP/SL | ✅ Tick `lastPrice`, SL-before-TP | |

---

## 4. Known Limitations from Docs and Code Comments

### From PHASE7_VALIDATION.md (lines 9–18, 29–36)

**Pre-Phase-7 gaps (now addressed):**
1. ~~No durable trade tape~~ → **Now:** `trade_tape` archive (Phase 7+)
2. ~~Journal PnL was gross~~ → **Now:** Paper ledger with fees/slippage/funding (Phase 7+)
3. ~~No engine/config version~~ → **Now:** `engineVersion` + `configVersion` frozen (Phase 7+)
4. ~~No TIMEOUT distinct from EXPIRED~~ → **Now:** TIMEOUT for age/max-hold (Phase 7+)
5. ~~Backtest label mismatch~~ → **Now:** Explicit structure-only proxy labeling (Phase 7+)
6. ~~Confidence not calibrated~~ → **Now:** Calibration report with Brier/log-loss (Phase 8+)
7. ~~Same-bar OHLC policy undocumented~~ → **Now:** SL-before-TP tick policy + conservative `sl_first` helper (Phase 7+)
8. ~~TP2/TP3 unused~~ → **Now:** Phase 12 scale-out with partial fills (Phase 12+)

**Remaining explicit non-goals (lines 29–32):**
- Structure-only backtest is a **labeled proxy**, not full-engine parity
- DOM/book archive not implemented (Phase 9: *"fullEngineParity: false always until book archive exists"*)

### From PHASE8_ACCURACY.md (lines 1–9, 50–59)

**Purpose:** Forward paper sample under **version lock** to measure actual accuracy

**Freeze (lines 10–18):**
- `SIGNAL_ENGINE_VERSION: "0.16.3-rr-1.5"` (R:R UI update)
- `CONFIG_VERSION: fingerprintConfig({})` → SHA-256 of defaults
- `VALIDATION_LOCK_CONFIG` defaults ON when `EXECUTION_MODE=PAPER`
- `POST /api/validation/signal-config` → **403** while locked

**Decision Rule (lines 44–46):**
> Until `gates.overallClaimable === true`: accuracy = **undefined**; no weight edits.  
> When gates pass: record results, then proceed to Phase 9 (parity) — still no retune unless a later research phase opens under OOS rules.

**Sample Gates (lines 23–32):**
| Gate | Floor | Meaning |
|------|-------|---------|
| Overall claimable | **100** resolved HIT_TP+HIT_SL | Publish expectancy / PF claims |
| Regime / setup-class | **30** resolved each | Stratum "claimable" |
| Calibration sufficient | **40** resolved | Still not confidence → P(win) until bucket gaps reviewed |

**Results (lines 49–60):** *"Sample still collecting — do not invent edge"* (table shows `_pending_` for all metrics)

**Non-goals (lines 62–67):**
- Full-OF historical replay / parity runner (Phase 9)
- Weight or gate optimization
- LIVE size increases from thin samples
- TP2/TP3 scale-out product work

### From PHASE9_PARITY.md (lines 10–39)

**What is reconstructed (lines 10–18):**
| Input | Source | Missing |
|-------|--------|---------|
| Footprint/CVD/VP | `trade_tape` | |
| Structure/MTF/zones/break-retest | Candle series | |
| Lifecycle TP/SL | Tick `lastPrice`, SL-before-TP | |
| DOM/L2 | | ❌ Never reconstructed |

**Parity Statuses (lines 30–39):**
- `no_tape` → Nothing archived
- `ready_partial_of` → Tape present; replay available (DOM still absent)
- `ready_with_overlap` → Replay ran with live paper overlap
- `green: true` when tape exists
- **`fullEngineParity: false` always until book archive exists**

**Non-goals (lines 59–62):**
- Book / DOM archive
- Weight unlock or optimization
- Treating structure-only backtest as full-engine edge

### From PHASE11_MICROSTRUCTURE.md (lines 1–49)

**Purpose:** Add heuristic microstructure analytics **without** changing confirmation gates, A+ checklist, or Phase 8 weight locks

**Modules (lines 7–15):**
| Module | Label | Mutation |
|--------|-------|----------|
| `icebergRefill.ts` | `heuristic` + confidence band | Never institutional ID |
| `leaderLagger.ts` | `heuristic` (not tick lead-lag) | Cross-section 24h % vs volume peers |
| `auctionModel.ts` | Observational; `mutatesScores: false` | R4 AMT/VP/OF shadow |
| `strategyPlugins.ts` | Weight-0 neutrals | Never bumps LONG/SHORT |
| `commentary.ts` | `mutatesScores: false` always | Template narrative |

**Signal Engine Rules (lines 23–36):**
- Iceberg → `addNeutral` warning only by default; `icebergVetoEnabled` defaults **false**
- Optional hard veto only when `icebergVetoEnabled: true`
- Plugins require `enableStrategyPlugins: true` (default **false**)
- Pack factors forced to `weight: 0` and non-`exchange_reported`
- Commentary never written into confidence / direction / confirmations
- Auction shadow never written into confidence / direction / confirmations / A+

**Non-goals (lines 38–42):**
- Claiming institutional / iceberg identity from the exchange
- Multi-symbol live OF for true tick lead-lag
- Unlocking Phase 8 weight edits
- R5 WAIT vetoes from auction state (requires separate approval)

### From PHASE7_AUDIT.md (lines 1–32)

**Architecture (line 5):**
> Live: Exchange WS → `marketHub` → footprint/CVD/DOM/VP/structure/MTF/zones → `generateSignal` → `applySignalLifecycle` → journal + paper ledger + trade_tape.

> Historical default: REST klines → `backtestSignalEngine` with **structure + MTF only** and relaxed gates (`structureOnlyMode`).

**Confirmed Gaps (lines 9–18):**
1. ~~No durable trade tape~~ → Phase 7+
2. ~~Journal PnL was gross~~ → Phase 7+
3. ~~No engine/config version~~ → Phase 7+
4. ~~No TIMEOUT~~ → Phase 7+
5. ~~Backtest label mismatch~~ → Phase 7+
6. ~~Confidence not calibrated~~ → Phase 8+
7. ~~Same-bar OHLC policy undocumented~~ → Phase 7+
8. ~~TP2/TP3 unused~~ → Phase 12+

**Non-goals (lines 29–32):**
- Do not retune weights to raise dashboard win rate
- Do not execute real-money trades
- Do not silently substitute structure-only results for full-engine claims

### From ARCHITECTURE.md (lines 1–103)

**Status (lines 3–6):**
> The repository was greenfield (`README.md` only). No reusable trading modules existed. This platform is introduced as a TypeScript monorepo.

**Design Goals (lines 10–16):**
1. Real exchange market data (not simulated tape presented as live)
2. Accurate, testable order-flow calculations separated from UI
3. Paper trading as the **default** execution mode
4. Live trading only after explicit user authorization
5. Clear labeling of **exchange-reported** vs **inferred** analytics
6. Modular exchange adapters

**Limitation (line 62):**
> Visible L2 size is not "institutional identity." Large resting liquidity and spoofing heuristics are **indicators with uncertainty**, never definitive labels.

**Signals (line 75):**
> Signals require **≥2 independent confirmations**. Single-indicator signals are rejected.

**Execution Modes (lines 78–82):**
1. **ANALYSIS_ONLY** — no orders
2. **PAPER** (default) — simulated fills against live book/last price
3. **LIVE** — signed exchange orders; requires `confirmLiveTrading=true` per session

### From ROADMAP.md (lines 1–62)

**Phase 8 — Prove accuracy (lines 14–21):**
> - [x] Config fingerprint lock + version-split report  
> - [x] Sample gates (overall ≥100, stratum ≥30, calibration ≥40)  
> - [x] Focus rotation across DEFAULT_SYMBOLS  
> - [x] Validation UI banners + byRegime / bySetupClass claimable tables  
> - [ ] **Collect ≥100 resolved TP/SL under locked fingerprint (ops — leave PAPER running)**  
> - [ ] **Publish CI / expectancy in PHASE8 results table when claimable**

**Phase 9 — Parity (lines 23–30):**
> - [x] Tape load + OF replay (footprint/CVD/VP + structure/MTF/zones)  
> - [x] Live paper vs replay compare (setupId / time-side)  
> - [ ] **DOM/book archive for full-engine parity (future)**

**Phase 10 — Hardening (lines 32–39):**
> - [x] Bybit linear public MD adapter  
> - [x] TLS_CA_FILE / NODE_EXTRA_CA_CERTS + optional TLS_INSECURE  
> - [x] Rich /health + Prometheus /metrics  
> - [x] Encrypted secrets store API + Settings UI (masked)  
> - [ ] **Bybit LIVE trading adapter (future)**

**Phase 11 — Microstructure (lines 48–55):**
> - [x] Iceberg / refill heuristics with confidence bands  
> - [x] Catalog cross-section leader/lagger (not multi-OF WS)  
> - [x] Template commentary module (never mutates scores)  
> - [x] Strategy plugins API (weight-0 packs; default off)

**Explicit Non-Goals for v1 (lines 60–62):**
- Claiming detection of specific institutions
- Auto-live trading without user confirmation
- Presenting mock tape as live exchange data

### Code Comments

**Confidence Note (`signals.ts`, line 156):**
> *"Scores use configurable rule weights (A+ entry profile when enabled: HTF permission + OF trigger + location; BOS/CHoCH/VP/zones/break-retest; DOM needs trade-delta). Confidence is a model score, not a calibrated win probability. A+ ≠ 100% accuracy."*

**Session CVD Limitation (`signals.ts`, lines 489–509):**
> Session CVD sign (positive/negative) adds soft-score `cvdAligned` (weight 0.5) only when structure aligns.  
> *"Soft score only — session CVD sign does not set deltaOk / unlock A+ OF."* (lines 497, 507)

**DOM Trade-Delta Gate (`signals.ts`, lines 593–664):**
> *"Phase 3: DOM L2 pressure only scores when trade delta supports the same side."* (line 65)  
> Without footprint/CVD support: `addNeutral("dom_bid/ask_unconfirmed")` → not counted toward gates (lines 619–643)

**Iceberg Heuristic (`icebergRefill.ts`, lines 44–49, 119–127):**
> *"Iceberg/refill uses visible L2 size changes only — not exchange iceberg flags and not institutional identity."*  
> Confidence band is heuristic: `score = min(1, refillCount / (minRefills + 3))` (line 89)

**Auction Shadow (`auctionModel.ts`, lines 37–40, 102–108):**
> *"R4 auction shadow is observational only — never mutates generateSignal scores, gates, or A+."*  
> `mutatesScores: false` always (line 153)

**Strategy Plugins (`strategyPlugins.ts`, lines 37–64):**
> *"Run registered packs. Results are informational / reasonsAgainst only — callers must not treat pack factors as independent confirmation families."*  
> Forced `weight: 0`, source forced non-`exchange_reported` (lines 46–50)

**Paper Outcomes (`paperLedger.ts`, lines 420–426):**
```typescript
function mapOutcome(lifecycle: string): PaperOutcome {
  if (lifecycle === "HIT_TP") return "HIT_TP";
  if (lifecycle === "HIT_SL") return "HIT_SL";
  if (lifecycle === "INVALIDATED") return "INVALIDATED";
  if (lifecycle === "TIMEOUT") return "TIMEOUT";
  if (lifecycle === "EXPIRED") return "EXPIRED";
  return "OPEN";
}
```
**Resolved vs Unresolved:** Only HIT_TP and HIT_SL count toward win rate (lines 10, 158–162 in `analytics.ts`)

---

## 5. Market Data Realities: Crypto Futures (Binance/OKX/Bybit), Book Depth, Unknowables

### 5.1 Exchange Adapters

**Supported Venues (`apps/api/src/config.ts`, `packages/exchange`):**
1. **Binance USD-M Futures** (default)
   - WS: `aggTrade` stream for trades (aggressor: `m` buyer-is-maker flag)
   - WS: `depth@100ms` diff + REST snapshot for order book
   - REST: `klines` for candles
   - Signed REST: Live trading adapter included (`BinanceFuturesTradingAdapter`)
2. **OKX Swap**
   - WS: `trades` stream (aggressor: `side` taker flag)
   - WS: `books5` + REST books for order book
   - REST: Candles
   - Paper adapter only (no live trading adapter)
3. **Bybit Linear (Phase 10)**
   - Public market data adapter: trades + book + candles
   - Shared `createMarketDataAdapter` interface
   - Live trading adapter: **future** (ROADMAP line 37)

**Selection:** `EXCHANGE=okx|binance` env var

### 5.2 Trade Data (Footprint / CVD)

**Aggressor Classification:**
- **Exchange-reported** when adapter provides `buyerAggressor` flag (lines 20, 86–91 in `footprint.ts`)
- Binance: `aggTrade.m` (buyer is maker → seller aggressor if true)
- OKX: `trades.side` (taker flag)
- Bybit: Similar taker-side flag
- Evidence tag: *"Aggressor side uses exchange trade flags when provided by the adapter."* (`footprint.ts` line 88)

**CVD Evidence (`cvd.ts`, lines 11–16):**
> *"Delta uses exchange aggressor flags when available; otherwise tick-rule inference is labeled."*

**Footprint Heuristics (`footprint.ts`, lines 91–94):**
> *"Absorption/exhaustion/unfinished auction are pattern heuristics, not institutional identity."*

### 5.3 Order Book (DOM)

**L2 Depth:**
- **Exchange-visible** sizes only (`dom.ts` lines 61–65)
- Binance: REST snapshot + `depth@100ms` diffs (best 20–1000 levels configurable)
- OKX: WS `books5` (best 5 each side) + REST books
- Bybit: Similar depth subscription
- **Top N levels:** Default 20 (line 17 in `dom.ts`, option `topLevels`)

**Evidence Tags (`dom.ts`, lines 61–70):**
> *"Depth quantities are exchange-visible L2 only."* (kind: `exchange_reported`)  
> *"Pull/stack and spoofingRisk are uncertain heuristics — not proof of spoofing or institutional intent."* (kind: `heuristic`)

**Large Liquidity (`dom.ts`, lines 26–29):**
- Threshold: `≥4× avgLevelSize` (default `largeLiquidityMultiple`)
- Flags level as "large" but **not** institutional identity

**Spoofing Risk (`dom.ts`, lines 73–83):**
- **Elevated:** Large wall far from touch (level index ≥5) with pull event (line 79)
- **Unknown:** Large wall without pull
- **Low:** No far large walls
- Heuristic only — not exchange labels

### 5.4 Iceberg / Refill Detection (`icebergRefill.ts`)

**Method (lines 20–132):**
- Track per-symbol price→level history (module-level `Map`)
- **Pull:** Qty drops to <35% of prior (line 72)
- **Refill:** Qty recovers to ≥70% of prior and >105% of prior (lines 76–80)
- Count consecutive refills; flag when ≥2 (default `minRefills`, line 42)

**Confidence Band (line 89):**
```typescript
score = min(1, refillCount / (minRefills + 3))
```

**Evidence (lines 44–49):**
> *"Iceberg/refill uses visible L2 size changes only — not exchange iceberg flags and not institutional identity."*

**Signal Integration (`signals.ts`, lines 653–664):**
- `dom.iceberg` attached to `DomMetrics` via `detectIcebergRefill(book)` (Phase 11)
- **Default:** `addNeutral("dom_iceberg_refill")` warning only (line 653)
- **Optional veto:** `icebergVetoEnabled: false` by default (line 140)
- When `icebergVetoEnabled: true` and opposing refill near entry with `confidence ≥ 0.4` within `0.0015` proximity → hard WAIT veto (lines 916–932)

### 5.5 Volume Profile

**Source (`volumeProfile.ts`, lines 4–46):**
- Derived from `TradeTick[]` with `{price, quantity, timestamp, buyerAggressor}`
- **Not** exchange-published POC/VAH/VAL levels
- Evidence: *"POC/VAH/VAL/HVN/LVN are derived from session trades, not exchange-published levels."* (`signals.ts` lines 670–672)

**Session Window:**
- Default: all trades in provided array (`from` / `to` optional, lines 6–13)
- Tick size bucketing: `roundToTick(price, tickSize)`

### 5.6 What **Cannot** Be Known (Exchange Limitations)

**From ARCHITECTURE.md (line 62):**
> Visible L2 size is not "institutional identity." Large resting liquidity and spoofing heuristics are **indicators with uncertainty**, never definitive labels.

**Explicit Unknowables:**
1. **Iceberg Order Identity:**
   - Exchange L2 shows aggregate visible size; hidden iceberg portions are invisible until they replenish
   - Refill heuristic detects size disappear/reappear but cannot prove it's the same iceberg order ID or institutional actor
   - Binance/OKX/Bybit do **not** publish iceberg flags on L2 book updates
   - Evidence: *"not exchange iceberg flags and not institutional identity"* (`icebergRefill.ts` lines 47–48)

2. **Institutional Actor Attribution:**
   - Exchanges do not label trades or book orders by participant type (retail, MM, institution, whale)
   - Large sizes, absorption, exhaustion, spoofing risk are **pattern heuristics only**
   - Signal engine: *"BOS/CHoCH and liquidity pools are price-structure inferences, not order-flow proof of smart money."* (`structure.ts` lines 98–101)
   - Zones: *"not exchange labels and not proof of institutional activity"* (`priceZones.ts` line 67)

3. **Hidden Liquidity:**
   - Exchange book shows **visible** limit orders only
   - Hidden/iceberg portions, stop orders, and conditional orders not visible until triggered
   - Signal gates require visible DOM imbalance but acknowledge limitation (line 62 in ARCHITECTURE.md)

4. **Future Order Intent:**
   - Cannot predict when visible liquidity will be pulled, executed, or replaced
   - Pull/stack events are **historical observations**, not forecasts (`dom.ts` line 69)

5. **True Fill Priority:**
   - Cannot know queue position for same-price orders
   - Paper fills assume instant market execution at last price (or limit price) without queue slippage beyond `slippageBps`

6. **Funding Rate Precision (Futures):**
   - DEFAULT_COST_MODEL uses `fundingRateBpsPerDay: 0` (line 7 in `costModel.ts`)
   - Real funding rates fluctuate per 8h period; not forecasted in paper PnL

### 5.7 Book Depth Available

**Binance USD-M:**
- WS `depth@100ms`: diff updates for best 20/50/100/500/1000 levels (configurable)
- REST snapshot: full book depth (can request up to 1000 levels)
- Market data hub default: **top 20 levels** (`topLevels` option)

**OKX Swap:**
- WS `books5`: best 5 bids + 5 asks (fast updates)
- REST books: deeper depth available (up to 400 levels in some markets)
- DOM metrics: uses top 20 from available depth

**Bybit Linear:**
- WS orderbook: 25/50/100/200 depth levels (subscription level configurable)
- REST snapshot: up to 200 levels
- DOM metrics: top 20 default

**Signal Engine Usage:**
- DOM imbalance: sums top N levels (default 20, line 17 in `dom.ts`)
- Large level detection: compares each level to `avgLevelSize * 4` (default multiple)
- Deeper levels beyond top 20 not used in current DOM scoring (option `topLevels` can increase)

### 5.8 Market Data Labels

**Exchange-Reported (`EvidenceTag.kind: "exchange_reported"`):**
- Aggressor flags on trades (Binance `m`, OKX `side`)
- Visible L2 book sizes
- OHLCV candle data

**Inferred/Heuristic (`EvidenceTag.kind: "inferred"|"heuristic"`):**
- Footprint cells (inferred from aggressor trades)
- CVD divergence (heuristic pattern vs price)
- DOM pull/stack/spoofing risk (heuristic from size changes)
- VP POC/VAH/VAL/HVN/LVN (derived from trades)
- Market structure BOS/CHoCH/liquidity pools (inferred from candle swings)
- Order blocks, FVGs, liquidity sweeps (mechanical OHLC heuristics)
- Break-retest phases (mechanical band + OF heuristics)
- Iceberg refill (heuristic from L2 size changes)
- Auction shadow (observational AMT heuristic)

**Evidence Arrays:**
- Every `TradingSignal` includes `evidence: EvidenceTag[]` (line 1115 in `signals.ts`)
- Each module tags its outputs with `kind` and `note` (e.g., `footprint.ts` lines 85–94, `dom.ts` lines 61–70)

---

## 6. What auctionModel / strategyPlugins Do vs Do Not Change in generateSignal

### 6.1 Auction Model (`packages/orderflow/src/auctionModel.ts`)

**Function:** `computeAuctionShadow(input, config)`

**Purpose (lines 44–47):**
> *"Fabio-style AMT/VP/OF shadow features for paper observability. Deterministic heuristics — not a trade signal and not institutional identity."*

**Outputs (`AuctionShadowSnapshot`, lines 48–155):**
```typescript
{
  state: "BALANCE"|"IMBALANCE"|"UNKNOWN",
  modelMode: "OFF"|"TREND_CONTINUATION"|"MEAN_REVERSION",
  poc, vah, val, priceVsValue: "above_vah"|"below_val"|"inside"|"unknown",
  nearestLvn, nearestLvnDistPct, nearLvn: boolean,
  aggressionSide: "buy"|"sell"|"none",
  aggressionScore: number, // [0, 1] heuristic confidence
  followThrough: "supportive"|"absorbing"|"unknown",
  failedAuction: "failed_high"|"failed_low"|"none",
  notes: string[],
  evidence: [{ kind: "heuristic", note: "... observational only — never mutates generateSignal scores, gates, or A+." }],
  mutatesScores: false
}
```

**Heuristics (lines 56–218):**
1. **Price vs Value:** Inside VA → `BALANCE`, outside → `IMBALANCE` (lines 60–76)
2. **Near LVN:** Distance ≤ `lvnProximityPct` (default 0.0015 = 0.15%) (lines 78–95)
3. **Aggression Side:** Stacked imbalances ≥2 OR bar delta ratio ≥0.15 (lines 158–179)
4. **Follow-Through:** Delta/CVD supports aggression side vs absorption (lines 182–204)
5. **Failed Auction:** Break-retest `failed` or `invalidated` phase (lines 207–218)
6. **Model Mode (lines 115–128):**
   - `TREND_CONTINUATION` if IMBALANCE + aggression + supportive follow-through
   - `MEAN_REVERSION` if BALANCE OR failed auction
   - `OFF` otherwise

**Evidence Tag (lines 37–40):**
```typescript
{
  kind: "heuristic",
  note: "R4 auction shadow is observational only — never mutates generateSignal scores, gates, or A+."
}
```

**Usage in Signals:**
- **Never called directly** by `generateSignal()`
- **Attached by hub:** `marketHub` computes shadow and stores in snapshot `microstructure.auctionShadow` (Phase 11 docs line 24)
- **Paper frozen:** `ofSnapshot.auctionShadow` frozen on paper trade open (Phase 11 docs line 25)
- **UI observability only:** Displayed in commentary/microstructure panel; never alters `longScore`, `shortScore`, `confirmations`, `direction`, `entryGrade`, `confidence`

**Proof (lines 153, 37–40, Phase 11 docs lines 35–36):**
> `mutatesScores: false`  
> *"Auction shadow never written into confidence / direction / confirmations / A+."*

### 6.2 Strategy Plugins (`packages/orderflow/src/strategyPlugins.ts`)

**API (lines 1–136):**
```typescript
registerConfirmationPack(id: string, pack: (input: SignalInput) => ConfirmationPackResult)
unregisterConfirmationPack(id: string)
listConfirmationPacks(): string[]
clearConfirmationPacks()
applyConfirmationPacks(input: SignalInput): ConfirmationPackResult
```

**Pack Result (lines 3–9):**
```typescript
{
  factors: SignalFactor[],     // {id, family, side, weight, source, reason}
  evidence: EvidenceTag[],
  reasonsAgainst: string[]
}
```

**Integration (`signals.ts`, lines 991–1001):**
```typescript
if (config.enableStrategyPlugins) {  // default: false (line 137)
  const pack = applyConfirmationPacks(input);
  for (const f of pack.factors) {
    factors.push(f);
    if (f.side === "neutral") reasonsAgainst.push(f.reason);
  }
  evidence.push(...pack.evidence);
  reasonsAgainst.push(...pack.reasonsAgainst);
}
```

**Forced Constraints (`applyConfirmationPacks`, lines 37–64):**
1. **Weight forced to 0 (line 48):** `{ ...f, weight: 0, ... }`
   - **Result:** Cannot bump `longScore` or `shortScore` (lines 180, 188 in `signals.ts`)
2. **Source forced to non-`exchange_reported` (lines 49–50):**
   ```typescript
   source: f.source === "exchange_reported" ? "heuristic" : f.source
   ```
   - **Result:** Cannot masquerade as exchange data
3. **ID prefixed (line 51):** `plugin_{id}_{f.id}` unless already prefixed
4. **Evidence tag added (lines 59–63):**
   ```typescript
   {
     kind: "heuristic",
     note: "Strategy plugin factors are weight-0 and never mutate core confirmation gates."
   }
   ```

**Proof of Non-Mutation:**
- **Independent families** (`signals.ts` lines 797–829): Computed from `confirmations` BEFORE plugins merge (line 991 merges after line 831 family count)
- **Base gates** (lines 832–851): Use `independent.size`, `longScore`, `shortScore` computed from core factors only
- **A+ checklist** (lines 857–882): `evaluateAPlusEntry` called with pre-plugin `structureOk`, `deltaOk`, `orderFlowOk`, `volumeOk`, `confirmations`, `factors` (line 859 args)
- **Safety vetos** (lines 891–989): Data-ready, iceberg, swing, room-to-run checks run BEFORE plugin merge (line 991)

**Default Packs (`registerDefaultMicrostructurePack`, lines 106–136):**
1. **`auction_amt_shadow`** (Phase 11, R4, lines 69–103 in `strategyPlugins.ts`):
   - Wraps `computeAuctionShadow()`
   - Single neutral factor: `auction_shadow_state` (weight 0, side: neutral)
   - Reason: *"Auction shadow STATE/MODE (priceVsValue) — observational only."*
   - `reasonsAgainst` only if `state === "BALANCE" && modelMode === "OFF"`
   - **Still gated by `enableStrategyPlugins: false` default** (Phase 11 docs line 26)

2. **`iceberg_caution`** (lines 108–136):
   - Surfaces `dom.iceberg` if `confidence ≥ 0.4` (line 112)
   - Single neutral factor: `iceberg_refill_caution` (weight 0, side: neutral)
   - Reason: `iceberg.note ?? "Iceberg/refill heuristic on {side}"`
   - Evidence: *"Plugin iceberg_caution — does not score LONG/SHORT."*
   - `reasonsAgainst`: *"Iceberg/refill heuristic active ({side}, conf {confidence}) — treat visible size cautiously."*

**Registration Requirement (Phase 11 docs lines 23–24, 28):**
- `registerDefaultMicrostructurePack()` must be called to load packs
- **Still requires `enableStrategyPlugins: true` in config to run** (line 991 in `signals.ts`)
- **Default: OFF** (line 137 in `signals.ts`: `enableStrategyPlugins: false`)

**Usage in Validation:**
- Paper ledger **does not freeze plugin factors** (only core confirmations, line 220 in `paperLedger.ts`)
- Validation report **does not group by plugin factors** (groupByRegime uses `regimeTags`, lines 276–279 in `analytics.ts`)
- **Result:** Plugins do not affect Phase 8 sample collection or claimability gates

---

## Summary Table: What Changes vs What Stays Fixed

| Item | auctionModel | strategyPlugins | Core generateSignal |
|------|--------------|-----------------|---------------------|
| **Computes `longScore` / `shortScore`** | ❌ (observational) | ❌ (weight forced to 0) | ✅ Weighted factors |
| **Sets `direction` (LONG/SHORT/WAIT)** | ❌ | ❌ | ✅ Gates: ≥2 families, minScore, minLead |
| **Sets `entryGrade` (A+/STANDARD/WAIT)** | ❌ | ❌ | ✅ A+ checklist |
| **Affects `independent.size` count** | ❌ | ❌ | ✅ Families from confirmations |
| **Affects `confidence` formula** | ❌ | ❌ | ✅ Max score / divisor + bonuses |
| **Affects A+ HTF/OF/location gates** | ❌ | ❌ | ✅ structureOk, orderFlowOk, location IDs |
| **Affects safety vetos (data-ready, iceberg, swing, room)** | ❌ | ❌ | ✅ Hard WAIT on veto |
| **Added to `factors[]` array** | ❌ | ✅ (weight 0, neutral) | ✅ (weighted, sided) |
| **Added to `evidence[]` array** | ✅ (heuristic tag) | ✅ (heuristic tag) | ✅ (mixed tags) |
| **Added to `reasonsAgainst[]` array** | ❌ (via plugin pack) | ✅ | ✅ Neutrals + warnings |
| **Added to `confirmations[]` array** | ❌ | ❌ | ✅ Scored factor IDs |
| **Frozen in paper `ofSnapshot`** | ✅ (shadow field) | ❌ | ✅ (confirmations, factors, scores) |
| **Used in validation gates** | ❌ | ❌ | ✅ (setupClass, regimeTags) |
| **Default enabled** | ❌ (requires `enableStrategyPlugins`) | ❌ (requires `enableStrategyPlugins`) | ✅ Always |

---

## Key Config Defaults (Quoted from Code)

**From `signals.ts` lines 106–148:**

```typescript
export const DEFAULT_SIGNAL_CONFIG: SignalEngineConfig = {
  weights: {
    structureTrend: 1, structureBos: 0.75, structureChochAlign: 0.5,
    mtfHigherAlign: 0.75, mtfSoftAlign: 0.25,
    orderBlock: 0.5, fairValueGap: 0.5, liquiditySweep: 0.5,
    cvdDivergence: 1, cvdAligned: 0.5,
    stackedImbalance: 1, barDelta: 0.5, domImbalance: 0.5,
    volumeProfileExtreme: 0.5, lvnContinuation: 0.5,
    breakRetestAccept: 0.85,
  },
  levelProximityPct: 0.0015,       // 0.15% price distance for "near" levels
  domRequiresTradeDelta: true,     // DOM scores only with footprint/CVD support
  mtfMinHigherAgree: 2,            // ≥2 of 4h/1h must agree for HTF align
  sweepMaxAgeMs: 14_400_000,       // 4h = 14,400,000 ms
  entryQuality: "a_plus",          // A+ default; "standard" available
  minIndependent: 2,               // ≥2 distinct families required
  minScore: 2,                     // Min weighted score for LONG/SHORT
  minLead: 1,                      // Leading side must exceed opposing by ≥1
  confidenceDivisor: 5,            // confidence = maxScore / 5 + bonuses
  multiConfirmBonus: 0.15,         // +0.15 when ≥2 families
  waitConfidenceCap: 0.35,         // Cap confidence at 0.35 for WAIT
  enableStrategyPlugins: false,    // Phase 11 weight-0 packs default OFF
  requireDataReady: true,          // Reject LONG/SHORT without footprint+VP
  minVpTotalVolume: 1,             // VP volume threshold
  icebergVetoEnabled: false,       // Hard opposing iceberg veto default OFF
  icebergVetoMinConfidence: 0.4,
  icebergVetoProximityPct: 0.0015,
  swingProximityPct: 0.001,        // 0.1% proximity to opposing swing → veto
  minRoomToRunR: 1.5,              // ≥1.5R to first opposing structure required
  stopBufferPct: 0.001,            // 0.1% buffer beyond stop level
  minStructuralRR: 1.5,            // Min R:R from entry to TP1 at structure
};
```

**From `signalLifecycle.ts` lines 23–31:**

```typescript
export const DEFAULT_LIFECYCLE_CONFIG: LifecycleConfig = {
  pendingMaxAgeMs: 300_000,        // 5 min
  activeMaxAgeMs: 1_800_000,       // 30 min
  terminalHoldMs: 60_000,          // 60 sec
  scaleOut: {
    enabled: true,
    fractions: [0.5, 0.3, 0.2],    // 50% @ TP1, 30% @ TP2, 20% @ TP3
    fullCloseAtTp1: false,
  },
};
```

**From `validation/costModel.ts` lines 5–9:**

```typescript
export const DEFAULT_COST_MODEL: CostModelConfig = {
  feeBps: 4,                       // 0.04% round-trip (4 bps notional per side)
  slippageBps: 1,                  // 0.01% slippage per side
  fundingRateBpsPerDay: 0,         // 0 bps/day funding (configurable)
};
```

**From `validation/versions.ts` lines 7–14:**

```typescript
export const SIGNAL_ENGINE_VERSION = "0.16.3-rr-1.5";

export const PHASE8_GATES = {
  overallMinResolved: 100,         // Publish expectancy / PF claims floor
  stratumMinResolved: 30,          // Per-regime / per-setupClass claimable floor
  calibrationMinResolved: 40,      // Confidence → P(win) calibration floor
};
```

**From `risk.ts` lines 23–31:**

```typescript
export function resolveSizingProfile(profile: SizingProfile = "standard"): SizingProfileResolved {
  switch (profile) {
    case "conservative": return { riskPercentPerTrade: 0.25, minEntryGrade: "A+" };
    case "aggressive":   return { riskPercentPerTrade: 1.0,  minEntryGrade: "STANDARD" };
    default:             return { riskPercentPerTrade: 0.5,  minEntryGrade: "STANDARD" };
  }
}
```

---

## Verification Notes

All findings verified from:
- Code files: `packages/orderflow/src/` (signals, lifecycle, footprint, cvd, dom, volumeProfile, structure, priceZones, breakoutRetest, auctionModel, strategyPlugins, icebergRefill, risk, validation/*)
- API files: `apps/api/src/` (paperLedger, execution, validation/parityRunner)
- Documentation: `docs/` (PHASE7_VALIDATION, PHASE7_AUDIT, PHASE8_ACCURACY, PHASE9_PARITY, PHASE11_MICROSTRUCTURE, ARCHITECTURE, ROADMAP)

No speculation. All file paths, line numbers, and config values cited directly from code.

---

**End of Audit Report**
