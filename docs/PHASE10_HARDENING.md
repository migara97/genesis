# Phase 10 — Hardening (ops + venues)

## Purpose

Make local/staging operation safer and more operable: multi-venue public market data, TLS trust without blanket insecure mode, Prometheus/health signals, and encrypted server-side secrets (never in the frontend).

## Venues

| `EXCHANGE` | Adapter | Symbols |
|------------|---------|---------|
| `okx` (default) | `okx-swap` | `BTC-USDT-SWAP` |
| `binance` | `binance-futures` | `BTCUSDT` |
| `bybit` | `bybit-linear` | `BTCUSDT` |

Factory: `createMarketDataAdapter()` in `@of/exchange`.  
LIVE signed trading remains **Binance-only** in this phase.

## TLS

| Env | Effect |
|-----|--------|
| `NODE_EXTRA_CA_CERTS` | Node built-in extra CA (preferred) |
| `TLS_CA_FILE` | Sets `NODE_EXTRA_CA_CERTS` to that path at boot |
| `TLS_INSECURE=1` | Sets `NODE_TLS_REJECT_UNAUTHORIZED=0` — **dev/MITM only** |

Boot logs TLS mode via `/health.tls`.

## Ops endpoints

| Path | Output |
|------|--------|
| `GET /health` | WS lag, catalog sync age/error, tape count, TLS mode |
| `GET /metrics` | Prometheus text (`of_ws_lag_ms`, `of_catalog_age_ms`, `of_tape_trades`, …) |

## Secrets

AES-256-GCM at rest with `ENCRYPTION_KEY` (SHA-256 derived key).

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/secrets` | Masked list only |
| PUT | `/api/secrets/:name` | Store ciphertext |
| POST | `/api/secrets/rotate` | Re-encrypt with body `oldEncryptionKey` |

Allowed names: `BINANCE_API_KEY`, `BINANCE_API_SECRET`, `BYBIT_API_KEY`, `BYBIT_API_SECRET`.  
LIVE resolves Binance creds from DB first, then env fallback.

## UI

Topbar **Settings**: health snapshot, masked secrets, save/rotate. Exchange switch is server `.env` + restart.

## One-command local

```powershell
cd "D:\My Project\genesis"
# Optional corporate CA:
# $env:TLS_CA_FILE="C:\path\to\corp-root.pem"
# Avoid TLS_INSECURE unless MITM forces it.
npm run build -w @of/shared -w @of/orderflow -w @of/exchange
npm run dev
```

- UI: http://localhost:5173  
- Health: http://localhost:8080/health  
- Metrics: http://localhost:8080/metrics  

## Non-goals

- Bybit LIVE trading adapter  
- Frontend plaintext API keys  
- Defaulting `TLS_INSECURE` on  

## Related

- [PHASE9_PARITY.md](./PHASE9_PARITY.md)  
- `packages/exchange/src/bybit/linearMarketData.ts`  
- `apps/api/src/secrets/store.ts`  
- `apps/api/src/ops/status.ts`
