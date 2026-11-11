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

export interface TimeframeStructureSummary {
  interval: string;
  trend: string;
  lastBos?: { direction: string; price: number; timestamp?: number };
  lastChoch?: { direction: string; price: number; timestamp?: number };
}

export interface MultiTimeframeContext {
  primaryInterval: string;
  frames: TimeframeStructureSummary[];
  higherTfBullish: number;
  higherTfBearish: number;
  higherTfRange: number;
  conflictWithPrimary: boolean;
  updatedAt: number;
}

export interface FairValueGap {
  id: string;
  direction: string;
  low: number;
  high: number;
  createdAt: number;
  mitigated: boolean;
  definition: string;
}

export interface OrderBlock {
  id: string;
  direction: string;
  low: number;
  high: number;
  createdAt: number;
  invalidated: boolean;
  definition: string;
}

export interface LiquiditySweepEvent {
  id: string;
  side: string;
  level: number;
  sweepPrice: number;
  closePrice: number;
  timestamp: number;
  bias: string;
  definition: string;
}

export interface StructureZonesState {
  symbol: string;
  orderBlocks: OrderBlock[];
  fairValueGaps: FairValueGap[];
  recentSweeps: LiquiditySweepEvent[];
  evidence: { kind: string; note: string }[];
  updatedAt: number;
}

export type ChartZoneKind = "demand" | "supply" | "balance";
export type ChartZoneSource =
  | "hvn_cluster"
  | "swing_cluster"
  | "order_block"
  | "session_extreme";

export interface ChartZoneBand {
  id: string;
  low: number;
  high: number;
  kind: ChartZoneKind;
  source: ChartZoneSource;
  strength: number;
  createdAt: number;
}

export interface ChartOverlayState {
  symbol: string;
  poc?: number;
  vah?: number;
  val?: number;
  bands: ChartZoneBand[];
  lastBos?: { direction: string; price: number; timestamp: number };
  lastChoch?: { direction: string; price: number; timestamp: number };
  profileFrom?: number;
  profileTo?: number;
  evidence: { kind: string; note: string }[];
  updatedAt: number;
}

export type BreakRetestPhase =
  | "idle"
  | "balance"
  | "broken"
  | "retesting"
  | "accepted"
  | "failed"
  | "invalidated";

export interface BreakRetestState {
  symbol: string;
  phase: BreakRetestPhase;
  side?: "bullish" | "bearish";
  bandId?: string;
  bandLow?: number;
  bandHigh?: number;
  oppositeBandId?: string;
  oppositeLow?: number;
  oppositeHigh?: number;
  brokenAt?: number;
  brokenBarIndex?: number;
  retestAt?: number;
  acceptedAt?: number;
  breakPrice?: number;
  reason: string;
  evidence: { kind: string; note: string }[];
  updatedAt: number;
}

export type ScenarioKind =
  | "break_now_long"
  | "dip_to_demand_long"
  | "break_now_short"
  | "rally_to_supply_short";

export type ScenarioStatus = "open" | "armed" | "triggered" | "invalidated" | "completed";

export interface TradeScenario {
  id: string;
  kind: ScenarioKind;
  status: ScenarioStatus;
  side: "bullish" | "bearish";
  triggerPrice: number;
  entryLow: number;
  entryHigh: number;
  invalidation: number;
  rankScore: number;
  rankNote: string;
  reason: string;
  linkedBreakRetestPhase?: BreakRetestPhase;
  updatedAt: number;
}

export interface ScenarioTreeState {
  symbol: string;
  bias: "bullish" | "bearish" | "none";
  scenarios: TradeScenario[];
  evidence: { kind: string; note: string }[];
  updatedAt: number;
}

export interface SignalFactor {
  id: string;
  family: "structure" | "delta" | "orderflow" | "volume";
  side: "long" | "short" | "neutral";
  weight: number;
  source: "exchange_reported" | "derived" | "heuristic";
  reason: string;
}

export interface SignalScoreBreakdown {
  longScore: number;
  shortScore: number;
  neutralScore: number;
  independentFamilies: string[];
  factors: SignalFactor[];
  modelNote: string;
}

