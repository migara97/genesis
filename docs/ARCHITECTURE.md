# Order Flow Trading Platform — Architecture

## Status of Existing Codebase

The repository was greenfield (`README.md` only). No reusable trading modules existed.
This platform is introduced as a TypeScript monorepo.

## Design Goals

1. Real exchange market data (not simulated tape presented as live).
2. Accurate, testable order-flow calculations separated from UI.
3. Paper trading as the **default** execution mode.
4. Live trading only after explicit user authorization.
5. Clear labeling of **exchange-reported** vs **inferred** analytics.
6. Modular exchange adapters so venues can be added without rewriting engines.

## Monorepo Layout

```
apps/api          Fastify HTTP + WebSocket fan-out, execution, risk, persistence
apps/web          Professional dark trading terminal (React + Vite)
packages/shared   Shared types, DTOs, enums, validation schemas
packages/exchange Exchange adapters (Binance first)
packages/orderflow Pure calculation engines (footprint, CVD, DOM, VP, structure, signals)
```

## Runtime Data Flow

```
Exchange WS ──► ExchangeAdapter ──► MarketDataHub
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                 ▼
              TradeAggregator   OrderBookProcessor  CandleStore
                    │                 │                 │
                    └────────────┬────┴────────────┬────┘
                                 ▼                 ▼
                          OrderFlowEngines   StructureEngine
                                 │                 │
                                 └────────┬────────┘
                                          ▼
                                   SignalEngine
                                          │
                     ┌────────────────────┼────────────────────┐
                     ▼                    ▼                    ▼
                 RiskEngine        ExecutionService        Client WS
                                     (paper|live)
```

## Exchange Integration (v1)

| Capability | OKX Swap (default) | Binance USD-M |
|---|---|---|
| Trades | WS `trades` | WS `aggTrade` |
| Aggressor | `side` taker flag (exchange-reported) | `m` buyer-is-maker flag (exchange-reported) |
| Depth | WS `books5` + REST books | REST snapshot + `depth@100ms` diffs |
| Candles | REST candles | REST klines |
| Account / orders | (paper first; live adapter extensible) | Signed REST live adapter included |

Select with `EXCHANGE=okx|binance`.

**Limitation:** Visible L2 size is not “institutional identity.” Large resting liquidity and spoofing heuristics are **indicators with uncertainty**, never definitive labels.

## Analytical Engines

| Engine | Inputs | Outputs |
|---|---|---|
| Footprint | Aggressor-classified trades + price buckets | Bid×Ask cells, imbalances, absorption/exhaustion heuristics |
| CVD | Signed trade deltas | Session CVD, divergences vs price |
| DOM | Synced order book | Imbalance, pull/stack events, large-liquidity flags |
| Volume Profile | Trades or candle volume | POC, VAH, VAL, HVN/LVN |
| Market Structure | Swing highs/lows from candles/trades | HH/HL/LH/LL, BOS, CHoCH, liquidity pools |
| Signal Engine | All of the above | LONG/SHORT/WAIT with multi-confirmations + invalidation |

Signals require **≥2 independent confirmations**. Single-indicator signals are rejected.

## Execution Modes

1. **ANALYSIS_ONLY** — no orders.
2. **PAPER** (default) — simulated fills against live book/last price.
3. **LIVE** — signed exchange orders; requires `confirmLiveTrading=true` per session.

## Security

- Exchange secrets stored server-side only (encrypted at rest with `ENCRYPTION_KEY`).
- Never logged in plaintext.
- Risk engine blocks orders that violate configured limits before submission.
- Live kill-switch / emergency shutdown endpoint.

## Persistence

SQLite (via `better-sqlite3`) for:
- paper/live fills and orders
- session risk state
- optional historical trade aggregates for replay/backtest

Hot path metrics stay in memory; disk writes are async/batched.

## Testing Strategy

- Unit tests for pure engines (`packages/orderflow`)
- Adapter contract tests with recorded fixtures (no secrets)
- API integration tests for paper execution + risk rejection
- Manual smoke: live Binance public WS → dashboard updates
