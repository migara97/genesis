export type InstrumentStatus = "live" | "suspended" | "delisted";

export interface DiscoveredInstrument {
  exchange: string;
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: InstrumentStatus;
  tickSize: number;
  lotSize: number;
  contractType: string;
}

export interface DiscoveredTicker {
  symbol: string;
  lastPrice: number;
  change24h: number;
  changePct24h: number;
  volume24h: number;
  high24h: number;
  low24h: number;
  bid: number;
  ask: number;
}

interface OkxInstrument {
  instId?: string;
  instType?: string;
  state?: string;
  settleCcy?: string;
  ctValCcy?: string;
  tickSz?: string;
  lotSz?: string;
}

interface OkxTicker {
  instId?: string;
  last?: string;
  open24h?: string;
  high24h?: string;
  low24h?: string;
  volCcy24h?: string;
  bidPx?: string;
  askPx?: string;
}

interface BinanceSymbol {
  symbol?: string;
  pair?: string;
  baseAsset?: string;
  quoteAsset?: string;
  status?: string;
  contractType?: string;
  filters?: { filterType?: string; tickSize?: string; stepSize?: string }[];
}

interface BinanceTicker {
  symbol?: string;
  lastPrice?: string;
  priceChange?: string;
  priceChangePercent?: string;
  quoteVolume?: string;
  highPrice?: string;
  lowPrice?: string;
}

interface BinanceBook {
  symbol?: string;
  bidPrice?: string;
  askPrice?: string;
}

export function planInstrumentSync(
  existing: { symbol: string; status: string }[],
  incoming: { symbol: string }[],
): { added: string[]; delisted: string[] } {
  const known = new Set(existing.map((row) => row.symbol));
  const next = new Set(incoming.map((row) => row.symbol));
  const added = incoming.filter((row) => !known.has(row.symbol)).map((row) => row.symbol);
  const delisted = existing
    .filter((row) => row.status !== "delisted" && !next.has(row.symbol))
    .map((row) => row.symbol);
  return { added, delisted };
}

export function parseOkxInstruments(
  rows: OkxInstrument[],
  exchange = "okx",
): DiscoveredInstrument[] {
  const out: DiscoveredInstrument[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const symbol = (row.instId ?? "").toUpperCase();
    const parts = symbol.split("-");
    if (parts.length < 3 || parts[parts.length - 1] !== "SWAP") continue;
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    const baseAsset = (parts[0] || row.ctValCcy || "").toUpperCase();
    const quoteAsset = (parts[1] || row.settleCcy || "").toUpperCase();
    if (!baseAsset || !quoteAsset) continue;
    out.push({
      exchange,
      symbol,
      baseAsset,
      quoteAsset,
      status: mapOkxState(row.state),
      tickSize: positive(row.tickSz, 0.01),
      lotSize: positive(row.lotSz, 1),
      contractType: "SWAP",
    });
  }
  return out;
}

export function parseOkxTickers(rows: OkxTicker[]): DiscoveredTicker[] {
  const out: DiscoveredTicker[] = [];
  for (const row of rows) {
    const symbol = (row.instId ?? "").toUpperCase();
    if (!symbol.endsWith("-SWAP")) continue;
    const last = Number(row.last);
    const open = Number(row.open24h);
    if (!Number.isFinite(last)) continue;
    const change = Number.isFinite(open) ? last - open : 0;
    const changePct = open ? (change / open) * 100 : 0;
    // OKX reports swap volCcy24h in the base currency. Scale by last price so
    // the catalog can sort pairs by approximate quote notional.
    const baseVolume = finite(row.volCcy24h);
    out.push({
      symbol,
      lastPrice: last,
      change24h: change,
      changePct24h: changePct,
      volume24h: last > 0 ? baseVolume * last : baseVolume,
      high24h: finite(row.high24h),
      low24h: finite(row.low24h),
      bid: finite(row.bidPx),
      ask: finite(row.askPx),
    });
  }
  return out;
}

