import type { Waypoint } from "@spikive/shared";

export interface RouteWaypointVisual {
  name: string;
  color: string;
  pixelSize: number;
  showText: boolean;
}

export function routeWaypointVisual(point: Waypoint, index: number, targetLabelTitle?: string): RouteWaypointVisual {
  const linkedToLabel = point.targetLabelId !== null;
  return {
    name: targetLabelTitle ? `hj_${targetLabelTitle}` : `${index} ${point.type}`,
    color: !point.valid ? "#ff8a00" : linkedToLabel ? "#e32636" : point.type === "transit" ? "#1677ff" : "#111318",
    pixelSize: linkedToLabel ? 13 : point.type === "transit" ? 8 : 9,
    // hj_ remains a durable semantic name, but label-bound waypoints are
    // intentionally represented by their red point rather than duplicate text.
    showText: !linkedToLabel
  };
}
