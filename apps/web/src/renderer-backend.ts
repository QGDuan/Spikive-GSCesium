export type RendererBackendKind = "webgpu" | "webgl2" | "unknown";

export interface RendererBackendPresentation {
  kind: RendererBackendKind;
  label: string;
  activeText: string;
}

export function describeRendererBackend(value?: string | null): RendererBackendPresentation {
  const normalized = value?.trim().toUpperCase() ?? "";

  if (normalized.includes("WEBGPU")) {
    return { kind: "webgpu", label: "WebGPU", activeText: "当前使用 WebGPU 渲染" };
  }

  if (normalized.includes("WEBGL")) {
    return { kind: "webgl2", label: "WebGL2", activeText: "当前使用 WebGL2 渲染" };
  }

  return {
    kind: "unknown",
    label: normalized || "检测中",
    activeText: normalized ? `当前使用 ${normalized} 渲染` : "正在检测实际渲染后端"
  };
}
