export const GS_STABLE_TILE_POLICY = Object.freeze({
  maximumScreenSpaceError: 16,
  dynamicScreenSpaceError: false,
  foveatedScreenSpaceError: false,
  progressiveResolutionHeightFraction: 0,
  skipLevelOfDetail: false,
  cullRequestsWhileMoving: false,
  cacheBytes: 384 * 1024 * 1024,
  maximumCacheOverflowBytes: 128 * 1024 * 1024,
  maximumEffectivePixelRatio: 1.5
});

/** Cesium multiplies this scale by devicePixelRatio when browser-recommended resolution is disabled. */
export function resolutionScaleForDevice(devicePixelRatio: number) {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(1, GS_STABLE_TILE_POLICY.maximumEffectivePixelRatio / ratio);
}
