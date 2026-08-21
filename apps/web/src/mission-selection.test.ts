import { describe, expect, it } from "vitest";
import type { Mission } from "@spikive/shared";
import { selectMissionForScene } from "./mission-selection";

const mission = (id: string) => ({ id } as Mission);

describe("scene route selection", () => {
  it("automatically shows the first available mission when entering a scene", () => {
    expect(selectMissionForScene(null, [mission("first"), mission("second")])?.id).toBe("first");
  });

  it("preserves an existing selection and falls back when it was deleted", () => {
    expect(selectMissionForScene(mission("second"), [mission("first"), mission("second")])?.id).toBe("second");
    expect(selectMissionForScene(mission("missing"), [mission("first")])?.id).toBe("first");
  });
});
