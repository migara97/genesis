import { useEffect, useState } from "react";
import { fetchScanner } from "./api";
import type { ScannerHit, ScannerSnapshot } from "./types";

interface Props {
  selected: string;
  onSelect: (symbol: string) => void;
}

export function ScannerPanel({ selected, onSelect }: Props) {
  const [snap, setSnap] = useState<ScannerSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    const load = () => {
      void fetchScanner()
        .then((page) => {
          if (cancel) return;
          setSnap(page);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!cancel) setError(err instanceof Error ? err.message : "Scanner unavailable");
        });
    };
    load();
    const timer = window.setInterval(load, 20_000);
    return () => {
      cancel = true;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <section className="markets scanner-panel">
      <div className="markets-bar">
        <strong>Alt scanner</strong>
        <span className="muted" style={{ fontSize: 12 }}>
          {snap ? `${snap.hits.length}/${snap.universeSize} ranked` : "loading…"}
        </span>
      </div>
      <p className="disclaimer" style={{ margin: "4px 8px 8px" }}>
        REST compression + RVOL only — attach OF before treating as executable. Rank is not a win rate.
      </p>
      {error && <p className="disclaimer sell">{error}</p>}
      <div className="markets-table-wrap">
        <table className="table markets-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Rank</th>
              <th>RVOL</th>
              <th>Coil</th>
              <th>Regime</th>
              <th>Bias</th>
            </tr>
          </thead>
          <tbody>
            {(snap?.hits ?? []).map((hit) => (
              <tr
                key={hit.symbol}
                className={hit.symbol === selected ? "selected" : undefined}
                onClick={() => onSelect(hit.symbol)}
                style={{ cursor: "pointer" }}
                title={hit.reason}
              >
                <td>{hit.symbol}</td>
                <td>{(hit.rankScore * 100).toFixed(0)}</td>
                <td>{hit.rvol.toFixed(2)}</td>
                <td>{(hit.compression * 100).toFixed(0)}%</td>
                <td>{regimeShort(hit)}</td>
                <td>{hit.bias}</td>
              </tr>
            ))}
            {(snap?.hits ?? []).length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No coiled setups yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function regimeShort(hit: ScannerHit): string {
  switch (hit.regime) {
    case "post_pump_compression":
      return "post-pump";
    case "salvage_after_flush":
      return "salvage";
    case "wedge_reclaim":
      return "wedge";
    default:
      return hit.nearBand ? `near ${hit.nearBand.kind}` : "—";
  }
}
