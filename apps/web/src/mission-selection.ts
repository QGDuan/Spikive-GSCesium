import type { Mission } from "@spikive/shared";

/** Keep the selected route when possible; otherwise show the first scene route. */
export function selectMissionForScene(current: Mission | null, missions: Mission[]) {
  return (current ? missions.find(mission => mission.id === current.id) : undefined) ?? missions[0] ?? null;
}
