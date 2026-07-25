import type { Waypoint } from "@spikive/shared";

export interface RouteWaypointVisual {
  name: string;
  color: string;
  pixelSize: number;
  emphasized: boolean;
}

export function routeWaypointVisual(point: Waypoint, index: number, targetLabelTitle?: string): RouteWaypointVisual {
  const linkedToLabel = point.targetLabelId !== null;
  return {
    name: targetLabelTitle ? `hj_${targetLabelTitle}` : `${index} ${point.type}`,
    color: !point.valid ? "#ff8a00" : linkedToLabel ? "#e32636" : point.type === "transit" ? "#1677ff" : "#111318",
    pixelSize: linkedToLabel ? 13 : point.type === "transit" ? 8 : 9,
    emphasized: linkedToLabel
  };
}
