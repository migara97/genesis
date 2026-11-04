# Development Roadmap

## Phase 0 — Foundation (this PR)
- [x] Architecture + data limitation docs
- [x] Monorepo scaffold (api, web, shared, exchange, orderflow)
- [x] Binance public market-data adapter (trades + depth + klines)
- [x] Footprint, CVD, DOM metrics, volume profile, structure engines
- [x] Rule-based multi-confirmation signal engine
- [x] Risk engine + paper execution (default)
- [x] Live execution module gated behind explicit confirmation
- [x] Professional dark trading dashboard
- [x] Unit tests for core calculations

## Phase 1 — Hardening
- [ ] Additional venues (Bybit, OKX) behind same adapter interface
- [ ] Historical reconciliation + trade replay UI
- [ ] Expanded backtester with fees/slippage models
- [ ] Encrypted secret store UI + key rotation
- [ ] Prometheus metrics / structured ops dashboards

## Phase 2 — Advanced Microstructure
- [ ] Iceberg / refill heuristics with confidence bands
- [ ] Multi-symbol correlation / leader-lagger
- [ ] Optional AI commentary module (separate from rule engine)
- [ ] Strategy plugins API

## Explicit Non-Goals for v1
- Claiming detection of specific institutions
- Auto-live trading without user confirmation
- Presenting mock tape as live exchange data
