# Market catalog

The terminal lists every derivatives market published by the configured exchange. It does not list every cryptocurrency in the world.

| `EXCHANGE` | Catalog | Live order-flow stream |
|---|---|---|
| `okx` (default) | All OKX perpetual swaps (`instType=SWAP`) | One selected symbol: trades + `books5` |
| `binance` | Binance USD-M `exchangeInfo` symbols | One selected symbol: `aggTrade` + depth |

`DEFAULT_SYMBOLS` is only the pair that starts streaming. Pick any other listed pair in the Markets panel to move the order-flow subscription.

## What is exchange-reported

Ticker last price, 24h change, 24h high/low, and best bid/ask come from the exchange ticker endpoints. Binance volume is the exchange quote volume. OKX swap volume is stored as approximate quote notional: the exchange base-currency volume multiplied by last price.

Candles come from the exchange kline/candle REST API.

Trade aggressor flags on the selected pair come from the exchange trade stream.

## What is calculated

CVD, footprint, volume profile, DOM imbalance, depth chart shape, absorption, and spoofing hints are calculated in this app from the selected pair's trades and visible book. They are not exchange fields.

Market capitalization is not provided by these endpoints and is not shown.

## Sync

- On startup, and every 30 seconds: ticker refresh for the whole catalog.
- On startup, and about every 5 minutes: instrument refresh.
- A symbol that disappears from the exchange list is marked `delisted`.
- `suspend` / non-trading states are stored as `suspended`.
- New symbols are inserted. The unique key is `(exchange, symbol)`.
- Asset rows in `cryptocurrencies` are unique by symbol.
- Order books and the trade tape stay in memory for the focused symbol only.
- `candle_cache` keeps only the latest requested OHLCV window for a pair.

Schema: `apps/api/src/schema.sql` (applied automatically on API startup).

## HTTP

`GET /api/markets?q=&quote=&status=live&sort=volume|price|change&favorites=1&limit=500&offset=0`

`POST /api/watchlist` body `{ "symbol": "SOL-USDT-SWAP", "favorite": true }`

`GET /api/markets/:symbol/candles?interval=15m`

Intervals: `1m`, `3m`, `5m`, `15m`, `1h`, `4h`, `1d`.

## WebSocket

Client message: `{ "type": "subscribe", "symbol": "ETH-USDT-SWAP" }`

The server disconnects the previous order-flow stream and subscribes to that symbol. Delisted symbols are rejected. Ticker rows for the rest of the catalog keep updating over REST.

## Live orders

Live execution still uses the Binance USD-M trading adapter and requires `confirmLiveTrading`. An OKX symbol such as `BTC-USDT-SWAP` is not a Binance order symbol. Use `EXCHANGE=binance` and a Binance symbol such as `BTCUSDT` before placing live orders.

## Run

Restart the API after pulling these changes. The catalog is public market data and does not use the trading API keys.
