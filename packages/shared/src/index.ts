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

/** Compact per-timeframe structure summary for Phase-4 MTF alignment. */
export interface TimeframeStructureSummary {
  interval: string;
  trend: "bullish" | "bearish" | "range";
  lastBos?: { direction: "bullish" | "bearish"; price: number; timestamp: number };
  lastChoch?: { direction: "bullish" | "bearish"; price: number; timestamp: number };
}

/**
 * Multi-timeframe context. Higher TFs (1d/4h/1h) confirm or conflict with
 * the primary (15m) structure bias. Trends are derived from candle swings.
 */
export interface MultiTimeframeContext {
  primaryInterval: string;
  frames: TimeframeStructureSummary[];
  higherTfBullish: number;
  higherTfBearish: number;
  higherTfRange: number;
  /** True when primary trend is directional and majority HTF opposes it. */
  conflictWithPrimary: boolean;
  updatedAt: number;
}

/**
 * Phase-6 price zones. All fields are rule-derived heuristics from OHLC —
 * not exchange labels and not proof of "institutional" intent.
 */
export interface FairValueGap {
  id: string;
  direction: "bullish" | "bearish";
  low: number;
  high: number;
  createdAt: number;
  mitigated: boolean;
  /** Exact mechanical rule used to create this gap. */
  definition: string;
}

export interface OrderBlock {
  id: string;
  direction: "bullish" | "bearish";
  low: number;
  high: number;
  createdAt: number;
  invalidated: boolean;
  definition: string;
}

export interface LiquiditySweepEvent {
  id: string;
  side: "BSL" | "SSL";
  level: number;
  sweepPrice: number;
  closePrice: number;
  timestamp: number;
  /** SSL reclaim → bullish bias; BSL reclaim → bearish bias (rule only). */
  bias: "bullish" | "bearish";
  definition: string;
}

export interface StructureZonesState {
  symbol: string;
  orderBlocks: OrderBlock[];
  fairValueGaps: FairValueGap[];
  recentSweeps: LiquiditySweepEvent[];
  evidence: EvidenceTag[];
  updatedAt: number;
}

/**
 * Phase-A chart overlay bands. Rule-derived gray SR/VP boxes for the candle chart —
 * not exchange drawings and not institutional labels.
 */
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
  /** Relative strength 0..1 for ranking / opacity hints. */
  strength: number;
  createdAt: number;
}

export interface ChartOverlayState {
  symbol: string;
  poc?: number;
  vah?: number;
  val?: number;
  bands: ChartZoneBand[];
  lastBos?: { direction: "bullish" | "bearish"; price: number; timestamp: number };
  lastChoch?: { direction: "bullish" | "bearish"; price: number; timestamp: number };
  /** Time window used for chart VP when trade coverage was sufficient. */
  profileFrom?: number;
  profileTo?: number;
  evidence: EvidenceTag[];
  updatedAt: number;
}

/**
 * Phase-B RANGE_BREAK_RETEST playbook. Heuristic state machine on chart bands —
 * not a prediction of path, and not an institutional claim.
 */
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
  /** Break direction once broken (bullish = broke supply, bearish = broke demand). */
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
  evidence: EvidenceTag[];
  updatedAt: number;
}

/**
 * Phase-D dual scenario tree. Hypotheses only — not a second order engine
 * and not calibrated win-rate probabilities.
 */
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
  /** Model ranking score in [0,1] — not a historical win rate. */
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
  evidence: EvidenceTag[];
  updatedAt: number;
}

export type SignalFactorSource = "exchange_reported" | "derived" | "heuristic";
export type SignalFactorFamily = "structure" | "delta" | "orderflow" | "volume";

/** One scored contribution inside the Phase-1 explainable model. */
export interface SignalFactor {
  id: string;
  family: SignalFactorFamily;
  side: "long" | "short" | "neutral";
  weight: number;
  source: SignalFactorSource;
  reason: string;
}

/**
 * Transparent score snapshot. Weights are configurable model parameters —
 * not a statistically proven edge or calibrated win probability.
 */
export interface SignalScoreBreakdown {
  longScore: number;
  shortScore: number;
  neutralScore: number;
  independentFamilies: SignalFactorFamily[];
  factors: SignalFactor[];
  modelNote: string;
}

/**
 * Signal lifecycle. Terminal states are held briefly to suppress duplicate
 * re-alerts. Phase-7: TIMEOUT = age/max-hold expiry; EXPIRED kept for
 * backward-compatible journal rows / generic expiry.
 */
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

/** Forward-paper / validation outcome (measurement layer — not a signal gate). */
export type PaperOutcome =
  | "OPEN"
  | "HIT_TP"
  | "HIT_SL"
  | "INVALIDATED"
  | "EXPIRED"
  | "TIMEOUT"
  | "PARTIAL_TP";

