import type { ApiError, CreateDataset, CreateLabel, CreateMission, Dataset, InspectionLabel, Mission, RaycastRequest, RenderManifest, SurfaceHit } from "@spikive/shared";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers
  });
  if (!response.ok) {
    const body = await response.json().catch((): ApiError => ({ error: response.statusText }));
    const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? body.error
      : `HTTP ${response.status}`;
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  datasets: () => request<Dataset[]>("/api/datasets"),
  createDataset: (value: CreateDataset) => request<Dataset>("/api/datasets", { method: "POST", body: JSON.stringify(value) }),
  updateDataset: (id: string, value: { voxelSize: number }) => request<Dataset>(`/api/datasets/${id}`, { method: "PATCH", body: JSON.stringify(value) }),
  retryDataset: (id: string) => request<Dataset>(`/api/datasets/${id}/retry`, { method: "POST" }),
  rebuildDatasetVisuals: (id: string) => request<Dataset>(`/api/datasets/${id}/rebuild-visuals`, { method: "POST" }),
  renderManifest: (id: string, signal?: AbortSignal) => request<RenderManifest>(`/api/datasets/${id}/render-manifest`, { signal }),
  deleteDataset: (id: string) => request<void>(`/api/datasets/${id}`, { method: "DELETE" }),
  raycastDataset: (id: string, value: RaycastRequest, signal?: AbortSignal) => request<SurfaceHit | null>(`/api/datasets/${id}/raycast`, { method: "POST", body: JSON.stringify(value), signal }),
  labels: (datasetId: string) => request<InspectionLabel[]>(`/api/datasets/${datasetId}/labels`),
  createLabel: (datasetId: string, value: CreateLabel) => request<InspectionLabel>(`/api/datasets/${datasetId}/labels`, { method: "POST", body: JSON.stringify(value) }),
  resolveLabel: (id: string) => request<InspectionLabel>(`/api/labels/${id}/resolve`, { method: "POST" }),
  flipLabel: (id: string) => request<InspectionLabel>(`/api/labels/${id}`, { method: "PATCH", body: JSON.stringify({ flipNormal: true }) }),
  deleteLabel: (id: string) => request<void>(`/api/labels/${id}`, { method: "DELETE" }),
  missions: (datasetId: string) => request<Mission[]>(`/api/missions?datasetId=${encodeURIComponent(datasetId)}`),
  createMission: (value: CreateMission) => request<Mission>("/api/missions", { method: "POST", body: JSON.stringify(value) }),
  planMission: (id: string) => request<Mission>(`/api/missions/${id}/plan`, { method: "POST" }),
  deleteMission: (id: string) => request<void>(`/api/missions/${id}`, { method: "DELETE" })
};
