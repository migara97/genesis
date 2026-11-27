# Axia Footprint Playlist × Genesis Signal Engine — Master Integration Report

**Playlist:** [FOOTPRINT TRADING TUTORIALS](https://youtube.com/playlist?list=PLXmsdXAkBS4qZi2Lp2a-jrM-o71v4Ic6j) (Axia Futures / Brannigan)  
**Date:** 2026-11-27  
**Engine status:** PAPER mode; Phase 8 accuracy **undefined** until ≥100 resolved HIT_TP+HIT_SL under locked fingerprint  
**Code status:** Analysis only — no Signal Engine weights/gates modified by this report  

**Honesty rules used throughout**
- Video content is attributed only when titles, descriptions, or accessible captions/transcripts were retrieved.
- Lessons without deep transcript access are marked **title-level**.
- No fabricated win rates, expectancy, or “proven edge.”
- Genesis capabilities are taken from code/docs audit only (`packages/orderflow`, `docs/PHASE*`, `AUDIT_REPORT.md`).

---

## Access & study method

| Source | Coverage |
|--------|----------|
| YouTube playlist HTML + browser inventory | **42/42** titles, durations, video IDs |
| Deep transcript / caption extract | Core methodology videos listed in §1.2 |
| Title + description / summary only | Remaining playlist items |
| Complementary Axia workshops (not in playlist) | Part 1 `jBS4utCt3eU`, Part 2 `vVQyQMWDd8A` — used as supporting clarification only |
| Genesis codebase | Full audit of engines, gates, validation, market-data limits |

**Unavailable / limited:** Frame-by-frame live chart scrubbing; some older lessons without usable captions. Those are not invented.

---

# 1. Complete playlist knowledge notes

## 1.1 Instructor methodology (reconstructed from accessible lessons)

Axia’s public footprint method is **not** “buy stacked imbalances.” It is an **Actual vs Expected** auction framework:

```
Context (structure / profile / prior positioning)
        ↓
Trigger / key level (break, open, absorption zone, trend-line trigger)
        ↓
Expected interaction (volume ↑, volatility ↑, one-sided aggression, follow-through)
        ↓
Actual on footprint (delta, imbalances, absorption, hang-time, two-way trade)
        ↓
Stay / manage / flip / stand down
```

**Core beliefs (playlist-derived):**
1. Footprint shows **executed** bid×ask interaction — not prediction.
2. **Scenarios** (inside day, contraction, open drive) ≠ **strategies**. Strategy = how you execute the interaction at the level.
3. Good breakouts **do not hang** for 15–25 minutes below/above the level with heavy two-way trade.
4. Absorption = aggressive one side + **price not progressing**.
5. Exhaustion ≠ aggressive counterparty; often **drift** after a crescendo (different replay when retested).
6. Iceberg / “elephant” = high volume both sides at same price(s); trade **after** confirmation of what sits behind it — do not invent institutional identity from L2.
7. Risk is defined by **invalidation of the interaction story**, not arbitrary R:R fantasies.
8. News / NFP / fast algo squaring often **excluded** from footprint interpretation.

## 1.2 Chronological playlist inventory (42)

| # | Title | ID | Dur | Depth |
|---|-------|-----|-----|-------|
| 1 | How To Read The Footprint Chart - Advanced Trading Tutorial | `ZCv93eiSvm4` | 16m | **Deep** |
| 2 | How To: Sierra Chart Crash Course 1 - Basic Setup | `TuE-PY68mJg` | 1h3m | Title (platform) |
| 3 | How To Trade Market Imbalances With Perfect Timing | `Arlb6qpvf2g` | 7m53s | **Deep** (desc+summary) |
| 4 | 5 Strategies In 1 Session | `6kvyd8o-beE` | 17m | Title-level |
| 5 | 3 Ways To Confirm Support & Resistance | `PNU_Qd8yfqc` | 16m | Title-level |
| 6 | How To Trade The Delta Reversal Strategy | `lYfUeEX7L3o` | 17m | **Deep** |
| 7 | Amateur Vs Professional Traders | `_Ac-cSYtrQ0` | 18m | Title-level |
| 8 | The Exhaustion Reversal | `0zc2jpsjXNM` | 17m | **Deep** |
| 9 | 5 Principles To Identify Auction And Absorption | `dfz2rvzSpN4` | 16m | Title-level |
| 10 | 3 Differences Between Consolidation & Absorption | `wB6S1K85bsg` | 16m | Title-level |
| 11 | The Open Drive Strategy Explained | `ig0YWwnqQL0` | 13m42s | **Deep** |
| 12 | Failed Breakout vs. Strong Breakout | `Z9uAEUQrerE` | 16m | **Deep** |
| 13 | How To: Sierra Chart Crash Course [PART 2] | `p3scoI4zYvo` | 30m | Title (platform) |
| 14 | How To Identify Absorption | `SvgBq6FEUMU` | 12m18s | **Deep** |
| 15 | 2 Ways To Trade An Iceberg Order | `lSUwCNLQQeU` | 13m | **Deep** |
| 16 | 5 Signs Of A Trend Day - Market Profile & Footprint | `iyougrpThM8` | 16m | Title-level |
| 17 | The Secret Tool Professional Traders Use For Confident Execution | `hYe4BItVTBw` | 14m9s | Title-level |
| 18 | How Joe Uses The Footprint Charts To Confirm The Price Ladder | `CQgKJflv6TQ` | 20m | Title-level |
| 19 | How To Trade Bitcoin With Market Profile & Footprint | `wTOrfKt1xWk` | 10m14s | Title-level |
| 20 | Which Course Should You Take? Profile Vs Footprint | `5shoVj3igCQ` | 5m25s | Title-level |
| 21 | The Key Auction Reversal (V-Reversal) | `-B_jHcaziC4` | 16m | Title-level |
| 22 | The Art of Using the Footprint Trading Tool in Strategy Development | `Rjzr3Ak0T4k` | 9m57s | Title-level |
| 23 | Don't Short Another Market Until You See This | `4UBhRvAFLn8` | 3m46s | Title-level |
| 24 | Executing Using Footprint Chart As Your Guide | `FkS5HX-RonI` | 5m56s | Title-level |
| 25 | 2 Ways A Market High & Low Are Formed | `26CmgVeiAss` | 8m11s | Title-level |
| 26 | How To Identify Absorption Buying in WTI Oil | `hQxmxXfHNdY` | 5m14s | Title-level |
| 27 | How To Trade Against An Institutional Buy-Side Program | `khoJytpFIoc` | 12m50s | Title-level |
| 28 | Why Small Losses Pay For Information (Open Drive & Exhaustion Stops) | `W0Psfegq_Nk` | 16m | Title-level |
| 29 | The Fundamental Reversal Gap Fill Strategy | `nlMtlnW35rw` | 11m34s | Title-level |
| 30 | How To Plan A Breakout | `ZPPEtGOiWec` | 15m | Title-level |
| 31 | The Best Tool For Trading Breakouts | `de8cegn83YE` | 4m42s | Title-level |
| 32 | How To Identify an Absorption Low & What It Means | `qa8uPMvPedU` | 3m44s | Title-level |
| 33 | How To Fade An Aggressive Trend | `gloSEey3hGE` | 12m35s | Title-level |
| 34 | 3 Signs Of A Failed Breakout | `Mco8V8jopKE` | 6m25s | Title-level |
| 35 | 3 Types Of Market Highs And Lows | `_z2-yab-4GI` | 10m57s | Title-level |
| 36 | How To Recognize An Open-Drive And Its Hidden Meaning | `iUk4X-9H2Ic` | 11m9s | Title-level |
| 37 | Big Short Position Revealed in Gold with Footprint & Profile | `FFAAii5Jl9U` | 4m49s | Title-level |
| 38 | Using The Footprint Tool From A Correlated Market | `1f6PSiBSKVE` | 20m | Title-level |
| 39 | The Scene of the Crime News Trade Strategy | `-DbF-1UtpPk` | 10m24s | Title-level |
| 40 | 3 Signs Of A Market In Play | `Kt985pWGZFs` | 12m6s | Title-level |
| 41 | 3 Steps To Trade Fundamental News | `sL1msB6k6zY` | 12m27s | Title-level |
| 42 | GOLD Inside Day Break | `Zw-0ImGVUY0` | 19m | Title-level |

**Deep-studied lessons:** 1, 3, 6, 8, 11, 12, 14, 15 (+ complementary workshops).  
**Title-level:** remaining — concepts inferred only from titles/public summaries; not treated as detailed lesson notes.

## 1.3 Deep lesson extractions concepts

### L1 — How To Read The Footprint (`ZCv93eiSvm4`)
- Build **Actual vs Expected** before the level (e.g. Gold 1221 break).
- Break confirmation: stacked one-sided prints (`42×0`, `80×0`), volume spike, negative delta, wide range.
- Zeros at extremes often = **stops** with no opposing liquidity.
- **Failed-break fingerprint:** after break, huge sell volume for ~15m with **price stuck** → buyers absorbing → hang-time ≠ quality breakout.
- High-volume two-way defense creates **permanent reference levels** (e.g. 1226.9).
- V-reversal: equal-and-opposite aggression + delta flip at high volume.
- Exclude pure news prints from “clean” interpretation.

### L3 — Market Imbalances (`Arlb6qpvf2g`)
- Imbalance = aggressive initiative; often continuation — **but** late-move imbalance can be topping.
- Playbook: (1) go with imbalance → (2) if fails, trade fill-out → (3) if price reclaims through imbalance zone, flip.

### L6 — Delta Reversal (`lYfUeEX7L3o`)
- Draw support from **repeated buyer defense** (≥3 interactions), not pretty trend-line fit.
- **Trigger** requires volume + volatility + price confirmation.
- Stay with break until trigger reclaim; then **delta unwind** (shorts trapped) is the reverse play.
- Stops = interaction invalidation (often a few ticks past aggression base) — not wide discretionary stops.
- Never preempt the unwind; only after reclaim of the trigger.

### L8 — Exhaustion Reversal (`0zc2jpsjXNM`)
- Three reversal classes: **key auction (V)**, **exhaustion**, **absorption** — different retest expectations.
- Exhaustion: crescendo volume after extended move → drift (not aggressive sell) → later needs **new initiative** to break.
- Noise filter: dark high-volume cells at **meaningful prices**, not every print.

### L11 — Open Drive (`ig0YWwnqQL0`)
- Cash open liquidity-taker program; degree of drive = liquidity provision.
- Delta+price displacement distinguishes aggressive vs grinding drive.
- Do not fade open-drive extreme until that extreme is traded out.
- Prior open-drive liquidity zones often flip S↔R next session.

### L12 — Failed vs Strong Breakout (`Z9uAEUQrerE`)
- After multi-week contraction, expect one-sided initiative.
- Failed break: volume surge **with** heavy two-way / absorption at break + multi-hour hang → trap → opposite flush.
- Strong break: light opposing absorption, continuous grind, “calm before storm” absorption then flush.
- Being long the initial break can be correct; the edge is **updating** when Actual ≠ Expected.

### L14 — Identify Absorption (`SvgBq6FEUMU`)
- Pattern awareness (ADR excess → next-day green, mother candles) ≠ automatic trade.
- Absorption: e.g. 4h range, delta −12k, price flat → buyers providing liquidity.
- Zone becomes tradeable when retested with responsive buying **higher** (initiative shift).

### L15 — Iceberg / Elephant (`lSUwCNLQQeU`)
- High volume both sides at same price = passive reload vs aggressive lift.
- Rule 1: don’t fade until you see what’s **behind** the elephant.
- Path A: poke above → reject → scalp with reload.
- Path B: clear second elephant → momentum continuation.
- Random timing; often seen after it starts; ladder traders see earlier.

## 1.4 Cross-lesson relationships

```
Auction context (profile / contraction / inside day / open)
        │
        ├─► Breakout path ── Actual vs Expected ──► Strong | Failed | Hang→Absorb
        │         │                                      │
        │         └─ Trigger (vol+vol+price) ────────────┤
        │                                                ▼
        ├─► Absorption zone ── retest / initiative shift ──► Fade or join
        ├─► Exhaustion high/low ── retest needs new initiative
        ├─► Imbalance stack ── continue / fill / reclaim-flip
        ├─► Iceberg ── wait → secondary elephant → clear → momentum
        └─► Delta unwind ── only after failed trigger reclaim
```

---

# 2. Professional order flow trading guide

**Legend:** **P** = professionally standard microstructure concept · **A** = heavily emphasized in Axia playlist · **G** = already present in Genesis (heuristic or exchange-reported) · **H** = hypothesis until validated on your tape

## 2.1 Concept reference

| Concept | When useful | How to identify | False-signal traps | Genesis today |
|---------|-------------|-----------------|--------------------|---------------|
| DOM / L2 | Timing, spoof caution, visible walls | Synced book imbalance, pull/stack | Spoofing; hidden size | `dom.ts` — L2 metrics; spoof risk **heuristic** |
| Bid/Ask liquidity | Where passive interest rests | Resting size vs trade flow | Walls that vanish | Visible size only |
| Footprint | Interaction at price | Bid×Ask cells per bucket | Low-volume noise | `footprint.ts` exchange aggressor + heuristics |
| Volume delta / CVD | Aggression persistence | Signed aggressor volume; cumulative | News algo noise; crypto maker/taker quirks | `cvd.ts`; session CVD soft-score only (does **not** unlock A+) |
| Bid/Ask imbalances | Initiative bursts | Diagonal/horizontal ratio (often ≥3:1) | Mid-bar noise; wrong aggregation | Imbalance + stacked (≥3, ratio 3) |
| Absorption | Breakout quality, support birth | Aggression without price progress | Quiet consolidation mislabeled | Heuristic absorption flag |
| Exhaustion | End-of-impulse / retest planning | Volume crescendo then decay + finished auction prints | Treating exhaustion alone as reverse | Heuristic exhaustion |
| Aggressive buyers/sellers | Who is initiating | Taker lifts ask / hits bid | Passive fills on opposite | Exchange aggressor flags |
| Stacked imbalances | Continuation / reclaim zones | ≥N consecutive imbalance prices | Using as lone entry | Weight `stackedImbalance: 1` |
| Volume profile | Location (POC/VAH/VAL/LVN) | Session/composite distribution | Trading every LVN touch | `volumeProfile.ts` |
| Liquidity sweeps | Stop runs into value | Pierce swing + reclaim + OF | Every wick as sweep | Zones sweep heuristic |
| Iceberg / hidden | Large passive programs | Reload at price; footprint elephant | Claiming “Goldman” | `icebergRefill.ts` heuristic; veto default **off** |
| Market structure | Regime + stops | Swings, BOS/CHoCH | Structure-only in balance | `structure.ts` + MTF |
| Auction theory | Model selection | Balance vs imbalance | Forcing trend model in balance | `auctionModel.ts` **shadow only** |
| Acceptance / rejection | Break validity | Time+volume at prices outside value | Single print “accept” | Break-retest phases |
| Initiative / responsive | Who controls | Aggression with/against prior auction | Labeling every print | Footprint + commentary |
| Microstructure | Execution quality | Queue, toxicity, latency | Overfitting crypto L2 | Partial |
| Institutional execution | Context only | VWAP/iceberg behavior patterns | Identity claims | **Never claimed** |

## 2.2 Proven vs hypothesis (for automation)

| Claim | Status |
|-------|--------|
| Multi-confirmation OF + location + structure filters noise vs single indicator | **Professionally standard**; Genesis already enforces ≥2 families + A+ |
| Hang-time + two-way trade after break → elevated fail risk | **Playlist-strong + microstructure-plausible**; needs Genesis measurement (**H** until metrics) |
| Absorption → later responsive support | **Standard**; quality depends on retest OF (**H** for auto-entry) |
| Iceberg refill = same institution | **False** — unknowable on crypto L2 |
| Confidence score = P(win) | **False** until Phase 8 calibration sufficient |
| Structure-only backtest = live edge | **False** — labeled proxy in Phase 7/9 |

---

# 3. Practical trading strategies (multi-factor)

All setups require **≥2 independent families**. None are claimed profitable on Genesis data.

## Setup A — Strong breakout continuation (Axia L1/L12 + Genesis break-retest)

1. **Conditions:** Prior balance/contraction; HTF permission; session not pure news spike.  
2. **Entry:** Break of annotated level + acceptance outside value.  
3. **Confirm:** Volume expansion, stacked imbalances with break, delta aligned, **no** multi-bar hang with flat price + opposing absorption; break-retest `accepted` if used.  
4. **Stop:** Beyond opposite side of break candle / failed-accept extreme (+ buffer).  
5. **Targets:** Next opposing HVN/VA / prior balance POC; trail if aggression continues.  
6. **R:R:** ≥1.5 structural (Genesis `minStructuralRR`).  
7. **Invalidate:** Reclaim of break level with opposing aggression; hang-time absorb pattern.  
8. **False signals:** Stop-run spike that snaps back next rotation; low-volume “break.”  
9. **Example shape (playlist):** Gold contraction break that **fails** (absorption at break) vs flush break with light opposing volume — train the engine to score these differently.

## Setup B — Absorption low/high fade / join (Axia L14)

1. **Conditions:** Key level / prior day extreme / ADR excess context.  
2. **Entry:** After absorption print **and** responsive initiative in opposite direction (or higher-low buying).  
3. **Confirm:** Large |delta| with flat price → then equal-opposite / V rotation; location at VP extreme or zone.  
4. **Stop:** Beyond absorption extremes.  
5. **Targets:** Mid-value / POC first; scale if initiative persists.  
6. **R:R:** ≥1.5.  
7. **Invalidate:** Fresh initiative through absorption zone with volume.  
8. **False:** Quiet balance labeled as absorption; news prints.  
9. **Example shape:** WTI multi-hour −12k delta / flat price at 50.70, later retests hold.

## Setup C — Delta unwind / failed trigger (Axia L6)

1. **Conditions:** Clear trigger break (vol+range+price) that later **reclaims**.  
2. **Entry:** Reclaim of trigger with opposing aggression + volume spike (unwind).  
3. **Confirm:** Prior CVD extreme from break side; reclaim bar delta flip; structure CHoCH optional.  
4. **Stop:** Beyond aggression base of reclaim (tight invalidation).  
5. **Targets:** Portion of average range / opposing liquidity; do not assume trend day.  
6. **R:R:** Often smaller absolute targets; require edge via high win-locational precision — **validate**, don’t assume.  
7. **Invalidate:** Loss of reclaim base.  
8. **False:** Preempting unwind while break still holding.  
9. **Example shape:** EUR futures 114 trigger short → reclaim → unwind long.

## Setup D — Exhaustion retest break (Axia L8)

1. **Conditions:** Prior exhaustion high/low mapped; market returns.  
2. **Entry:** Only with **new** initiative holding beyond exhaustion shelf (not auto-fade).  
3. **Confirm:** Volume expansion + acceptance above/below shelf; stacked imbalances.  
4. **Stop:** Back inside exhaustion fill zone.  
5. **Targets:** Next stops / profile targets; if stop-run character, take faster profits.  
6. **R:R:** ≥1.5.  
7. **Invalidate:** Rejection without acceptance.  
8. **False:** Fading every exhaustion as reversal.  

## Setup E — Iceberg clear → momentum (Axia L15) — **manual/semi-auto**

1. **Conditions:** Elephant footprint / refill heuristic at key price.  
2. **Entry:** After second elephant clear + continuation delta — **not** first touch.  
3. **Confirm:** Volume multiple of prior; delta expansion; structure align.  
4. **Stop:** Back into elephant price cluster.  
5. **Targets:** Momentum scale-out.  
6. **R:R:** Case-by-case; often scalp then runner.  
7. **Invalidate:** Persistent reload rejection.  
8. **False:** Labeling every large L2 size as iceberg.  
9. **Automation note:** Genesis iceberg is **heuristic**; keep as warning / shadow until paper stats exist.

## Setup F — Open drive pullback (Axia L11) — **regime-gated**

1. **Conditions:** Cash/session open drive identified (crypto: map to your high-liquidity open if any).  
2. **Entry:** Pullback into open-drive liquidity zone with responsive delta.  
3. **Confirm:** Drive extreme still intact; CVD still drive-aligned.  
4. **Stop:** Beyond drive extreme.  
5. **Targets:** Session continuation; avoid fading.  
6. **False:** Treating every open spike as open drive without volume/delta.

---

# 4. Entry confirmation framework

## 4.1 Professional stack (aligns with Genesis A+)

| Layer | Question | Pass criteria |
|-------|----------|---------------|
| 0 Regime | Balance or imbalance? | Trade model matches (`auctionShadow` observational) |
| 1 HTF | Permission? | ≥2 higher TF agree; no hard conflict |
| 2 Location | Where? | VP extreme/LVN, OB/FVG/sweep, or break-retest band |
| 3 Structure | Why now? | Trend/BOS/CHoCH aligned |
| 4 OF trigger | Who is aggressive? | Stacked imbalance **or** bar delta (session CVD alone ≠ A+ OF) |
| 5 Actual vs Expected | Story holding? | Follow-through; no hang-absorb; no opposing iceberg veto if enabled |
| 6 Risk geometry | Room? | ≥1.5R to opposing structure; not into swing |

**Miss any required A+ layer → WAIT.**

## 4.2 Confidence scoring (current reality)

Genesis confidence = model score (`max(long,short)/confidenceDivisor + bonuses`), **not** calibrated P(win).  
Phase 8: publish only when overall ≥100 resolved, stratum ≥30, calibration ≥40.

**Recommended future confidence inputs (shadow first):**
- Follow-through score (price progress per unit |delta|)
- Hang-time after break
- Absorption conflict flag
- Location quality (distance to LVN/VA)
- Regime match (trend model in imbalance only)

Do **not** unlock weight changes until OOS rules allow.

---

# 5. Signal Engine improvement recommendations

Verified baseline: A+ multi-confirm engine; paper ledger; cost model; tape archive; auction/iceberg **shadow**; Phase 8 lock. See `AUDIT_REPORT.md`.

## 5.1 Evaluation matrix

| Area | Current | Gap vs Axia/pro OF | Recommendation | Auto? |
|------|---------|--------------------|----------------|-------|
| Signal generation | Multi-family scores | Weak **Actual vs Expected** / hang-time | Add shadow features → paper strata → later optional gate | Shadow → then gated |
| Regime | Tags + auction shadow | Shadow doesn’t gate | Promote auction state to **R5 WAIT veto** only after evidence | Later, opt-in |
| Liquidity | Sweeps, DOM large levels | Elephant path incomplete | Footprint elephant detector + iceberg clear state machine | Semi |
| Entry confirm | stacked / bar delta | Missing follow-through ratio | `deltaEfficiency = Δprice / |delta|` | Auto shadow |
| False breakout filter | break-retest failed | Hang-time + two-way absorb underused | `breakQuality` score | Auto shadow |
| Buy/sell pressure | CVD, footprint | CVD soft-only | Keep; add rotation-level CVD slope at triggers | Auto |
| Execution timing | Lifecycle pending confirm | No “wait for reclaim of elephant” | Manual playbook + plugin neutrals | Manual first |
| SL/TP | Structure R:R | Axia invalidation-by-interaction | Optional OF invalidation exits in lifecycle | Semi |
| Risk | Risk engine + costs | Good foundation | Keep; no live size-up | — |
| Confidence | Model score | Uncalibrated | Finish Phase 8 sample; then calibrate | Measurement |

## 5.2 Highest-value features (preserve architecture)

1. **`breakQuality` / hang-time metric** (extends `breakoutRetest.ts`) — expected large accuracy lift on false breakouts.  
2. **`deltaEfficiency` / absorption persistence** — quantifies Axia “volume without price.”  
3. **High/low formation classifier** (exhaustion vs absorption vs V) — stores on signal for regime tables.  
4. **Promote auction shadow → optional WAIT** after claimable strata — do not rewrite `generateSignal` core.  
5. **DOM book archive** — unlocks Phase 9 full parity.  
6. **Footprint elephant state machine** — plugin/neutral first; never hard-label institutions.

## 5.3 Required market data

| Data | Status | Need |
|------|--------|------|
| Aggressor trades | ✅ Exchange-reported | Keep |
| L2 depth | ✅ Live; ❌ not archived | Archive for parity |
| Footprint/CVD/VP from tape | ✅ Replay path | Continue |
| True iceberg IDs | ❌ Impossible | Heuristic only |
| Cash-open drive (futures) | Partial on crypto | Map session opens carefully |
| MBO / order IDs | ❌ Not on these adapters | Out of scope |

## 5.4 What must stay manual / unavailable

- Institutional identity, spoof certainty, “Goldman program” narratives  
- Discretionary Actual vs Expected storytelling on novel news  
- Iceberg first-touch fades  
- Any live trading decision before Phase 8 claimable metrics  

---

# 6. Technical implementation roadmap

Preserve monorepo: extend engines + validation; **no rewrite**.

| Priority | Work | Benefit | Complexity | Dependencies | Risks |
|----------|------|---------|------------|--------------|-------|
| P0 | Finish Phase 8 sample (≥100 resolved) | Know if edge exists | Ops | PAPER uptime, focus rotation | Premature weight edits |
| P0 | Document Axia→feature map (this file) | Shared language | Low | — | Over-fitting stories |
| P1 | Shadow `breakQuality`, `deltaEfficiency`, high/low class | Measure Axia hypotheses | Med | footprint history buffer | Feature leak into scores if mis-wired |
| P1 | Paper strata by new tags | Scientific compare | Med | analytics | Thin strata |
| P2 | DOM/book archive + parity | True live/hist parity | High | storage, schema | Cost/perf |
| P2 | Optional auction WAIT (flagged) | Regime filter | Med | Phase 8 unlock process | Rate collapse / sample bias |
| P3 | Elephant state machine (plugin) | Iceberg playbooks | Med | heuristics | False positives |
| P3 | OF-based invalidation exits | Tighter risk | Med | lifecycle | Whipsaw |
| P4 | Weight research under walk-forward | Potential lift | High | OOS discipline | Overfit |
| Gate | LIVE size | Capital | — | Robust metrics | Ruin if early |

**Production-readiness criteria (do not weaken):**
- Phase 8 overall + key strata claimable  
- Net expectancy > 0 after fees/slippage with Wilson CI not covering severe negative (policy choice — define before live)  
- Parity: replay vs live agreement on setup IDs for tape-capable features  
- Kill-switch, risk caps, PAPER default intact  
- No institutional-identity claims in UI  

---

# 7. Backtesting & validation framework

Use existing Phase 7–9 plumbing; extend, don’t replace.

## 7.1 Scientific protocol

1. **Freeze** config fingerprint (`VALIDATION_LOCK_CONFIG`).  
2. **Forward paper** = primary truth for full OF path.  
3. **Tape replay** = secondary for footprint/CVD/VP (+ structure); label DOM-missing.  
4. **Structure-only candle backtest** = proxy only — never claim full-engine edge.  
5. **Walk-forward:** time-ordered folds; tune only on train; report test once.  
6. **OOS holdout** never used for selection.  
7. **Costs:** default 4 bps RT + 1 bps/side slippage (adjust per venue).  

## 7.2 Metrics (already largely implemented)

Win rate (HIT_TP/(HIT_TP+HIT_SL)), Wilson 95% CI, profit factor, expectancy (net), max DD, avg R, false-positive rate (INVALIDATED/TIMEOUT/EXPIRED), byRegime / bySetupClass, calibration (Brier/log-loss), MFE/MAE.

## 7.3 Hypothesis tests (Axia-inspired)

| Hypothesis | Metric | Pass idea (example — set before looking) |
|------------|--------|------------------------------------------|
| Hang-time breaks underperform | Expectancy by `breakQuality` quartile | Top quartile expectancy > bottom; n≥30 each |
| Absorption-at-break raises fail rate | Fail rate vs no-absorption | Significant lift in fail rate |
| Exhaustion-only fades underperform | Setup class expectancy | ≤0 or worse than baseline |
| A+ vs standard | Expectancy / FP rate | A+ better net after costs |

**Never claim profitability without claimable n and costs.**

## 7.4 Overfit / look-ahead controls

- No future candles in features  
- Same-bar TP/SL: SL-first policy  
- No tuning on final fold  
- Shadow features cannot change scores until unlocked research phase  
- Version every change (`SIGNAL_ENGINE_VERSION` + fingerprint)  

---

# 8. Knowledge gaps & further learning

## 8.1 Playlist gaps (title-level — study next)

Prioritize deep study of:  
`6kvyd8o-beE` (5 strategies), `PNU_Qd8yfqc` (S/R confirm), `dfz2rvzSpN4` / `wB6S1K85bsg` (auction vs consolidation), `-B_jHcaziC4` (V-reversal), `Mco8V8jopKE` / `ZPPEtGOiWec` (breakouts), `_z2-yab-4GI` (3 highs/lows), `1f6PSiBSKVE` (correlated markets), `wTOrfKt1xWk` (BTC profile+footprint).

Sierra Chart parts (2, 13) are platform — skip for methodology unless you use SC.

## 8.2 Professional extras beyond playlist

- Auction Market Theory texts (Dalton et al.) for balance/imbalance rigor  
- Exchange-specific aggressor quirks (crypto perpetual funding, maker/taker)  
- Queue position / latency (only if colocating — not v1)  
- Statistical execution (Almgren–Chriss) for live sizing later  

## 8.3 Genesis-specific gaps

- Accuracy still **undefined** (Phase 8 pending)  
- No DOM archive  
- Auction model observational only  
- Open-drive poorly defined on 24/7 crypto vs RTH futures  
- Confidence ≠ probability  

---

# Final verdict for your goal

You already have a **measurement-first, multi-confirmation OF Signal Engine** in PAPER with the right safety philosophy. Axia’s edge is less “secret indicator” and more **discipline: location → trigger → Actual vs Expected → invalidate fast**.

**Next actions that maximize reliability:**
1. Keep PAPER running until Phase 8 gates claim.  
2. Implement **shadow** break-quality / delta-efficiency / high-low class — no score mutation.  
3. Stratify paper results by those tags.  
4. Only then consider optional WAIT gates / plugins.  
5. Do **not** go live on playlist narratives or uncalibrated confidence.

**Related:** `AUDIT_REPORT.md`, `docs/PHASE8_ACCURACY.md`, `docs/PHASE11_MICROSTRUCTURE.md`, `docs/ARCHITECTURE.md`
