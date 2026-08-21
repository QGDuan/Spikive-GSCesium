import type { InspectionLabel, Mission, SurfaceHit } from "@spikive/shared";

export interface AholoSceneState {
  labelMode: boolean;
  labels: InspectionLabel[];
  mission: Mission | null;
  pendingPick: SurfaceHit | null;
  selectedLabelId: string | null;
}

export interface AholoSceneStateTarget {
  setInteraction(enabled: boolean): void;
  setOverlays(labels: InspectionLabel[], mission: Mission | null, pendingPick: SurfaceHit | null, selectedLabelId: string | null): void;
}

/** Apply the newest React state after the asynchronously loaded renderer becomes ready. */
export function applyAholoSceneState(target: AholoSceneStateTarget, state: AholoSceneState) {
  target.setInteraction(state.labelMode);
  target.setOverlays(state.labels, state.mission, state.pendingPick, state.selectedLabelId);
}
