import {
  ADDRESS_CLAMP_TO_EDGE,
  BlendState,
  GraphicsDevice,
  Mat4,
  PIXELFORMAT_RGBA8,
  PIXELFORMAT_RGBA32F,
  RenderTarget,
  SEMANTIC_POSITION,
  Shader,
  ShaderUtils,
  Texture,
  drawQuadWithShader
} from 'playcanvas';
import type { GSplatComponent } from 'playcanvas';

export const FIXED_CIRCLE_RADIUS_PIXELS = 5;

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export interface GaussianCircleSelection {
  position: Point3;
  normal: Point3;
  selectionRadiusPixels: number;
  neighborCount: number;
  normalPlanarity: number;
  normalEigenvalues: number[];
  residentFileCount: number;
  residentLodLevels: number[];
  pickBackend: 'supersplat-centers-gpu-circle';
  selectionDataSource: 'resident-streamed-sog-lod';
}

interface ResidentResource {
  centers?: Float32Array | null;
  hasCenters?: boolean;
}

interface OctreeResource {
  octree?: {
    files: Array<{ lodLevel: number }>;
    fileResources: Map<number, ResidentResource>;
  } | null;
  centers?: Float32Array | null;
  hasCenters?: boolean;
}

interface ResidentCenters {
  owner: object;
  centers: Float32Array;
  fileIndex: number;
  lodLevel: number;
  activeRanges: Array<{ start: number; end: number }> | null;
}

interface ActivePlacement {
  resource?: ResidentResource | null;
  lodIndex?: number;
  intervals?: Map<number, { x: number; y: number }>;
}

interface ActiveOctreeInstance {
  activePlacements?: Set<ActivePlacement>;
  filePlacements?: Array<ActivePlacement | null>;
}

interface ComponentInternals {
  _placement?: object | null;
  system?: {
    app?: {
      renderer?: {
        gsplatDirector?: {
          camerasMap?: Map<object, {
            layersMap?: Map<object, {
              gsplatManager?: {
                world?: { _octreeInstances?: Map<object, ActiveOctreeInstance> };
              };
            }>;
          }>;
        };
      };
    };
  };
}

interface CenterTextureEntry {
  texture: Texture;
  width: number;
  numCenters: number;
}

type ReadableTexture = Texture & {
  read: (
    x: number,
    y: number,
    width: number,
    height: number,
    options: { renderTarget: RenderTarget; data?: Uint8Array; immediate?: boolean }
  ) => Promise<ArrayBufferView>;
};

const vertexShader = /* glsl */ `
  attribute vec2 vertex_position;
  void main(void) {
    gl_Position = vec4(vertex_position, 0.0, 1.0);
  }
`;

const fragmentShaderWgsl = /* wgsl */ `
  var centerTexture: texture_2d<f32>;
  uniform center_params: vec2u;
  uniform output_params: vec2u;
  uniform matrix_modelViewProjection: mat4x4f;
  uniform circle_params: vec4f;

  @fragment
  fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let outputUV = vec2u(input.position.xy);
    let outputId = (outputUV.x + outputUV.y * uniform.output_params.x) * 4u;
    var result = vec4f(0.0);

    for (var channel = 0u; channel < 4u; channel += 1u) {
      let id = outputId + channel;
      if (id >= uniform.center_params.y) { continue; }
      let uv = vec2i(i32(id % uniform.center_params.x), i32(id / uniform.center_params.x));
      let center = textureLoad(centerTexture, uv, 0).xyz;
      let clip = uniform.matrix_modelViewProjection * vec4f(center, 1.0);
      if (clip.w <= 0.0) { continue; }
      let ndc = clip.xyz / clip.w;
      if (any(abs(ndc) > vec3f(1.0))) { continue; }
      let screen = vec2f(
        (ndc.x * 0.5 + 0.5) * uniform.circle_params.z,
        (-ndc.y * 0.5 + 0.5) * uniform.circle_params.w
      );
      let delta = screen - uniform.circle_params.xy;
      if (dot(delta, delta) <= 25.0) {
        switch channel {
          case 0u: { result.x = 1.0; }
          case 1u: { result.y = 1.0; }
          case 2u: { result.z = 1.0; }
          default: { result.w = 1.0; }
        }
      }
    }
    output.color = result;
    return output;
  }
`;

