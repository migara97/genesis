# Phase 12 — Product & Execution Maturity

## Purpose

Ship execution/product maturity on top of Phases 7–11 plumbing: **TP2/TP3 paper scale-out**, **sizing profiles**, **favorites alerts**, and a **LIVE submit audit** — without unlocking Phase 8 weight edits.

Engine label: `0.14.0-phase12` (fingerprint includes default scale-out config).

## Scale-out (paper / tick lifecycle)

| Setting | Default |
|---------|---------|
| Fractions | 50% TP1 / 30% TP2 / 20% TP3 |
| Behavior | Stay `ACTIVE` after partial TPs; `HIT_TP` when remainder ≈ 0 |
| Legacy | `scaleOut.fullCloseAtTp1: true` → 100% close at TP1 |

- State on signal: `tpHits`, `scaleRemainingFrac`
- Paper ledger: `remaining_frac`, `scale_fills` JSON; accumulates `computeCostedPnl({ sizeFraction })`
- Bar `resolvePathExit` remains **TP1-only** (same-bar validation unchanged)

## Sizing profiles

| Profile | Risk % | Min entry grade |
|---------|--------|-----------------|
| conservative | 0.25 | A+ |
| standard | 0.50 | STANDARD |
| aggressive | 1.00 | STANDARD |

`PUT /api/risk` with `sizingProfile` applies mapped `%` + `minEntryGrade`. Execution passes `snap.signal.entryGrade` and first TP into `validateOrderRisk`.

## Alerts (favorites-gated)

- Tables: `alerts`, `alert_fires`
- `GET/POST /api/alerts`, `DELETE /api/alerts/:id`, `GET /api/alerts?fired=1`
- Evaluator runs on focused symbol ticks (5s throttle); **only fires if symbol is favorited**
- Kinds: `price` (op + threshold) · `signal` (lifecycle match)
- WS message `type: "alert"`

## LIVE audit

- Table: `live_audit` — place / cancel / mode / reject
- **No API keys or secrets** (reasons sanitized)
- `GET /api/live-audit`

## Markets mobile

At ≤800px: wrap toolbar, hide Bid/Ask/High/Low, give markets strip usable height.

## Non-goals

- LIVE position size increases beyond risk engine
- Multi-TP bar pathExit
- Claiming alert delivery as push notifications
- Unlocking Phase 8 confirmation weights

## Related

- [PHASE11_MICROSTRUCTURE.md](./PHASE11_MICROSTRUCTURE.md)
- `packages/orderflow/src/signalLifecycle.ts`
- `packages/orderflow/src/risk.ts`
- `apps/api/src/validation/paperLedger.ts`
- `apps/api/src/alerts/store.ts`
- `apps/api/src/execution/liveAudit.ts`
