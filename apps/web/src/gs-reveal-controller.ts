import { Cartesian3, type Cesium3DTileset } from "cesium";
import { CESIUM_GS_REVEAL_PATCH_VERSION } from "./cesium-patch-version";
import { calculateGsRevealFrame, type GsRevealFrame } from "./gs-reveal-policy";

interface EngineRevealState extends GsRevealFrame {
  enabled: boolean;
  center: Cartesian3;
}

type RevealTileset = Cesium3DTileset & {
  spikiveGaussianSplatReveal?: EngineRevealState;
  spikiveGaussianSplatRevealSupported?: number;
  spikiveGaussianSplatRevealPatchVersion?: number;
  spikiveGaussianSplatRevealShaderActive?: boolean;
};

export interface GsRevealController {
  readonly supported: boolean;
  readonly shaderActive: boolean;
  update(elapsedMs: number): void;
  finish(): void;
}

export function createGsRevealController(tileset: Cesium3DTileset, sceneRadius: number): GsRevealController {
  const revealTileset = tileset as RevealTileset;
  const state: EngineRevealState = {
    enabled: true,
    center: new Cartesian3(0, 0, 0),
    ...calculateGsRevealFrame(0, sceneRadius)
  };
  revealTileset.spikiveGaussianSplatReveal = state;

  return {
    get supported() {
      return revealTileset.spikiveGaussianSplatRevealSupported === 1
        && revealTileset.spikiveGaussianSplatRevealPatchVersion === CESIUM_GS_REVEAL_PATCH_VERSION;
    },
    get shaderActive() { return revealTileset.spikiveGaussianSplatRevealShaderActive === true; },
    update(elapsedMs) {
      if (tileset.isDestroyed() || !state.enabled) return;
      Object.assign(state, calculateGsRevealFrame(elapsedMs, sceneRadius));
    },
    finish() {
      if (!state.enabled) return;
      if (!tileset.isDestroyed()) {
        Object.assign(state, calculateGsRevealFrame(Number.POSITIVE_INFINITY, sceneRadius));
      }
      state.enabled = false;
    }
  };
}