export type MarketRegimeTag =
  | "bullish_trend"
  | "bearish_trend"
  | "sideways"
  | "high_volatility"
  | "low_volatility"
  | "high_volume"
  | "low_volume"
  | "post_pump_compression"
  | "clean_range"
  | "liq_high"
  | "liq_mid"
  | "liq_low"
  | "unknown";

/** Phase F paper setup identity for stratified validation. */
export type PaperSetupClass = "RANGE_BREAK_RETEST" | "OTHER";

/**
 * Frozen snapshot at paper-trade open. Preserves what the engine saw —
 * does not re-score later.
 */
export interface PaperTradeSnapshot {
  signalId: string;
  setupId: string;
  symbol: string;
  exchange: string;
  marketType: "futures_perp" | "spot";
  pair: string;
  direction: "LONG" | "SHORT";
  generatedAt: number;
  primaryTimeframe: string;
  /** Phase F: RANGE_BREAK_RETEST when break_retest_* confirmation present. */
  setupClass: PaperSetupClass;
  entry: number;
  stopLoss: number;
  takeProfit: number[];
  confidence: number;
  longScore: number;
  shortScore: number;
  families: string[];
  confirmations: string[];
  factors: { id: string; family: string; side: string; weight: number; source: string }[];
  orderFlowOk: boolean;
  structureOk: boolean;
  volumeOk: boolean;
  deltaOk: boolean;
  regimeTags: MarketRegimeTag[];
  engineVersion: string;
  configVersion: string;
  ofSnapshot?: {
    cvd?: number;
    footprintDelta?: number;
    domImbalance?: number;
    poc?: number;
    vah?: number;
    val?: number;
    mtfSummary?: string;
    /** Phase C structure targets frozen at paper open. */
    structureTargets?: StructureTarget[];
    /** Phase B playbook slice frozen at paper open. */
    breakRetest?: { phase: string; side?: string; bandId?: string };
    quoteVolume24h?: number;
    rangeContext?: "post_pump_compression" | "clean_range" | "none";
  };
}

/**
 * Phase-C geometry targets (measured move / swing / session / VP).
 * Informational beside R-multiple takeProfit — not a second exit engine.
 */
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
  /** Absolute distance from entry as a fraction of entry. */
  distancePct: number;
  /** Set by lifecycle when price first reaches this level (does not force HIT_TP). */
  hitAt?: number;
}

export interface TradingSignal {
  id: string;
  /** Stable id for the same symbol/direction/confirmation family set (Phase 1). */
  setupId: string;
  symbol: string;
  timestamp: number;
  direction: SignalDirection;
  entry?: number;
  stopLoss?: number;
  takeProfit?: number[];
  riskReward?: number;
  /** Phase C geometry targets (informational; R-multiples remain the exit path). */
  structureTargets?: StructureTarget[];
  /**
   * Model confidence in [0,1]. Not a historical win rate.
   * WAIT signals are capped lower by design.
   */
  confidence: number;
  confirmations: string[];
  reasonsFor: string[];
  reasonsAgainst: string[];
  invalidation: string[];
  orderFlowOk: boolean;
  structureOk: boolean;
  volumeOk: boolean;
  deltaOk: boolean;
  score: SignalScoreBreakdown;
  evidence: EvidenceTag[];
  /**
   * Entry quality grade. A+ = stricter selective profile (not a win-rate claim).
   * STANDARD = legacy multi-confirm gates only. WAIT when no directional setup.
   */
  entryGrade: "A+" | "STANDARD" | "WAIT";
  /** Checklist notes when A+ filters pass or demote a setup to WAIT. */
  entryQualityNotes?: string[];
  /** Phase 2 lifecycle status. */
  lifecycle: SignalLifecycle;
  lifecycleUpdatedAt: number;
  /** When this setupId first entered a non-watching state. */
  setupOpenedAt: number;
  lifecycleNote?: string;
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
  /** Desk primary candle interval driving structure/zones/overlays (5m|15m). */
  primaryInterval?: string;
  book?: OrderBookSnapshot;
  dom?: DomMetrics;
  cvd?: CvdState;
  footprint?: FootprintBar;
  volumeProfile?: VolumeProfile;
  structure?: MarketStructureState;
  /** Phase 4 multi-timeframe structure summaries. */
  mtf?: MultiTimeframeContext;
  /** Phase 6 OB / FVG / sweep zones (rule-derived). */
  zones?: StructureZonesState;
  /** Phase A candle-chart VP / gray-zone overlay (rule-derived). */
  chartOverlay?: ChartOverlayState;
  /** Phase B breakout + retest playbook state. */
  breakRetest?: BreakRetestState;
  /** Phase D dual scenario hypotheses (not executable orders). */
  scenarios?: ScenarioTreeState;
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