export function parseBinanceInstruments(
  rows: BinanceSymbol[],
  exchange = "binance",
): DiscoveredInstrument[] {
  const out: DiscoveredInstrument[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const symbol = (row.symbol ?? "").toUpperCase();
    const baseAsset = (row.baseAsset ?? "").toUpperCase();
    const quoteAsset = (row.quoteAsset ?? "").toUpperCase();
    if (!symbol || !baseAsset || !quoteAsset || seen.has(symbol)) continue;
    seen.add(symbol);
    const priceFilter = row.filters?.find((f) => f.filterType === "PRICE_FILTER");
    const lotFilter = row.filters?.find((f) => f.filterType === "LOT_SIZE");
    out.push({
      exchange,
      symbol,
      baseAsset,
      quoteAsset,
      status: mapBinanceStatus(row.status),
      tickSize: positive(priceFilter?.tickSize, 0.01),
      lotSize: positive(lotFilter?.stepSize, 0.001),
      contractType: (row.contractType || "PERPETUAL").toUpperCase(),
    });
  }
  return out;
}

export function parseBinanceTickers(
  rows: BinanceTicker[],
  books: BinanceBook[] = [],
): DiscoveredTicker[] {
  const bookBySymbol = new Map<string, BinanceBook>();
  for (const book of books) {
    if (book.symbol) bookBySymbol.set(book.symbol.toUpperCase(), book);
  }
  const out: DiscoveredTicker[] = [];
  for (const row of rows) {
    const symbol = (row.symbol ?? "").toUpperCase();
    const last = Number(row.lastPrice);
    if (!symbol || !Number.isFinite(last)) continue;
    const book = bookBySymbol.get(symbol);
    out.push({
      symbol,
      lastPrice: last,
      change24h: finite(row.priceChange),
      changePct24h: finite(row.priceChangePercent),
      volume24h: finite(row.quoteVolume),
      high24h: finite(row.highPrice),
      low24h: finite(row.lowPrice),
      bid: finite(book?.bidPrice),
      ask: finite(book?.askPrice),
    });
  }
  return out;
}

export async function discoverMarkets(
  exchange: "okx" | "binance",
  fetchImpl: typeof fetch = fetch,
): Promise<{ instruments: DiscoveredInstrument[]; tickers: DiscoveredTicker[] }> {
  if (exchange === "binance") return discoverBinance(fetchImpl);
  return discoverOkx(fetchImpl);
}

async function discoverOkx(fetchImpl: typeof fetch) {
  const [instrumentsJson, tickersJson] = await Promise.all([
    getJson(fetchImpl, "https://www.okx.com/api/v5/public/instruments?instType=SWAP"),
    getJson(fetchImpl, "https://www.okx.com/api/v5/market/tickers?instType=SWAP"),
  ]);
  if (instrumentsJson.code !== "0") {
    throw new Error(`OKX instruments error: ${String(instrumentsJson.msg ?? instrumentsJson.code)}`);
  }
  if (tickersJson.code !== "0") {
    throw new Error(`OKX tickers error: ${String(tickersJson.msg ?? tickersJson.code)}`);
  }
  return {
    instruments: parseOkxInstruments((instrumentsJson.data ?? []) as OkxInstrument[]),
    tickers: parseOkxTickers((tickersJson.data ?? []) as OkxTicker[]),
  };
}

async function discoverBinance(fetchImpl: typeof fetch) {
  const [info, tickers, books] = await Promise.all([
    getJson(fetchImpl, "https://fapi.binance.com/fapi/v1/exchangeInfo"),
    getJson(fetchImpl, "https://fapi.binance.com/fapi/v1/ticker/24hr"),
    getJson(fetchImpl, "https://fapi.binance.com/fapi/v1/ticker/bookTicker"),
  ]);
  return {
    instruments: parseBinanceInstruments((info.symbols ?? []) as BinanceSymbol[]),
    tickers: parseBinanceTickers(
      (Array.isArray(tickers) ? tickers : []) as BinanceTicker[],
      (Array.isArray(books) ? books : []) as BinanceBook[],
    ),
  };
}

async function getJson(fetchImpl: typeof fetch, url: string): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Market request failed ${res.status}: ${url}`);
  return (await res.json()) as Record<string, unknown>;
}

function mapOkxState(state?: string): InstrumentStatus {
  if (state === "live") return "live";
  if (state === "suspend" || state === "preopen") return "suspended";
  return "suspended";
}

function mapBinanceStatus(status?: string): InstrumentStatus {
  if (status === "TRADING") return "live";
  if (status === "CLOSE" || status === "SETTLING") return "delisted";
  return "suspended";
}

function positive(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function finite(value: string | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
