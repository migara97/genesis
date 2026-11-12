# Phase 9 — Live / Historical Parity

## Purpose

Use archived `trade_tape` as the source of truth for **partial order-flow replay**, compare closes to the live paper ledger, and keep structure-only `/api/backtest` explicitly labeled as a **proxy**.

This phase does **not** retune signal weights and does **not** claim bit-identical full-engine parity (DOM/L2 is not archived).

## What is reconstructed

| Input | Source |
|-------|--------|
| Footprint / CVD / volume profile | `trade_tape` aggressor ticks |
| Structure / MTF / zones / break-retest | Candle series sliced to each tick time |
| Lifecycle TP/SL | Tick `lastPrice`, SL-before-TP (live policy) |
| DOM / L2 | **Missing** — never reconstructed |

Live gates (`DEFAULT_SIGNAL_CONFIG`, including A+) are used — **not** `structureOnlyMode`.

## APIs

| Endpoint | Behavior |
|----------|----------|
| `GET /api/validation/parity` | Status + tape coverage; `green` when tape count &gt; 0 |
| `GET /api/validation/parity?run=1` | Load tape → OF replay → compare to `paper_trades` |
| `GET /api/backtest/:symbol` | Structure/MTF proxy only (unchanged; labeled) |

Query: `symbol`, `from`, `to`, `maxTicks` (cap 200k load / default 50k run).

## Parity statuses

| Status | Meaning |
|--------|---------|
| `no_tape` | Nothing archived — leave PAPER streaming |
| `ready_partial_of` | Tape present; replay available (DOM still absent) |
| `ready_with_overlap` | Replay ran with live paper overlap in the window |

`green: true` when tape exists (Phase 9 exit for taped symbols).  
`fullEngineParity: false` always until book archive exists.

## Compare rules

1. Prefer exact `setupId` match  
2. Else same side within 15m open time and 0.25% entry band  
3. Report direction/outcome agree rates; unmatched live/replay counts  

## UI

Signal Engine → **Phase 9 — Tape OF parity** → **Run tape OF replay**.

## How to collect tape

1. `EXECUTION_MODE=PAPER`  
2. Stream symbols (focus rotation helps)  
3. `archiveTradeTick` fills SQLite on every focused trade  
4. Re-run parity with `run=1`

## Non-goals

- Book / DOM archive  
- Weight unlock or optimization  
- Treating structure-only backtest as full-engine edge  

## Related

- [PHASE8_ACCURACY.md](./PHASE8_ACCURACY.md) — sample gates / config lock  
- [PHASE7_VALIDATION.md](./PHASE7_VALIDATION.md) — paper ledger + tape capture  
- `packages/orderflow/src/tapeReplay.ts`  
- `packages/orderflow/src/validation/parity.ts`  
- `apps/api/src/validation/parityRunner.ts`
