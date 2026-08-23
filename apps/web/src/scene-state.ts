import type { InspectionLabel, Mission, SurfaceHit } from "@spikive/shared";

export interface InspectionSceneState {
  labelMode: boolean;
  labels: InspectionLabel[];
  mission: Mission | null;
  pendingPick: SurfaceHit | null;
  selectedLabelId: string | null;
}

export interface InspectionSceneStateTarget {
  setInteraction(enabled: boolean): void;
  setOverlays(labels: InspectionLabel[], mission: Mission | null, pendingPick: SurfaceHit | null, selectedLabelId: string | null): void;
}

export function applyInspectionSceneState(target: InspectionSceneStateTarget, state: InspectionSceneState) {
  target.setInteraction(state.labelMode);
  target.setOverlays(state.labels, state.mission, state.pendingPick, state.selectedLabelId);
}
