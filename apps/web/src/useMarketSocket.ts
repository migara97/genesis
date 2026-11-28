import { useEffect, useRef, useState } from "react";
import type { ConnectionHealth, MarketSnapshot } from "./types";

const PRIMARY_KEY = "genesis.primaryInterval";
const DESK_SYMBOL_KEY = "genesis.deskSymbol";
const PING_MS = 15_000;

export function readStoredPrimaryInterval(): "5m" | "15m" {
  try {
    const v = localStorage.getItem(PRIMARY_KEY);
    if (v === "15m" || v === "5m") return v;
  } catch {
    // ignore
  }
  return "5m";
}

export function storePrimaryInterval(interval: "5m" | "15m"): void {
  try {
    localStorage.setItem(PRIMARY_KEY, interval);
  } catch {
    // ignore
  }
}

export function readStoredDeskSymbol(): string | null {
  try {
    const v = localStorage.getItem(DESK_SYMBOL_KEY);
    return v && /^[A-Z0-9._-]{3,40}$/i.test(v) ? v.toUpperCase() : null;
  } catch {
    return null;
  }
}

export function storeDeskSymbol(symbol: string): void {
  try {
    localStorage.setItem(DESK_SYMBOL_KEY, symbol.toUpperCase());
  } catch {
    // ignore
  }
}

