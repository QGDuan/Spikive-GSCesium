export interface AholoRuntimeConfig {
  minLevel: number;
  maxBudget: number;
  backgroundPenalty: number;
  nearDistance: number;
  nearLevelStep: number;
  hysteresisTicks: number;
  schedulerParallelCounts: number;
  schedulerExistingTaskLimit: number;
  schedulerMinDuration: number;
  mergeNodeEnabled: boolean;
  frustumCullingEnabled: boolean;
  debuggerEnabled: boolean;
}

export const DEFAULT_AHOLO_RUNTIME_CONFIG: Readonly<AholoRuntimeConfig> = Object.freeze({
  minLevel: 0,
  maxBudget: 6_000_000,
  backgroundPenalty: 0.5,
  nearDistance: 10,
  nearLevelStep: 2,
  hysteresisTicks: 4,
  schedulerParallelCounts: 4,
  schedulerExistingTaskLimit: 64,
  schedulerMinDuration: 160,
  mergeNodeEnabled: true,
  frustumCullingEnabled: true,
  debuggerEnabled: false
});

export function normalizeAholoRuntimeConfig(
  value: AholoRuntimeConfig,
  maxLevel: number,
  sourceSplats: number
): AholoRuntimeConfig {
  const budgetCeiling = Math.max(100_000, Math.floor(sourceSplats));
  return {
    minLevel: integer(value.minLevel, 0, Math.max(0, maxLevel)),
    maxBudget: integer(value.maxBudget, 100_000, budgetCeiling),
    backgroundPenalty: finite(value.backgroundPenalty, 0, 1),
    nearDistance: finite(value.nearDistance, 0, 100_000),
    nearLevelStep: integer(value.nearLevelStep, 1, Math.max(1, maxLevel + 1)),
    hysteresisTicks: integer(value.hysteresisTicks, 0, 30),
    schedulerParallelCounts: integer(value.schedulerParallelCounts, 1, 8),
    schedulerExistingTaskLimit: integer(value.schedulerExistingTaskLimit, 4, 256),
    schedulerMinDuration: integer(value.schedulerMinDuration, 16, 2_000),
    mergeNodeEnabled: Boolean(value.mergeNodeEnabled),
    frustumCullingEnabled: Boolean(value.frustumCullingEnabled),
    debuggerEnabled: Boolean(value.debuggerEnabled)
  };
}

export function toAholoLodConfig(value: AholoRuntimeConfig) {
  return {
    minLevel: value.minLevel,
    maxBudget: value.maxBudget,
    backgroundPenalty: value.backgroundPenalty,
    distanceStep: value.nearDistance > 0
      ? [{ distance: value.nearDistance, step: value.nearLevelStep }]
      : [],
    hysteresisTicks: value.hysteresisTicks,
    schedulerParallelCounts: value.schedulerParallelCounts,
    schedulerExistingTaskLimit: value.schedulerExistingTaskLimit,
    schedulerMinDuration: value.schedulerMinDuration,
    mergeNodeEnabled: value.mergeNodeEnabled,
    frustumCullingEnabled: value.frustumCullingEnabled,
    debuggerEnabled: value.debuggerEnabled
  };
}

const finite = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));
const integer = (value: number, minimum: number, maximum: number) => Math.round(finite(value, minimum, maximum));
