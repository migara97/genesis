# Phase 7 — Accuracy Validation & Forward Paper Trading

## Purpose

Measure the **actual** predictive and trading performance of the existing Signal Engine.  
This layer does **not** change `generateSignal` confirmation gates or indicator math.  
It does **not** invent win rates. Confidence remains a model score until calibration is statistically sufficient.

## Audit summary (existing system)

| Area | Finding |
|------|---------|
| Live path | Full OF + MTF + zones → lifecycle → journal |
| Historical `/api/backtest` | Structure/MTF only, `structureOnlyMode` relaxes gates — **not live parity** |
| Journal PnL | Gross price units; no fees/funding |
| Tape persistence | Previously none (memory only) |
| TIMEOUT | Added in Phase 7 for age/max-hold; EXPIRED retained for compatibility |
| Same-bar TP+SL | Live: tick SL-before-TP; OHLC helper: conservative `sl_first` |
| TP2/TP3 | Informational; paper ledger closes 100% at TP1 |

Full gap analysis: live vs historical inputs, missing costs, missing versions — addressed by the measurement modules below.

## Architecture (measurement layer)

```
marketHub (unchanged gates)
  ├─ archiveTradeTick → trade_tape (append-only)
  ├─ recordSignalLifecycle → signal_setups (legacy journal)
  └─ syncPaperTradeFromLifecycle → paper_trades (forward paper ledger)

GET /api/validation/report → performance + calibration + regime + parity notes
GET /api/validation/paper-trades
GET /api/validation/parity
```

## Forward paper fields

Each `paper_trades` row freezes: setup/signal ids, exchange, futures_perp, pair, direction, timestamps, 15m primary TF, entry/SL/TPs, confidence, scores, families, confirmations, OF snapshot, regime tags, `engine_version` (`0.7.0-phase7`), `config_version` (SHA of default configs).

Outcomes: `OPEN` | `HIT_TP` | `HIT_SL` | `INVALIDATED` | `EXPIRED` | `TIMEOUT`.  
Open trades are **never** counted as wins or losses.

## Costs

Default: fee 4 bps round-trip notionals, 1 bps slippage/side, funding rate 0 (configurable in cost model).  
Net PnL, R-multiple, fees, funding stored on close.

## Performance metrics

Resolved sample = HIT_TP + HIT_SL only for win rate.  
Also reported: gross/net profit, profit factor, expectancy, max DD, avg hold, MFE/MAE, false-positive rate (invalidated/timeout among non-open), Wilson 95% CI on win rate.

## Calibration

Buckets by confidence; Brier score; log loss.  
`sufficient: false` until enough resolved trades — **do not publish calibrated probabilities early**.

## Historical / live parity

- Default candle backtest remains a **labeled proxy** (`structureOnlyMode`).
- `trade_tape` capture enables future full-OF replay; until tape exists, parity endpoint states the limitation explicitly.
- Never claim complete-engine edge from structure-only replay.

## Walk-forward / OOS

Use time-ordered splits on archived tape + candles when available. Do not tune gates on the final test fold.  
Current deliverable provides the measurement plumbing and reports; do not optimize signal weights in this phase.

## Deploy / run

1. `npm run dev` (schema auto-migrates CREATE IF NOT EXISTS).
2. Leave PAPER mode streaming — tape + paper ledger fill automatically.
3. Open Signal Engine → **Validation** section, or `GET /api/validation/report?symbol=BTCUSDT`.
4. Treat empty/small samples as **undefined accuracy**, not 0% or 100% edge.

## Tests

- `@of/orderflow` validation unit tests: Wilson CI, unresolved exclusion, cost/slippage, same-bar `sl_first`.
- Lifecycle age expiry now emits `TIMEOUT`.