export type SignalLifecycle =
  | "WATCHING"
  | "PENDING_CONFIRM"
  | "CONFIRMED"
  | "ACTIVE"
  | "HIT_TP"
  | "HIT_SL"
  | "INVALIDATED"
  | "EXPIRED"
  | "TIMEOUT";

export type StructureTargetKind =
  | "measured_move"
  | "prior_swing"
  | "session_extreme"
  | "vp_node";

export interface StructureTarget {
  id: string;
  kind: StructureTargetKind;
  price: number;
  label: string;
  distancePct: number;
  hitAt?: number;
}

export interface TradingSignal {
  id?: string;
  setupId?: string;
  timestamp?: number;
  direction: SignalDirection;
  entry?: number;
  stopLoss?: number;
  takeProfit?: number[];
  riskReward?: number;
  structureTargets?: StructureTarget[];
  confidence: number;
  confirmations: string[];
  reasonsFor: string[];
  reasonsAgainst: string[];
  invalidation: string[];
  orderFlowOk: boolean;
  structureOk: boolean;
  volumeOk: boolean;
  deltaOk: boolean;
  score?: SignalScoreBreakdown;
  evidence?: { kind: string; note: string }[];
  /** A+ = selective checklist; STANDARD = multi-confirm only; WAIT = no setup. */
  entryGrade?: "A+" | "STANDARD" | "WAIT";
  entryQualityNotes?: string[];
  lifecycle?: SignalLifecycle;
  lifecycleUpdatedAt?: number;
  setupOpenedAt?: number;
  lifecycleNote?: string;
}

export interface ConnectionHealth {
  exchange: string;
  connected: boolean;
  lastMessageAt?: number;
  lastError?: string;
  reconnectAttempts: number;
  symbols: string[];
}

export interface SignalSetupRow {
  setupId: string;
  symbol: string;
  exchange: string;
  direction: string;
  lifecycle: string;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number[];
  exitPrice: number | null;
  pnlPrice: number | null;
  confidence: number;
  longScore: number | null;
  shortScore: number | null;
  families: string[];
  confirmations: string[];
  lifecycleNote?: string;
  openedAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export interface SignalJournalMetrics {
  setups: number;
  directional: number;
  hitTp: number;
  hitSl: number;
  invalidated: number;
  expired: number;
  open: number;
  winRate: number | null;
  avgPnlPerUnit: number | null;
  totalPnlPerUnit: number;
  sampleNote: string;
}

export interface BacktestResultView {
  symbol: string;
  trades: {
    setupId: string;
    entryTime: number;
    exitTime: number;
    side: string;
    entry: number;
    exit: number;
    pnl: number;
    fees: number;
    outcome: string;
  }[];
  signalsEvaluated: number;
  directionalSignals: number;
  waitSignals: number;
  winRate: number | null;
  profitFactor: number | null;
  profitFactorUnbounded?: boolean;
  maxDrawdown: number;
  averageRr: number | null;
  expectancy: number | null;
  totalPnl: number;
  limitation: string;
}

export type ScannerRegime =
  | "post_pump_compression"
  | "salvage_after_flush"
  | "wedge_reclaim"
  | "none";

export interface ScannerHit {
  symbol: string;
  rankScore: number;
  rankNote: string;
  rvol: number;
  compression: number;
  nearBand?: { kind: string; low: number; high: number; source: string };
  regime: ScannerRegime;
  bias: "bullish" | "bearish" | "none";
  reason: string;
  updatedAt: number;
}

export interface ScannerSnapshot {
  hits: ScannerHit[];
  universeSize: number;
  updatedAt: number;
  evidence: { kind: string; note: string }[];
}

export interface MarketSnapshot {
  symbol: string;
  lastPrice: number;
  timestamp: number;
  primaryInterval?: string;
  book?: { bids: BookLevel[]; asks: BookLevel[] };
  dom?: DomMetrics;
  cvd?: CvdState;
  footprint?: FootprintBar;
  volumeProfile?: VolumeProfile;
  structure?: MarketStructureState;
  mtf?: MultiTimeframeContext;
  zones?: StructureZonesState;
  chartOverlay?: ChartOverlayState;
  breakRetest?: BreakRetestState;
  scenarios?: ScenarioTreeState;
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
