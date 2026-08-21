import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { InspectionLabel } from "@spikive/shared";
import { InspectionLabelPopup } from "./InspectionLabelPopup";

describe("InspectionLabelPopup", () => {
  it("shows persisted inspection geometry without exposing route hj labels", () => {
    const label: InspectionLabel = {
      id: "00000000-0000-4000-8000-000000000001",
      datasetId: "00000000-0000-4000-8000-000000000002",
      title: "主电机",
      description: "检查轴承温度与异响",
      category: "电机",
      color: "#ffb020",
      positionLocal: { x: 1.2345, y: -2, z: 3 },
      surfaceNormalLocal: { x: 0, y: 1, z: 0 },
      snapDistance: 0.125,
      resolutionStatus: "resolved",
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z"
    };

    const markup = renderToStaticMarkup(<InspectionLabelPopup label={label} onClose={vi.fn()} />);

    expect(markup).toContain("主电机");
    expect(markup).toContain("检查轴承温度与异响");
    expect(markup).toContain("1.234, -2, 3");
    expect(markup).toContain("0.125 m");
    expect(markup).not.toContain("hj_");
  });
});
