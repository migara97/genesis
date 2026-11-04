# Order Flow Trading Platform

Professional real-time order-flow trading application with:

- Live exchange market data (OKX swap default; Binance USD-M adapter included)
- Footprint, CVD, DOM metrics, volume profile, market structure
- Multi-confirmation rule-based signal engine
- Paper trading (default), analysis-only, and gated live execution
- Risk controls and emergency kill switch
- Institutional-style dark trading terminal

> **Important:** This platform never claims to identify specific institutions. Exchange-reported aggressor flags and visible L2 depth are labeled separately from inferred/heuristic analytics.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/ROADMAP.md](docs/ROADMAP.md).

```
apps/api           Fastify + WebSocket hub, risk, execution, SQLite
apps/web           React trading terminal
packages/shared    Shared types
packages/orderflow Pure calculation engines
packages/exchange  Exchange adapters (Binance first)
```

## Prerequisites

- Node.js **20+** (LTS recommended): https://nodejs.org
- Git
- Internet access (live OKX/Binance market data)
- Windows: if `better-sqlite3` fails to install, install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (Desktop development with C++)

## Quick start (Windows PowerShell)

```powershell
cd "D:\My Project\genesis"
git fetch origin
git checkout development
git pull origin development

npm install
Copy-Item apps\api\.env.example apps\api\.env
npm run build -w @of/shared -w @of/orderflow -w @of/exchange
npm run dev
```

## Quick start (macOS / Linux)

```bash
cd /path/to/genesis
git checkout development
git pull origin development
npm install
cp apps/api/.env.example apps/api/.env
npm run build -w @of/shared -w @of/orderflow -w @of/exchange
npm run dev
```

Then open:

- UI: http://localhost:5173
- API: http://localhost:8080
- Health: http://localhost:8080/health
- Live WS: ws://localhost:8080/ws

Default exchange: `okx` with `BTC-USDT-SWAP` (override with `EXCHANGE` / `DEFAULT_SYMBOLS` in `apps/api/.env`).
Binance public endpoints return HTTP 451 in some regions; use `EXCHANGE=binance` where accessible.

### Run API and UI in separate terminals (optional)

```powershell
# Terminal 1
cd "D:\My Project\genesis"
npm run build -w @of/shared -w @of/orderflow -w @of/exchange
npm run dev:api

# Terminal 2
cd "D:\My Project\genesis"
npm run dev:web
```

## Execution modes

| Mode | Behavior |
|------|----------|
| `ANALYSIS_ONLY` | No orders |
| `PAPER` (default) | Simulated fills against live prices |
| `LIVE` | Real Binance orders; requires `confirmLiveTrading=true` and server env keys |

Never put API secrets in the frontend. Set `BINANCE_API_KEY` / `BINANCE_API_SECRET` only in `apps/api/.env`.

## Tests

```bash
npm test
```

## Data accuracy notes

- Binance `aggTrade.m` provides exchange-reported aggressor side.
- DOM spoofing / absorption / exhaustion flags are **heuristics**.
- Historical backtest endpoint currently lacks stored tape, so order-flow confirmations are limited.
