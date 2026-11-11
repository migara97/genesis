import { useEffect, useRef, useState } from "react";
import { fetchCandles } from "./api";
import type {
  BreakRetestState,
  Candle,
  ChartOverlayState,
  ChartZoneBand,
  ScenarioTreeState,
  StructureTarget,
  TradeScenario,
} from "./types";

const CHART_W = 640;
const CHART_H = 240;
const VOL_H = 22;
const PAD_TOP = 10;
const PAD_RIGHT = 56;

const ACTIVE_SCENARIO_STATUSES = new Set(["open", "armed", "triggered"]);

export function CandleChart({
  symbol,
  interval = "5m",
  overlay,
  breakRetest,
  structureTargets,
  scenarios,
}: {
  symbol: string;
  interval?: string;
  overlay?: ChartOverlayState;
  breakRetest?: BreakRetestState;
  structureTargets?: StructureTarget[];
  scenarios?: ScenarioTreeState;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!symbol) return;
    let cancel = false;
    void fetchCandles(symbol, interval)
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
  }, [symbol, interval]);

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

    // Expand scale so overlay bands / VP lines remain visible.
    for (const band of overlay?.bands ?? []) {
      min = Math.min(min, band.low);
      max = Math.max(max, band.high);
    }
    const activeScenarios = (scenarios?.scenarios ?? []).filter((s) =>
      ACTIVE_SCENARIO_STATUSES.has(s.status),
    );

    for (const level of [
      overlay?.poc,
      overlay?.vah,
      overlay?.val,
      overlay?.lastBos?.price,
      overlay?.lastChoch?.price,
      breakRetest?.bandLow,
      breakRetest?.bandHigh,
      breakRetest?.oppositeLow,
      breakRetest?.oppositeHigh,
      ...(structureTargets ?? []).map((t) => t.price),
      ...activeScenarios.flatMap((s) => [s.triggerPrice, s.invalidation, s.entryLow, s.entryHigh]),
    ]) {
      if (level == null || !Number.isFinite(level)) continue;
      min = Math.min(min, level);
      max = Math.max(max, level);
    }

    const span = max - min || 1;
    const plotW = width - PAD_RIGHT;
    const plotH = height - VOL_H - PAD_TOP;
    const slot = plotW / view.length;

    const yAt = (price: number) => PAD_TOP + ((max - price) / span) * plotH;

    drawBands(ctx, overlay?.bands ?? [], yAt, plotW, plotH, breakRetest?.bandId);
    drawBreakRetest(ctx, breakRetest, yAt, plotW);
    drawScenarioLevels(ctx, activeScenarios, yAt, plotW);
    drawStructureTargets(ctx, structureTargets, yAt, plotW);
    drawLevel(ctx, overlay?.vah, yAt, plotW, "#8b93a7", true, "VAH");
    drawLevel(ctx, overlay?.val, yAt, plotW, "#8b93a7", true, "VAL");
    drawLevel(ctx, overlay?.poc, yAt, plotW, "#d8dde8", false, "POC");
    if (overlay?.lastBos) {
      drawLevel(
        ctx,
        overlay.lastBos.price,
        yAt,
        plotW,
        overlay.lastBos.direction === "bullish" ? "#0ecb81" : "#f6465d",
        true,
        `BOS ${overlay.lastBos.direction === "bullish" ? "↑" : "↓"}`,
      );
    }
    if (overlay?.lastChoch) {
      drawLevel(
        ctx,
        overlay.lastChoch.price,
        yAt,
        plotW,
        "#f0b90b",
        true,
        `CHoCH ${overlay.lastChoch.direction === "bullish" ? "↑" : "↓"}`,
      );
    }

    view.forEach((candle, index) => {
      const x = index * slot + slot / 2;
      const yHigh = yAt(candle.high);
      const yLow = yAt(candle.low);
      const yOpen = yAt(candle.open);
      const yClose = yAt(candle.close);
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
      const volHeight = maxVol ? (candle.volume / maxVol) * VOL_H : 0;
      ctx.globalAlpha = 0.45;
      ctx.fillRect(x - Math.max(slot * 0.3, 1), height - volHeight, Math.max(slot * 0.6, 2), volHeight);
      ctx.globalAlpha = 1;
    });
  }, [candles, overlay, breakRetest, structureTargets, scenarios]);

  const bandCount = overlay?.bands?.length ?? 0;
  const phaseLabel = breakRetestPhaseShort(breakRetest?.phase);
  const structCount = structureTargets?.length ?? 0;
  const scenarioCount = (scenarios?.scenarios ?? []).filter((s) =>
    ACTIVE_SCENARIO_STATUSES.has(s.status),
  ).length;

  return (
    <div>
      <div className="muted" style={{ margin: "8px 0 4px" }}>
        {interval} OHLCV (exchange-reported) · overlays app-derived
        {bandCount > 0 ? ` · ${bandCount} zone${bandCount === 1 ? "" : "s"}` : ""}
        {breakRetest && breakRetest.phase !== "idle" ? ` · playbook ${phaseLabel}` : ""}
        {structCount > 0 ? ` · ${structCount} structure TP` : ""}
        {scenarioCount > 0 ? ` · ${scenarioCount} scenario lvl` : ""}
      </div>
      <canvas ref={canvasRef} className="candle-chart" width={CHART_W} height={CHART_H} />
      {error && <p className="disclaimer">{error}</p>}
      <p className="disclaimer">
        Gray boxes / POC / VAH / VAL are heuristic chart zones. Amber dashes = scenario triggers; red dashes =
        scenario invalidation. Cyan dashes are structure TPs — informational; Risk TP (R) remains the exit path.
      </p>
    </div>
  );
}

