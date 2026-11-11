import { useEffect, useState } from "react";
import { fetchMarkets, setFavorite } from "./api";
import type { MarketListing } from "./types";

interface Props {
  selected: string;
  onSelect: (symbol: string) => void;
}

export function Markets({ selected, onSelect }: Props) {
  const [q, setQ] = useState("");
  const [quote, setQuote] = useState("");
  const [status, setStatus] = useState("live");
  const [sort, setSort] = useState("volume");
  const [favorites, setFavorites] = useState(false);
  const [quotes, setQuotes] = useState<string[]>([]);
  const [items, setItems] = useState<MarketListing[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    let timer: number | undefined;
    const load = () => {
      void fetchMarkets({ q, quote, status, sort, favorites })
        .then((page) => {
          if (cancel) return;
          setItems(page.items);
          setTotal(page.total);
          setQuotes(page.quotes);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!cancel) setError(err instanceof Error ? err.message : "Market list failed");
        });
    };
    load();
    // Retry sooner while the catalog is still empty (startup sync race).
    timer = window.setInterval(load, items.length ? 20_000 : 3_000);
    return () => {
      cancel = true;
      if (timer) window.clearInterval(timer);
    };
  }, [q, quote, status, sort, favorites, items.length === 0]);

  const toggleFavorite = async (row: MarketListing) => {
    const next = !row.favorite;
    setItems((prev) => prev.map((item) => (item.symbol === row.symbol ? { ...item, favorite: next } : item)));
    try {
      await setFavorite(row.symbol, next);
    } catch (err) {
      setItems((prev) =>
        prev.map((item) => (item.symbol === row.symbol ? { ...item, favorite: row.favorite } : item)),
      );
      setError(err instanceof Error ? err.message : "Watchlist update failed");
    }
  };

  return (
    <section className="markets">
      <div className="markets-bar">
        <strong>Markets</strong>
        <input
          value={q}
          placeholder="Search symbol"
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search markets"
        />
        <select value={quote} onChange={(e) => setQuote(e.target.value)} aria-label="Quote currency">
          <option value="">All quotes</option>
          {quotes.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Market status">
          <option value="live">Live</option>
          <option value="suspended">Suspended</option>
          <option value="delisted">Delisted</option>
          <option value="">Any status</option>
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort markets">
          <option value="volume">Volume</option>
          <option value="price">Price</option>
          <option value="change">24h change</option>
        </select>
        <label className="check">
          <input
            type="checkbox"
            checked={favorites}
            onChange={(e) => setFavorites(e.target.checked)}
          />
          Favorites
        </label>
        <span className="muted">{total} pairs</span>
      </div>
      <div className="markets-table">
        <table className="table">
          <thead>
            <tr>
              <th></th>
              <th>Pair</th>
              <th>Status</th>
              <th>Price</th>
              <th>24h</th>
              <th>Volume</th>
              <th>Bid</th>
              <th>Ask</th>
              <th>High</th>
              <th>Low</th>
            </tr>
          </thead>
          <tbody>
            {items.map((row) => (
              <tr
                key={row.symbol}
                className={row.symbol === selected ? "selected" : ""}
                onClick={() => onSelect(row.symbol)}
              >
                <td>
                  <button
                    className="star"
                    onClick={(e) => {
                      e.stopPropagation();
                      void toggleFavorite(row);
                    }}
                    aria-label={row.favorite ? "Remove favorite" : "Add favorite"}
                  >
                    {row.favorite ? "★" : "☆"}
                  </button>
                </td>
                <td>
                  <button className="pair" onClick={() => onSelect(row.symbol)}>
                    {row.baseAsset}
                    <span className="muted">/{row.quoteAsset}</span>
                  </button>
                </td>
                <td>{row.status}</td>
                <td>{fmt(row.lastPrice)}</td>
                <td className={(row.changePct24h ?? 0) >= 0 ? "buy" : "sell"}>
                  {row.changePct24h == null ? "-" : `${row.changePct24h.toFixed(2)}%`}
                </td>
                <td>{fmtVol(row.volume24h)}</td>
                <td>{fmt(row.bid)}</td>
                <td>{fmt(row.ask)}</td>
                <td>{fmt(row.high24h)}</td>
                <td>{fmt(row.low24h)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!items.length && (
          <p className="muted">
            {quotes.length
              ? "No pairs match this search."
              : "Synchronizing markets from the connected exchange…"}
          </p>
        )}
        {error && <p className="disclaimer">{error}</p>}
      </div>
      <p className="disclaimer">
        Prices, 24h change, high/low, and bid/ask are exchange-reported. OKX volume is approximate quote notional.
        Market cap is not provided. Order-flow metrics are calculated only for the selected pair.
        The list is this exchange&apos;s derivatives universe, not every coin worldwide.
      </p>
    </section>
  );
}

function fmt(n: number | null): string {
  if (n == null || Number.isNaN(n)) return "-";
  if (Math.abs(n) >= 1000) return n.toFixed(2);
  if (Math.abs(n) >= 1) return n.toFixed(2);
  return n.toPrecision(4);
}

function fmtVol(n: number | null): string {
  if (n == null || Number.isNaN(n)) return "-";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}
