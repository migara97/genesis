import { createHash } from "node:crypto";
import { DEFAULT_LIFECYCLE_CONFIG, type LifecycleConfig } from "../signalLifecycle.js";
import { DEFAULT_SIGNAL_CONFIG, type SignalEngineConfig } from "../signals.js";
import { DEFAULT_COST_MODEL, type CostModelConfig } from "./costModel.js";

/** Semver-ish engine label for journal rows. Bump when measurement contract changes. */
export const SIGNAL_ENGINE_VERSION = "0.14.0-phase12";

/** Phase 8 claim floors — below these, accuracy stays undefined. */
export const PHASE8_GATES = {
  overallMinResolved: 100,
  stratumMinResolved: 30,
  /** Matches computeCalibration default minPerBucket * 2. */
  calibrationMinResolved: 40,
} as const;

export function fingerprintConfig(parts: {
  signal?: Partial<SignalEngineConfig>;
  lifecycle?: Partial<LifecycleConfig>;
  costs?: Partial<CostModelConfig>;
}): string {
  const payload = {
    engine: SIGNAL_ENGINE_VERSION,
    signal: { ...DEFAULT_SIGNAL_CONFIG, ...parts.signal },
    lifecycle: { ...DEFAULT_LIFECYCLE_CONFIG, ...parts.lifecycle },
    costs: { ...DEFAULT_COST_MODEL, ...parts.costs },
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}

export const DEFAULT_CONFIG_VERSION = fingerprintConfig({});