// This follows SuperSplat's centers-mode selection layout: four splat decisions are packed into
// one RGBA8 output texel. The only application-specific change is using a fixed circular predicate
// directly instead of uploading a canvas mask for a single click.
const fragmentShader = /* glsl */ `
  uniform highp sampler2D centerTexture;
  uniform uvec2 center_params;
  uniform uvec2 output_params;
  uniform mat4 matrix_modelViewProjection;
  uniform vec4 circle_params;

  void main(void) {
    uvec2 outputUV = uvec2(gl_FragCoord);
    uint outputId = (outputUV.x + outputUV.y * output_params.x) * 4u;
    vec4 result = vec4(0.0);

    for (uint channel = 0u; channel < 4u; channel++) {
      uint id = outputId + channel;
      if (id >= center_params.y) continue;
      ivec2 uv = ivec2(int(id % center_params.x), int(id / center_params.x));
      vec3 center = texelFetch(centerTexture, uv, 0).xyz;
      vec4 clip = matrix_modelViewProjection * vec4(center, 1.0);
      if (clip.w <= 0.0) continue;
      vec3 ndc = clip.xyz / clip.w;
      if (any(greaterThan(abs(ndc), vec3(1.0)))) continue;
      vec2 screen = vec2(
        (ndc.x * 0.5 + 0.5) * circle_params.z,
        (-ndc.y * 0.5 + 0.5) * circle_params.w
      );
      vec2 delta = screen - circle_params.xy;
      result[int(channel)] = dot(delta, delta) <= CIRCLE_RADIUS_SQUARED ? 1.0 : 0.0;
    }
    gl_FragColor = result;
  }
`;

const findActiveOctreeInstance = (component: GSplatComponent) => {
  const internals = component as unknown as ComponentInternals;
  const rootPlacement = internals._placement;
  const cameras = internals.system?.app?.renderer?.gsplatDirector?.camerasMap;
  if (!rootPlacement || !cameras) return undefined;
  for (const cameraData of cameras.values()) {
    for (const layerData of cameraData.layersMap?.values() ?? []) {
      const instance = layerData.gsplatManager?.world?._octreeInstances?.get(rootPlacement);
      if (instance) return instance;
    }
  }
  return undefined;
};

const collectResidentCenters = (component: GSplatComponent): ResidentCenters[] => {
  const resource = component.resource as unknown as OctreeResource | null;
  const octree = resource?.octree;
  if (octree) {
    const result: ResidentCenters[] = [];
    const activeInstance = findActiveOctreeInstance(component);
    if (!activeInstance?.activePlacements || !activeInstance.filePlacements) return result;
    const activePlacements = activeInstance?.activePlacements;
    for (const [fileIndex, fileResource] of octree.fileResources) {
      const placement = activeInstance?.filePlacements?.[fileIndex];
      // Active placement intervals are the exact file slices submitted by the current LOD. Fail
      // closed while the manager snapshot is unavailable instead of selecting prefetched/cooling
      // resources or every Gaussian in a referenced file.
      if (!placement || !activePlacements.has(placement) || fileResource.hasCenters === false) continue;
      const centers = fileResource.centers;
      if (!centers || centers.length < 3) continue;
      const activeRanges = placement?.intervals?.size
        ? [...placement.intervals.values()]
          .map((interval) => ({ start: Math.max(0, interval.x), end: interval.y + 1 }))
          .sort((a, b) => a.start - b.start)
        : null;
      result.push({
        owner: fileResource,
        centers,
        fileIndex,
        lodLevel: placement?.lodIndex ?? octree.files[fileIndex]?.lodLevel ?? -1,
        activeRanges
      });
    }
    return result;
  }

  const centers = resource?.centers;
  return resource && centers && centers.length >= 3
    ? [{ owner: resource as object, centers, fileIndex: 0, lodLevel: 0, activeRanges: null }]
    : [];
};

