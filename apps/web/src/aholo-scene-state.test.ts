import { describe, expect, it, vi } from "vitest";
import type { InspectionLabel, Mission } from "@spikive/shared";
import { applyAholoSceneState } from "./aholo-scene-state";

describe("AHoLo asynchronous scene state", () => {
  it("applies the latest labels and mission when the renderer finishes after association loading", () => {
    const label = { id: "label" } as InspectionLabel;
    const mission = { id: "mission", waypoints: [{ id: "waypoint" }] } as Mission;
    const target = { setInteraction: vi.fn(), setOverlays: vi.fn() };

    applyAholoSceneState(target, { labelMode: false, labels: [label], mission, pendingPick: null, selectedLabelId: "label" });

    expect(target.setInteraction).toHaveBeenCalledWith(false);
    expect(target.setOverlays).toHaveBeenCalledWith([label], mission, null, "label");
  });
});
