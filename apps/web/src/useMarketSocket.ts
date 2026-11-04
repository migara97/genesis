import { useEffect, useRef, useState } from "react";
import type { ConnectionHealth, MarketSnapshot } from "./types";

function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws`;
}

export function useMarketSocket() {
  const [snapshots, setSnapshots] = useState<Record<string, MarketSnapshot>>({});
  const [health, setHealth] = useState<ConnectionHealth | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retryRef = useRef(0);
  const wsRef = useRef<WebSocket | null>(null);
  const symbolRef = useRef<string | null>(null);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let timer: number | undefined;

    const connect = () => {
      ws = new WebSocket(wsUrl());
      wsRef.current = ws;
      ws.onopen = () => {
        setConnected(true);
        setError(null);
        retryRef.current = 0;
        if (symbolRef.current) {
          ws?.send(JSON.stringify({ type: "subscribe", symbol: symbolRef.current }));
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        const delay = Math.min(10_000, 1000 * 2 ** retryRef.current);
        retryRef.current += 1;
        timer = window.setTimeout(connect, delay);
      };
      ws.onerror = () => setError("WebSocket error");
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as {
            type: string;
            payload: unknown;
          };
          if (msg.type === "hello") {
            const payload = msg.payload as {
              snapshots: MarketSnapshot[];
            };
            const map: Record<string, MarketSnapshot> = {};
            for (const s of payload.snapshots ?? []) map[s.symbol] = s;
            setSnapshots(map);
          } else if (msg.type === "snapshot") {
            const snap = msg.payload as MarketSnapshot;
            setSnapshots({ [snap.symbol]: snap });
            setHealth(snap.health);
          } else if (msg.type === "health") {
            setHealth(msg.payload as ConnectionHealth);
          } else if (msg.type === "error") {
            const payload = msg.payload as { error?: string };
            setError(payload.error ?? "Market subscription failed");
          }
        } catch {
          // ignore
        }
      };
    };

    connect();
    return () => {
      closed = true;
      if (timer) window.clearTimeout(timer);
      ws?.close();
    };
  }, []);

  const subscribe = (symbol: string) => {
    symbolRef.current = symbol;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "subscribe", symbol }));
    }
  };

  return { snapshots, health, connected, error, subscribe };
}
