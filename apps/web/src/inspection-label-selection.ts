export function inspectionLabelIdFromPick(picked: unknown): string | null {
  if (!picked || typeof picked !== "object" || !("id" in picked)) return null;
  const raw = (picked as { id?: unknown }).id;
  const entityId = typeof raw === "string"
    ? raw
    : raw && typeof raw === "object" && "id" in raw && typeof (raw as { id?: unknown }).id === "string"
      ? (raw as { id: string }).id
      : null;
  if (!entityId) return null;
  for (const prefix of ["app:label:", "app:label-highlight:"]) {
    if (entityId.startsWith(prefix)) return entityId.slice(prefix.length) || null;
  }
  return null;
}
