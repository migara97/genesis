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

## Phase 8 — Prove accuracy (in progress)
- [x] Config fingerprint lock (`VALIDATION_LOCK_CONFIG`) + version-split report
- [x] Sample gates (overall ≥100, stratum ≥30, calibration ≥40)
- [x] Focus rotation across `DEFAULT_SYMBOLS` (`FOCUS_ROTATION_MS`)
- [x] Validation UI banners + byRegime / bySetupClass claimable tables
- [x] `docs/PHASE8_ACCURACY.md`
- [ ] Collect ≥100 resolved TP/SL under locked fingerprint (ops — leave PAPER running)
- [ ] Publish CI / expectancy in PHASE8 results table when claimable

## Phase 9 — Live / historical parity
- [x] Tape load + OF replay (`footprint`/`CVD`/`VP` + structure/MTF/zones)
- [x] Live paper vs replay compare (`setupId` / time-side)
- [x] `GET /api/validation/parity?run=1` runner; structure backtest stays proxy
- [x] Validation UI Phase 9 panel
- [x] `docs/PHASE9_PARITY.md` + unit tests
- [ ] DOM/book archive for full-engine parity (future)

## Phase 10 — Hardening
- [x] Bybit linear public MD adapter + shared `createMarketDataAdapter`
- [x] TLS_CA_FILE / NODE_EXTRA_CA_CERTS + optional TLS_INSECURE (documented)
- [x] Rich `/health` + Prometheus `/metrics`
- [x] Encrypted secrets store API + Settings UI (masked)
- [x] `docs/PHASE10_HARDENING.md`
- [ ] Bybit LIVE trading adapter (future)
- [ ] Historical reconciliation UI polish (future)

## Phase 1 — Hardening (legacy checklist; largely covered by Phase 10)
- [x] Additional venues (Bybit, OKX) behind same adapter interface
- [ ] Historical reconciliation + trade replay UI
- [ ] Expanded backtester with fees/slippage models
- [x] Encrypted secret store UI + key rotation
- [x] Prometheus metrics / structured ops dashboards

## Phase 11 — Advanced microstructure
- [x] Iceberg / refill heuristics with confidence bands
- [x] Catalog cross-section leader/lagger (not multi-OF WS)
- [x] Template commentary module (never mutates scores)
- [x] Strategy plugins API (weight-0 packs; default off)
- [x] `GET /api/microstructure` + DOM/UI chips
- [x] `docs/PHASE11_MICROSTRUCTURE.md` + unit tests

## Phase 2 — Advanced Microstructure (legacy; covered by Phase 11)
- [x] Iceberg / refill heuristics with confidence bands
- [x] Multi-symbol correlation / leader-lagger
- [x] Optional AI commentary module (separate from rule engine)
- [x] Strategy plugins API

## Explicit Non-Goals for v1
- Claiming detection of specific institutions
- Auto-live trading without user confirmation
- Presenting mock tape as live exchange data
