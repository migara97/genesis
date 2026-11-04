export type SignalDirection = "LONG" | "SHORT" | "WAIT";
export type ExecutionMode = "ANALYSIS_ONLY" | "PAPER" | "LIVE";

export interface TradeTick {
  tradeId: string;
  price: number;
  quantity: number;
  buyerAggressor: boolean;
  aggressorSource: string;
  timestamp: number;
}

export interface BookLevel {
  price: number;
  quantity: number;
}

export interface DomMetrics {
  bestBid: number;
  bestAsk: number;
  mid: number;
  spread: number;
  bidLiquidity: number;
  askLiquidity: number;
  imbalance: number;
  largeBidLevels: BookLevel[];
  largeAskLevels: BookLevel[];
  pullStackHint: string;
  spoofingRisk: string;
  evidence: { kind: string; note: string }[];
}

export interface FootprintCell {
  price: number;
  bidVolume: number;
  askVolume: number;
  delta: number;
  trades?: number;
}

export interface FootprintImbalance {
  price: number;
  side: string;
  ratio?: number;
  stacked: boolean;
  diagonal?: boolean;
}

export interface FootprintBar {
  openTime?: number;
  closeTime?: number;
  open: number;
  high: number;
  low: number;
  close: number;
  cells: FootprintCell[];
  totalDelta: number;
  totalVolume: number;
  imbalances: FootprintImbalance[];
  absorption: boolean;
  exhaustion: boolean;
  unfinishedAuction: boolean;
  evidence: { kind: string; note: string }[];
}

export interface CvdState {
  sessionStart?: number;
  cvd: number;
  divergence: string;
  exhaustion: boolean;
  points: { timestamp: number; price: number; cvd: number; delta: number }[];
  evidence: { kind: string; note: string }[];
}

export interface VolumeLevel {
  price: number;
  volume: number;
  buyVolume?: number;
  sellVolume?: number;
}

export interface VolumeProfile {
  from?: number;
  to?: number;
  poc: number;
  vah: number;
  val: number;
  hvn: number[];
  lvn: number[];
  levels: VolumeLevel[];
  totalVolume: number;
}

export interface SwingPoint {
  price: number;
  timestamp: number;
  type: string;
  kind: string;
}

export interface MarketStructureState {
  trend: string;
  swings?: SwingPoint[];
  support: number[];
  resistance: number[];
  liquidityPools: { side: string; price: number; label: string }[];
  lastBos?: { direction: string; price: number; timestamp?: number };
  lastChoch?: { direction: string; price: number; timestamp?: number };
  previousSessionHigh?: number;
  previousSessionLow?: number;
  evidence: { kind: string; note: string }[];
}

export interface TradingSignal {
  timestamp?: number;
  direction: SignalDirection;
  entry?: number;
  stopLoss?: number;
  takeProfit?: number[];
  riskReward?: number;
  confidence: number;
  confirmations: string[];
  reasonsFor: string[];
  reasonsAgainst: string[];
  invalidation: string[];
  orderFlowOk: boolean;
  structureOk: boolean;
  volumeOk: boolean;
  deltaOk: boolean;
}

export interface ConnectionHealth {
  exchange: string;
  connected: boolean;
  lastMessageAt?: number;
  lastError?: string;
  reconnectAttempts: number;
  symbols: string[];
}

export interface MarketSnapshot {
  symbol: string;
  lastPrice: number;
  timestamp: number;
  book?: { bids: BookLevel[]; asks: BookLevel[] };
  dom?: DomMetrics;
  cvd?: CvdState;
  footprint?: FootprintBar;
  volumeProfile?: VolumeProfile;
  structure?: MarketStructureState;
  signal?: TradingSignal;
  recentTrades: TradeTick[];
  health: ConnectionHealth;
}

export interface Position {
  symbol: string;
  mode: ExecutionMode;
  side: "BUY" | "SELL";
  quantity: number;
  entryPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
  fees: number;
}

export interface OrderRecord {
  id: string;
  mode: ExecutionMode;
  symbol: string;
  side: "BUY" | "SELL";
  type: string;
  quantity: number;
  filledQuantity: number;
  avgFillPrice?: number;
  status: string;
  fees: number;
  rejectReason?: string;
  createdAt: number;
}

export interface MarketListing {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: "live" | "suspended" | "delisted";
  contractType: string;
  lastPrice: number | null;
  change24h: number | null;
  changePct24h: number | null;
  volume24h: number | null;
  high24h: number | null;
  low24h: number | null;
  bid: number | null;
  ask: number | null;
  favorite: boolean;
}

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface RiskConfig {
  riskPercentPerTrade: number;
  maxDailyLossPercent: number;
  maxOpenPositions: number;
  maxDrawdownPercent: number;
  minRiskReward: number;
  accountEquity: number;
  tradingEnabled: boolean;
  emergencyShutdown: boolean;
}
