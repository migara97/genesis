import { useEffect, useRef, useState } from "react";
import { fetchCandles } from "./api";
import type { Candle } from "./types";

export function CandleChart({ symbol }: { symbol: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!symbol) return;
    let cancel = false;
    void fetchCandles(symbol, "15m")
      .then((page) => {
        if (!cancel) {
          setCandles(page.candles);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancel) setError(err instanceof Error ? err.message : "Candles unavailable");
      });
    return () => {
      cancel = true;
    };
  }, [symbol]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);
    const view = candles.slice(-80);
    if (view.length < 2) return;
    let min = Infinity;
    let max = -Infinity;
    let maxVol = 0;
    for (const candle of view) {
      min = Math.min(min, candle.low);
      max = Math.max(max, candle.high);
      maxVol = Math.max(maxVol, candle.volume);
    }
    const span = max - min || 1;
    const slot = width / view.length;
    view.forEach((candle, index) => {
      const x = index * slot + slot / 2;
      const yHigh = ((max - candle.high) / span) * (height - 28);
      const yLow = ((max - candle.low) / span) * (height - 28);
      const yOpen = ((max - candle.open) / span) * (height - 28);
      const yClose = ((max - candle.close) / span) * (height - 28);
      const up = candle.close >= candle.open;
      ctx.strokeStyle = up ? "#0ecb81" : "#f6465d";
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.moveTo(x, yHigh);
      ctx.lineTo(x, yLow);
      ctx.stroke();
      const top = Math.min(yOpen, yClose);
      const body = Math.max(Math.abs(yClose - yOpen), 1);
      ctx.fillRect(x - Math.max(slot * 0.3, 1), top, Math.max(slot * 0.6, 2), body);
      const volHeight = maxVol ? (candle.volume / maxVol) * 22 : 0;
      ctx.globalAlpha = 0.45;
      ctx.fillRect(x - Math.max(slot * 0.3, 1), height - volHeight, Math.max(slot * 0.6, 2), volHeight);
      ctx.globalAlpha = 1;
    });
  }, [candles]);

  return (
    <div>
      <div className="muted" style={{ margin: "8px 0 4px" }}>
        15m OHLCV (exchange-reported)
      </div>
      <canvas ref={canvasRef} className="candle-chart" width={640} height={160} />
      {error && <p className="disclaimer">{error}</p>}
    </div>
  );
}