const smallestEigenvector = (covariance: number[]) => {
  const matrix = [...covariance];
  const vectors = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let iteration = 0; iteration < 24; iteration += 1) {
    let p = 0;
    let q = 1;
    let largest = Math.abs(matrix[1]);
    for (const [a, b] of [[0, 2], [1, 2]]) {
      const value = Math.abs(matrix[a * 3 + b]);
      if (value > largest) {
        largest = value;
        p = a;
        q = b;
      }
    }
    if (largest < 1e-12) break;
    const app = matrix[p * 3 + p];
    const aqq = matrix[q * 3 + q];
    const apq = matrix[p * 3 + q];
    const tau = (aqq - app) / (2 * apq);
    const t = (tau >= 0 ? 1 : -1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
    const c = 1 / Math.sqrt(1 + t * t);
    const s = t * c;
    for (let axis = 0; axis < 3; axis += 1) {
      if (axis === p || axis === q) continue;
      const aip = matrix[axis * 3 + p];
      const aiq = matrix[axis * 3 + q];
      matrix[axis * 3 + p] = matrix[p * 3 + axis] = c * aip - s * aiq;
      matrix[axis * 3 + q] = matrix[q * 3 + axis] = s * aip + c * aiq;
    }
    matrix[p * 3 + p] = app - t * apq;
    matrix[q * 3 + q] = aqq + t * apq;
    matrix[p * 3 + q] = matrix[q * 3 + p] = 0;
    for (let axis = 0; axis < 3; axis += 1) {
      const vip = vectors[axis * 3 + p];
      const viq = vectors[axis * 3 + q];
      vectors[axis * 3 + p] = c * vip - s * viq;
      vectors[axis * 3 + q] = s * vip + c * viq;
    }
  }
  let smallest = 0;
  if (matrix[4] < matrix[0]) smallest = 1;
  if (matrix[8] < matrix[smallest * 3 + smallest]) smallest = 2;
  const normal = { x: vectors[smallest], y: vectors[3 + smallest], z: vectors[6 + smallest] };
  const length = Math.hypot(normal.x, normal.y, normal.z);
  if (length < 1e-12) throw new Error('圆形多选点集无法计算稳定法向。');
  normal.x /= length;
  normal.y /= length;
  normal.z /= length;
  return { normal, eigenvalues: [matrix[0], matrix[4], matrix[8]].sort((a, b) => a - b) };
};

const fitNormalPca = (points: Point3[], viewOrigin: Point3) => {
  if (points.length < 3) throw new Error('5px 圆形选择区内至少需要 3 个当前 LOD Gaussian 中心。');
  const centroid = points.reduce(
    (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y, z: sum.z + point.z }),
    { x: 0, y: 0, z: 0 }
  );
  centroid.x /= points.length;
  centroid.y /= points.length;
  centroid.z /= points.length;
  const covariance = new Array<number>(9).fill(0);
  for (const point of points) {
    const x = point.x - centroid.x;
    const y = point.y - centroid.y;
    const z = point.z - centroid.z;
    covariance[0] += x * x;
    covariance[1] += x * y;
    covariance[2] += x * z;
    covariance[4] += y * y;
    covariance[5] += y * z;
    covariance[8] += z * z;
  }
  covariance[3] = covariance[1];
  covariance[6] = covariance[2];
  covariance[7] = covariance[5];
  for (let index = 0; index < covariance.length; index += 1) covariance[index] /= points.length;
  const result = smallestEigenvector(covariance);
  const facingX = viewOrigin.x - centroid.x;
  const facingY = viewOrigin.y - centroid.y;
  const facingZ = viewOrigin.z - centroid.z;
  if (result.normal.x * facingX + result.normal.y * facingY + result.normal.z * facingZ < 0) {
    result.normal.x *= -1;
    result.normal.y *= -1;
    result.normal.z *= -1;
  }
  const eigenSum = result.eigenvalues.reduce((sum, value) => sum + Math.max(0, value), 0);
  return {
    normal: result.normal,
    eigenvalues: result.eigenvalues,
    planarity: eigenSum > 0 ? 1 - Math.max(0, result.eigenvalues[0]) / eigenSum : 0
  };
};

export class GaussianCircleSelector {
  private readonly centerTextures = new Map<object, CenterTextureEntry>();
  private readonly outputTextures = new Map<string, { texture: Texture; target: RenderTarget }>();
  private readonly shaders = new Map<number, Shader>();
  private activeSelections = 0;
  private clearPending = false;
  private destroyPending = false;

  constructor(private readonly device: GraphicsDevice) {}