function drawScenarioLevels(
  ctx: CanvasRenderingContext2D,
  scenarios: TradeScenario[],
  yAt: (price: number) => number,
  plotW: number,
): void {
  if (!scenarios.length) return;
  const drawn = new Set<string>();
  for (const sc of scenarios) {
    const triggerKey = `t:${sc.triggerPrice.toFixed(8)}`;
    if (!drawn.has(triggerKey)) {
      drawn.add(triggerKey);
      drawDashedPrice(ctx, sc.triggerPrice, yAt, plotW, "rgba(240, 185, 11, 0.95)", `TRIG ${shortScenarioKind(sc.kind)}`);
    }
    const invKey = `i:${sc.invalidation.toFixed(8)}`;
    if (!drawn.has(invKey)) {
      drawn.add(invKey);
      drawDashedPrice(ctx, sc.invalidation, yAt, plotW, "rgba(246, 70, 93, 0.95)", `INV ${shortScenarioKind(sc.kind)}`);
    }
  }
}

function drawDashedPrice(
  ctx: CanvasRenderingContext2D,
  price: number,
  yAt: (price: number) => number,
  plotW: number,
  color: string,
  label: string,
): void {
  if (!Number.isFinite(price)) return;
  const y = yAt(price);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.25;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(plotW, y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(`${label} ${formatPx(price)}`, plotW - 4, y - 3);
  ctx.restore();
}

function shortScenarioKind(kind: TradeScenario["kind"]): string {
  switch (kind) {
    case "break_now_long":
      return "BN↑";
    case "dip_to_demand_long":
      return "DIP↑";
    case "break_now_short":
      return "BN↓";
    case "rally_to_supply_short":
      return "RAL↓";
    default:
      return kind;
  }
}

function drawStructureTargets(
  ctx: CanvasRenderingContext2D,
  targets: StructureTarget[] | undefined,
  yAt: (price: number) => number,
  plotW: number,
): void {
  if (!targets?.length) return;
  for (const t of targets.slice(0, 3)) {
    const y = yAt(t.price);
    ctx.save();
    ctx.strokeStyle = t.hitAt ? "rgba(14, 203, 129, 0.95)" : "rgba(14, 185, 210, 0.9)";
    ctx.lineWidth = 1.25;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "left";
    const tag =
      t.kind === "measured_move"
        ? "MM"
        : t.kind === "prior_swing"
          ? "SW"
          : t.kind === "session_extreme"
            ? "SX"
            : "VP";
    ctx.fillText(`${tag}${t.hitAt ? "✓" : ""} ${formatPx(t.price)}`, 4, y - 3);
    ctx.restore();
  }
}

function drawBands(
  ctx: CanvasRenderingContext2D,
  bands: ChartZoneBand[],
  yAt: (price: number) => number,
  plotW: number,
  _plotH: number,
  activeBandId?: string,
): void {
  for (const band of bands) {
    const yTop = yAt(band.high);
    const yBot = yAt(band.low);
    const h = Math.max(yBot - yTop, 2);
    const active = activeBandId != null && band.id === activeBandId;
    const alpha = (active ? 0.22 : 0.12) + 0.18 * Math.max(0, Math.min(1, band.strength));
    ctx.fillStyle = `rgba(140, 148, 164, ${alpha})`;
    ctx.fillRect(0, yTop, plotW, h);
    ctx.strokeStyle = active
      ? "rgba(240, 185, 11, 0.85)"
      : `rgba(160, 168, 184, ${0.35 + 0.25 * band.strength})`;
    ctx.lineWidth = active ? 2 : 1;
    ctx.strokeRect(0.5, yTop + 0.5, plotW - 1, h - 1);

    ctx.fillStyle = "rgba(200, 206, 218, 0.75)";
    ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "left";
    const label = `${band.kind} · ${shortSource(band.source)}${active ? " · ACTIVE" : ""}`;
    ctx.fillText(label, 4, Math.max(yTop + 11, 12));
  }
}

function drawBreakRetest(
  ctx: CanvasRenderingContext2D,
  breakRetest: BreakRetestState | undefined,
  yAt: (price: number) => number,
  plotW: number,
): void {
  if (!breakRetest || breakRetest.phase === "idle") return;
  if (breakRetest.bandLow == null || breakRetest.bandHigh == null) return;

  const yTop = yAt(breakRetest.bandHigh);
  const yBot = yAt(breakRetest.bandLow);
  const h = Math.max(yBot - yTop, 2);
  const color =
    breakRetest.phase === "accepted"
      ? "rgba(14, 203, 129, 0.9)"
      : breakRetest.phase === "failed" || breakRetest.phase === "invalidated"
        ? "rgba(246, 70, 93, 0.9)"
        : "rgba(240, 185, 11, 0.95)";

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(0.5, yTop + 0.5, plotW - 1, h - 1);
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.font = "bold 11px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "right";
  const tag = `${breakRetestPhaseShort(breakRetest.phase)}${
    breakRetest.side ? ` ${breakRetest.side === "bullish" ? "↑" : "↓"}` : ""
  }`;
  ctx.fillText(tag, plotW - 6, Math.max(yTop + 12, 14));
  ctx.restore();
}

function breakRetestPhaseShort(phase: BreakRetestState["phase"] | undefined): string {
  switch (phase) {
    case "balance":
      return "BAL";
    case "broken":
      return "BRK";
    case "retesting":
      return "RT";
    case "accepted":
      return "ACC";
    case "failed":
      return "FAIL";
    case "invalidated":
      return "INV";
    default:
      return "IDLE";
  }
}

function drawLevel(
  ctx: CanvasRenderingContext2D,
  price: number | undefined,
  yAt: (price: number) => number,
  plotW: number,
  color: string,
  dashed: boolean,
  label: string,
): void {
  if (price == null || !Number.isFinite(price)) return;
  const y = yAt(price);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = dashed ? 1 : 1.5;
  if (dashed) ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(plotW, y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(`${label} ${formatPx(price)}`, plotW + 4, y + 3);
  ctx.restore();
}

function shortSource(source: ChartZoneBand["source"]): string {
  switch (source) {
    case "hvn_cluster":
      return "HVN";
    case "swing_cluster":
      return "swing";
    case "order_block":
      return "OB";
    case "session_extreme":
      return "session";
    default:
      return source;
  }
}

function formatPx(n: number): string {
  if (!Number.isFinite(n)) return "-";
  if (Math.abs(n) >= 1000) return n.toFixed(1);
  if (Math.abs(n) >= 1) return n.toFixed(2);
  if (Math.abs(n) >= 0.01) return n.toFixed(4);
  return n.toPrecision(4);
}
