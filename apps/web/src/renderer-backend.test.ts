import { describe, expect, it } from "vitest";
import { describeRendererBackend } from "./renderer-backend";

describe("describeRendererBackend", () => {
  it("identifies the actual WebGPU device", () => {
    expect(describeRendererBackend("WEBGPU")).toEqual({
      kind: "webgpu",
      label: "WebGPU",
      activeText: "当前使用 WebGPU 渲染"
    });
  });

  it("normalizes WebGL device labels to WebGL2", () => {
    expect(describeRendererBackend("webgl2")).toEqual({
      kind: "webgl2",
      label: "WebGL2",
      activeText: "当前使用 WebGL2 渲染"
    });
  });

  it("does not guess before the graphics device reports its backend", () => {
    expect(describeRendererBackend()).toEqual({
      kind: "unknown",
      label: "检测中",
      activeText: "正在检测实际渲染后端"
    });
  });
});