function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws`;
}

export interface InAppAlert {
  id: string;
  symbol: string;
  message: string;
  price: number | null;
  lifecycle: string | null;
  firedAt: number;
  eventType?: string;
}

export function useMarketSocket() {
  const [snapshots, setSnapshots] = useState<Record<string, MarketSnapshot>>({});
  const [health, setHealth] = useState<ConnectionHealth | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<InAppAlert[]>([]);
  const retryRef = useRef(0);
  const wsRef = useRef<WebSocket | null>(null);
  const symbolRef = useRef<string | null>(readStoredDeskSymbol());
  const primaryRef = useRef<"5m" | "15m">(readStoredPrimaryInterval());
  const pingRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let timer: number | undefined;

    const clearPing = () => {
      if (pingRef.current != null) {
        window.clearInterval(pingRef.current);
        pingRef.current = undefined;
      }
    };

    const sendSubscribe = (socket: WebSocket) => {
      if (!symbolRef.current) return;
      socket.send(
        JSON.stringify({
          type: "subscribe",
          symbol: symbolRef.current,
          primaryInterval: primaryRef.current,
        }),
      );
    };

    const connect = () => {
      if (closed) return;
      clearPing();
      try {
        ws?.close();
      } catch {
        // ignore
      }
      ws = new WebSocket(wsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        setError(null);
        retryRef.current = 0;
        sendSubscribe(ws!);
        clearPing();
        pingRef.current = window.setInterval(() => {
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: "ping" }));
          }
        }, PING_MS);
      };

      ws.onclose = () => {
        setConnected(false);
        clearPing();
        if (closed) return;
        // Fast reconnect after API restart / proxy blip so desk panels recover together.
        const delay = Math.min(4_000, 400 * 2 ** Math.min(retryRef.current, 4));
        retryRef.current += 1;
        setError("WebSocket reconnecting…");
        timer = window.setTimeout(connect, delay);
      };

      // Browser fires error before close on proxy blips; don't sticky-lock the banner.
      ws.onerror = () => {
        if (!closed) setError("WebSocket reconnecting…");
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as {
            type: string;
            payload: unknown;
          };
          if (msg.type === "hello") {
            const payload = msg.payload as {
              snapshots: MarketSnapshot[];
              symbols?: string[];
            };
            const map: Record<string, MarketSnapshot> = {};
            for (const s of payload.snapshots ?? []) map[s.symbol] = s;
            setSnapshots(map);
            // Prefer persisted desk symbol (XAU etc.) so reconnects don't jump back to BTC.
            const first =
              symbolRef.current ??
              readStoredDeskSymbol() ??
              payload.snapshots?.[0]?.symbol ??
              payload.symbols?.[0] ??
              null;
            if (first) {
              symbolRef.current = first;
              storeDeskSymbol(first);
              sendSubscribe(ws!);
            }
            if (payload.snapshots?.[0]?.health) setHealth(payload.snapshots[0].health);
          } else if (msg.type === "snapshot") {
            const snap = msg.payload as MarketSnapshot;
            // Merge — never drop the desk symbol while focus is switching.
            setSnapshots((prev) => ({ ...prev, [snap.symbol]: snap }));
            setHealth(snap.health);
            setError(null);
            // Do NOT re-assert subscribe on mismatch — other tabs sharing this API
            // would fight (BTC↔XAU) and flash okx-swap live/down forever.
          } else if (msg.type === "health") {
            setHealth(msg.payload as ConnectionHealth);
          } else if (msg.type === "pong") {
            // keepalive ack
          } else if (msg.type === "alert") {
            const fire = msg.payload as {
              id?: string;
              symbol?: string;
              message?: string;
              price?: number | null;
              lifecycle?: string | null;
              firedAt?: number;
              eventType?: string;
            };
            if (fire?.message && fire.symbol) {
              const item: InAppAlert = {
                id: fire.id ?? `${Date.now()}`,
                symbol: fire.symbol,
                message: fire.message,
                price: fire.price ?? null,
                lifecycle: fire.lifecycle ?? null,
                firedAt: fire.firedAt ?? Date.now(),
                eventType: fire.eventType,
              };
              setAlerts((prev) => [item, ...prev].slice(0, 40));
            }
          } else if (msg.type === "error") {
            const payload = msg.payload as { error?: string };
            setError(payload.error ?? "Market subscription failed");
          }
        } catch {
          // ignore
        }
      };
    };

    const onVisible = () => {
      if (document.visibilityState !== "visible" || closed) return;
      const state = wsRef.current?.readyState;
      if (state !== WebSocket.OPEN && state !== WebSocket.CONNECTING) {
        retryRef.current = 0;
        if (timer) window.clearTimeout(timer);
        connect();
      } else if (state === WebSocket.OPEN && symbolRef.current) {
        sendSubscribe(wsRef.current!);
      }
    };

    const onStorage = (ev: StorageEvent) => {
      if (ev.key !== DESK_SYMBOL_KEY || !ev.newValue) return;
      const next = ev.newValue.toUpperCase();
      if (!/^[A-Z0-9._-]{3,40}$/.test(next)) return;
      // Follow the tab that clicked — do not subscribe again (avoids focus fight).
      symbolRef.current = next;
    };

    connect();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    window.addEventListener("storage", onStorage);

    return () => {
      closed = true;
      clearPing();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
      window.removeEventListener("storage", onStorage);
      if (timer) window.clearTimeout(timer);
      ws?.close();
    };
  }, []);

  const subscribe = (symbol: string, primaryInterval?: "5m" | "15m") => {
    const next = symbol.toUpperCase();
    symbolRef.current = next;
    storeDeskSymbol(next);
    if (primaryInterval) {
      primaryRef.current = primaryInterval;
      storePrimaryInterval(primaryInterval);
    }
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "subscribe",
          symbol: next,
          primaryInterval: primaryRef.current,
        }),
      );
    }
  };

  const setPrimaryInterval = (interval: "5m" | "15m") => {
    primaryRef.current = interval;
    storePrimaryInterval(interval);
    if (symbolRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "subscribe",
          symbol: symbolRef.current,
          primaryInterval: interval,
        }),
      );
    }
  };

  const dismissAlert = (id: string) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  };

  const clearAlerts = () => setAlerts([]);

  return {
    snapshots,
    health,
    connected,
    error,
    alerts,
    dismissAlert,
    clearAlerts,
    subscribe,
    setPrimaryInterval,
    primaryInterval: primaryRef.current,
  };
}
