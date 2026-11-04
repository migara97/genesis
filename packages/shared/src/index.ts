export type ExecutionMode = "ANALYSIS_ONLY" | "PAPER" | "LIVE";
export type Side = "BUY" | "SELL";
export type SignalDirection = "LONG" | "SHORT" | "WAIT";
export type OrderType = "MARKET" | "LIMIT" | "STOP" | "TAKE_PROFIT";
export type OrderStatus =
  | "NEW"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELED"
  | "REJECTED"
  | "EXPIRED";

export type EvidenceKind = "exchange_reported" | "inferred" | "heuristic";

export interface EvidenceTag {
  kind: EvidenceKind;
  note: string;
}

export interface TradeTick {
  exchange: string;
  symbol: string;
  tradeId: string;
  price: number;
  quantity: number;
  /** true when buyer is aggressor (lifted ask). Exchange-reported when available. */
  buyerAggressor: boolean;
  aggressorSource: "exchange_flag" | "tick_rule_inferred";
  timestamp: number;
}

export interface BookLevel {
  price: number;
  quantity: number;
}

export interface OrderBookSnapshot {
  exchange: string;
  symbol: string;
  bids: BookLevel[];
  asks: BookLevel[];
  lastUpdateId: number;
  timestamp: number;
}

export interface Candle {
  symbol: string;
  interval: string;
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export interface FootprintCell {
  price: number;
  bidVolume: number;
  askVolume: number;
  delta: number;
  trades: number;
}

export interface FootprintBar {
  symbol: string;
  openTime: number;
  closeTime: number;
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
  evidence: EvidenceTag[];
}

export interface FootprintImbalance {
  price: number;
  side: "bid" | "ask";
  ratio: number;
  stacked: boolean;
  diagonal: boolean;
}

export interface CvdPoint {
  timestamp: number;
  price: number;
  delta: number;
  cvd: number;
}

export interface CvdState {
  symbol: string;
  sessionStart: number;
  cvd: number;
  points: CvdPoint[];
  divergence: "bullish" | "bearish" | "none";
  exhaustion: boolean;
  evidence: EvidenceTag[];
}

export interface DomMetrics {
  symbol: string;
  timestamp: number;
  bestBid: number;
  bestAsk: number;
  mid: number;
  spread: number;
  bidLiquidity: number;
  askLiquidity: number;
  imbalance: number;
  largeBidLevels: BookLevel[];
  largeAskLevels: BookLevel[];
  pullStackHint: "bid_stack" | "ask_stack" | "bid_pull" | "ask_pull" | "none";
  spoofingRisk: "elevated" | "low" | "unknown";
  evidence: EvidenceTag[];
}

export interface VolumeProfileLevel {
  price: number;
  volume: number;
  buyVolume: number;
  sellVolume: number;
}

export interface VolumeProfile {
  symbol: string;
  from: number;
  to: number;
  tickSize: number;
  levels: VolumeProfileLevel[];
  poc: number;
  vah: number;
  val: number;
  hvn: number[];
  lvn: number[];
  totalVolume: number;
}

export type SwingType = "HH" | "HL" | "LH" | "LL";

export interface SwingPoint {
  price: number;
  timestamp: number;
  type: SwingType;
  kind: "high" | "low";
}

export interface MarketStructureState {
  symbol: string;
  trend: "bullish" | "bearish" | "range";
  swings: SwingPoint[];
  lastBos?: { direction: "bullish" | "bearish"; price: number; timestamp: number };
  lastChoch?: { direction: "bullish" | "bearish"; price: number; timestamp: number };
  support: number[];
  resistance: number[];
  liquidityPools: { side: "BSL" | "SSL"; price: number; label: string }[];
  previousSessionHigh?: number;
  previousSessionLow?: number;
  evidence: EvidenceTag[];
}

export interface TradingSignal {
  id: string;
  symbol: string;
  timestamp: number;
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

export interface RiskConfig {
  riskPercentPerTrade: number;
  maxDailyLossPercent: number;
  maxOpenPositions: number;
  maxDrawdownPercent: number;
  minRiskReward: number;
  accountEquity: number;
  tradingEnabled: boolean;
  emergencyShutdown: boolean;
  allowedSessionsUtc?: { startHour: number; endHour: number }[];
}

export interface PlaceOrderRequest {
  symbol: string;
  side: Side;
  type: OrderType;
  quantity: number;
  price?: number;
  stopPrice?: number;
  reduceOnly?: boolean;
  clientOrderId?: string;
  /** Required true for LIVE mode */
  confirmLiveTrading?: boolean;
}

export interface OrderRecord {
  id: string;
  clientOrderId?: string;
  exchangeOrderId?: string;
  mode: ExecutionMode;
  symbol: string;
  side: Side;
  type: OrderType;
  quantity: number;
  filledQuantity: number;
  price?: number;
  stopPrice?: number;
  avgFillPrice?: number;
  status: OrderStatus;
  fees: number;
  createdAt: number;
  updatedAt: number;
  rejectReason?: string;
}

export interface Position {
  symbol: string;
  mode: ExecutionMode;
  side: Side;
  quantity: number;
  entryPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
  fees: number;
  updatedAt: number;
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
  book?: OrderBookSnapshot;
  dom?: DomMetrics;
  cvd?: CvdState;
  footprint?: FootprintBar;
  volumeProfile?: VolumeProfile;
  structure?: MarketStructureState;
  signal?: TradingSignal;
  recentTrades: TradeTick[];
  health: ConnectionHealth;
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  riskPercentPerTrade: 0.5,
  maxDailyLossPercent: 2,
  maxOpenPositions: 3,
  maxDrawdownPercent: 6,
  minRiskReward: 1.5,
  accountEquity: 100_000,
  tradingEnabled: true,
  emergencyShutdown: false,
};