  async selectCircle(
    component: GSplatComponent,
    modelViewProjection: Mat4,
    viewOrigin: Point3,
    clickX: number,
    clickY: number,
    viewportWidth: number,
    viewportHeight: number
  ): Promise<GaussianCircleSelection> {
    const radius = FIXED_CIRCLE_RADIUS_PIXELS;
    if (this.destroyPending) throw new Error('巡检点圆形选择器已经销毁。');
    this.activeSelections += 1;
    try {
      const resources = collectResidentCenters(component);
      if (resources.length === 0) {
        throw new Error('当前视角还没有可选择的活动 LOD Gaussian interval，请等待细节加载后重试。');
      }
      this.releaseUnusedCenterTextures(new Set(resources.map((resource) => resource.owner)));

      const points: Point3[] = [];
      let position: Point3 | undefined;
      let nearestScreenDistance = Number.POSITIVE_INFINITY;
      let nearestDepth = Number.POSITIVE_INFINITY;
      const m = modelViewProjection.data;

      for (const resource of resources) {
        const centerTexture = this.getCenterTexture(resource);
        const outputWidth = Math.ceil(centerTexture.width / 4);
        const outputHeight = Math.ceil(centerTexture.numCenters / (outputWidth * 4));
        const output = this.getOutput(outputWidth, outputHeight);
        const shader = this.getShader(radius);
        this.device.scope.resolve('centerTexture').setValue(centerTexture.texture);
        this.device.scope.resolve('center_params').setValue([centerTexture.width, centerTexture.numCenters]);
        this.device.scope.resolve('output_params').setValue([outputWidth, outputHeight]);
        this.device.scope.resolve('matrix_modelViewProjection').setValue(m);
        this.device.scope.resolve('circle_params').setValue([clickX, clickY, viewportWidth, viewportHeight]);
        this.device.setBlendState(BlendState.NOBLEND);
        drawQuadWithShader(this.device, output.target, shader);
        const byteLength = outputWidth * outputHeight * 4;
        const mask = await (output.texture as ReadableTexture).read(0, 0, outputWidth, outputHeight, {
        renderTarget: output.target,
        data: new Uint8Array(byteLength),
        immediate: true
        }) as Uint8Array;

        const centers = resource.centers;
        const ranges = resource.activeRanges;
        let rangeIndex = 0;
        for (let id = 0; id < centerTexture.numCenters; id += 1) {
          if (mask[id] !== 255) continue;
          if (ranges) {
            while (rangeIndex < ranges.length && id >= ranges[rangeIndex].end) rangeIndex += 1;
            if (rangeIndex >= ranges.length || id < ranges[rangeIndex].start) continue;
          }
          const point = { x: centers[id * 3], y: centers[id * 3 + 1], z: centers[id * 3 + 2] };
          points.push(point);
          const x = point.x;
          const y = point.y;
          const z = point.z;
          const clipX = m[0] * x + m[4] * y + m[8] * z + m[12];
          const clipY = m[1] * x + m[5] * y + m[9] * z + m[13];
          const clipZ = m[2] * x + m[6] * y + m[10] * z + m[14];
          const clipW = m[3] * x + m[7] * y + m[11] * z + m[15];
          if (clipW <= 0) continue;
          const screenX = (clipX / clipW * 0.5 + 0.5) * viewportWidth;
          const screenY = (-clipY / clipW * 0.5 + 0.5) * viewportHeight;
          const screenDistance = (screenX - clickX) ** 2 + (screenY - clickY) ** 2;
          const depth = clipZ / clipW;
          if (screenDistance < nearestScreenDistance ||
              (screenDistance === nearestScreenDistance && depth < nearestDepth)) {
            position = point;
            nearestScreenDistance = screenDistance;
            nearestDepth = depth;
          }
        }
      }

      if (!position) throw new Error(`${radius}px 圆形选择区内没有当前 LOD Gaussian 中心。`);
      const fit = fitNormalPca(points, viewOrigin);
      return {
        position,
        normal: fit.normal,
        selectionRadiusPixels: radius,
        neighborCount: points.length,
        normalPlanarity: fit.planarity,
        normalEigenvalues: fit.eigenvalues,
        residentFileCount: resources.length,
        residentLodLevels: [...new Set(resources.map((resource) => resource.lodLevel))].sort((a, b) => a - b),
        pickBackend: 'supersplat-centers-gpu-circle',
        selectionDataSource: 'resident-streamed-sog-lod'
      };
    } finally {
      this.activeSelections -= 1;
      if (this.activeSelections === 0 && (this.clearPending || this.destroyPending)) {
        this.destroyCenterTextures();
        this.clearPending = false;
      }
      if (this.activeSelections === 0 && this.destroyPending) this.destroySharedResources();
    }
  }

