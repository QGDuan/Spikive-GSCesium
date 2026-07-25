export interface GsRevealFrame {
  globalAlpha: number;
  seedAlpha: number;
  scaleProgress: number;
  revealRadius: number;
  revealFeather: number;
  solidRadius: number;
  solidFeather: number;
  seedSizePixels: number;
}

export const GS_REVEAL_DURATION_MS = 20_000;
export const GS_REVEAL_SEED_SIZE_PIXELS = 4.2;
export const GS_REVEAL_BASE_ALPHA = 0.8;

export function easeOutGsReveal(progress: number) {
  const remaining = 1 - clamp(progress, 0, 1);
  return 1 - remaining * remaining * remaining;
}

export function easeOutGsSolid(progress: number) {
  const remaining = 1 - clamp(progress, 0, 1);
  return 1 - remaining * remaining;
}

export function calculateGsRevealFrame(elapsedMs: number, sceneRadius: number): GsRevealFrame {
  const radius = Math.max(Number.isFinite(sceneRadius) ? sceneRadius : 0, 1);
  const elapsed = clamp(elapsedMs, 0, GS_REVEAL_DURATION_MS);
  const timelineProgress = elapsed / GS_REVEAL_DURATION_MS;
  const feather = clamp(radius * 0.06, 0.2, 8);
  const revealProgress = 1.1 * easeOutGsReveal(timelineProgress);
  const solidProgress = 1.1 * easeOutGsSolid(timelineProgress);

  return {
    globalAlpha: mix(GS_REVEAL_BASE_ALPHA, 1, timelineProgress),
    seedAlpha: GS_REVEAL_BASE_ALPHA,
    scaleProgress: timelineProgress,
    revealRadius: radius * revealProgress,
    revealFeather: feather,
    solidRadius: radius * solidProgress,
    solidFeather: feather,
    seedSizePixels: GS_REVEAL_SEED_SIZE_PIXELS
  };
}

const clamp = (value: number, minimum: number, maximum: number) => Math.min(Math.max(value, minimum), maximum);
const mix = (start: number, end: number, progress: number) => start + (end - start) * progress;
