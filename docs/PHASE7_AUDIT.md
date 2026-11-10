# Phase 7 — Existing Engine Audit (read-only findings)

## Architecture

Live: Exchange WS → `marketHub` → footprint/CVD/DOM/VP/structure/MTF/zones → `generateSignal` → `applySignalLifecycle` → journal + **paper ledger** + **trade_tape**.

Historical default: REST klines → `backtestSignalEngine` with **structure + MTF only** and relaxed gates (`structureOnlyMode`).

## Confirmed gaps (pre-Phase-7)

1. No durable trade tape → cannot claim full-OF historical parity.
2. Journal PnL was gross; no fees/slippage/funding.
3. No engine/config version on setups.
4. No TIMEOUT distinct from EXPIRED.
5. Backtest outcome label `TIME` vs lifecycle `EXPIRED` mismatch.
6. Confidence not calibrated; UI risk of misreading as win probability.
7. Same-bar OHLC policy undocumented for validation.
8. TP2/TP3 unused for scale-out.

## What Phase 7 measurement layer adds (without changing gates)

- `paper_trades` forward ledger with versions, OF snapshot, costs, MFE/MAE.
- `trade_tape` append-only archive while streaming.
- Validation report: performance, Wilson CI, calibration, regime split, parity notes.
- TIMEOUT lifecycle for age/max-hold.
- Explicit documentation that structure-only backtest is a **proxy**.

## Non-goals of this phase

- Do not retune weights to raise dashboard win rate.
- Do not execute real-money trades.
- Do not silently substitute structure-only results for full-engine claims.