  destroy() {
    this.destroyPending = true;
    if (this.activeSelections > 0) return;
    this.destroyCenterTextures();
    this.destroySharedResources();
  }

  private destroyCenterTextures() {
    for (const entry of this.centerTextures.values()) entry.texture.destroy();
    this.centerTextures.clear();
  }

  private destroySharedResources() {
    for (const entry of this.outputTextures.values()) {
      entry.target.destroy();
      entry.texture.destroy();
    }
    for (const shader of this.shaders.values()) shader.destroy();
    this.outputTextures.clear();
    this.shaders.clear();
  }

  clearResidentResources() {
    if (this.activeSelections > 0) {
      this.clearPending = true;
      return;
    }
    this.destroyCenterTextures();
  }

  trimResidentResources(component: GSplatComponent) {
    if (this.activeSelections > 0 || this.destroyPending) return;
    this.releaseUnusedCenterTextures(new Set(collectResidentCenters(component).map((resource) => resource.owner)));
  }

  private getCenterTexture(resource: ResidentCenters) {
    const cached = this.centerTextures.get(resource.owner);
    if (cached && cached.numCenters === resource.centers.length / 3) return cached;
    cached?.texture.destroy();
    const numCenters = resource.centers.length / 3;
    const width = Math.min(2048, this.device.maxTextureSize);
    const height = Math.ceil(numCenters / width);
    const data = new Float32Array(width * height * 4);
    for (let id = 0; id < numCenters; id += 1) {
      data[id * 4] = resource.centers[id * 3];
      data[id * 4 + 1] = resource.centers[id * 3 + 1];
      data[id * 4 + 2] = resource.centers[id * 3 + 2];
    }
    const texture = new Texture(this.device, {
      name: `inspection-circle-centers-${resource.fileIndex}`,
      width,
      height,
      format: PIXELFORMAT_RGBA32F,
      mipmaps: false,
      addressU: ADDRESS_CLAMP_TO_EDGE,
      addressV: ADDRESS_CLAMP_TO_EDGE,
      levels: [data]
    });
    texture.releaseSourceAfterUpload = true;
    const result = { texture, width, numCenters };
    this.centerTextures.set(resource.owner, result);
    return result;
  }

  private getOutput(width: number, height: number) {
    const key = `${width}x${height}`;
    const cached = this.outputTextures.get(key);
    if (cached) return cached;
    const texture = new Texture(this.device, {
      name: `inspection-circle-mask-${key}`,
      width,
      height,
      format: PIXELFORMAT_RGBA8,
      mipmaps: false,
      addressU: ADDRESS_CLAMP_TO_EDGE,
      addressV: ADDRESS_CLAMP_TO_EDGE
    });
    const result = { texture, target: new RenderTarget({ colorBuffer: texture, depth: false }) };
    this.outputTextures.set(key, result);
    return result;
  }

  private getShader(radius: number) {
    let shader = this.shaders.get(radius);
    if (!shader) {
      shader = ShaderUtils.createShader(this.device, {
        uniqueName: `inspection-circle-${radius}px-v2`,
        attributes: { vertex_position: SEMANTIC_POSITION },
        vertexGLSL: vertexShader,
        fragmentGLSL: fragmentShader,
        vertexChunk: 'fullscreenQuadVS',
        fragmentWGSL: fragmentShaderWgsl,
        fragmentDefines: new Map([['CIRCLE_RADIUS_SQUARED', `${radius * radius}.0`]])
      });
      this.shaders.set(radius, shader);
    }
    return shader;
  }

  private releaseUnusedCenterTextures(active: Set<object>) {
    for (const [owner, entry] of this.centerTextures) {
      if (active.has(owner)) continue;
      entry.texture.destroy();
      this.centerTextures.delete(owner);
    }
  }
}
