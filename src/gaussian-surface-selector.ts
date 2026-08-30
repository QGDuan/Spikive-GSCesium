export const FIXED_CIRCLE_RADIUS_PIXELS = 5;

export const GAUSSIAN_SURFACE_SELECTION_METHOD = 'playcanvas-picker-depth-pca-v2' as const;
export const GAUSSIAN_SURFACE_PICK_BACKEND = 'playcanvas-native-depth-picker' as const;
export const GAUSSIAN_SURFACE_DATA_SOURCE = 'rendered-alpha-front-surface' as const;

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export interface GaussianSurfaceSelection {
  position: Point3;
  normal: Point3;
  selectionRadiusPixels: number;
  neighborCount: number;
  normalPlanarity: number;
  normalEigenvalues: number[];
  /** Kept for the existing SQLite/API shape. V2 no longer inspects private LOD internals. */
  residentFileCount: 0;
  /** Kept for the existing SQLite/API shape. V2 is bound by visual revision instead. */
  residentLodLevels: [];
  pickBackend: typeof GAUSSIAN_SURFACE_PICK_BACKEND;
  selectionDataSource: typeof GAUSSIAN_SURFACE_DATA_SOURCE;
}

/**
 * A fixed, non-draggable 5px circular stencil. The expensive visibility and Alpha decision is
 * performed by PlayCanvas Picker on the GPU; these offsets only choose which public depth results
 * participate in the tiny 3x3 covariance fit.
 */
export const SURFACE_DEPTH_SAMPLE_OFFSETS = Object.freeze([
  { x: 0, y: 0 },
  { x: -1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: -1 }, { x: 0, y: 1 },
  { x: -1, y: -1 }, { x: 1, y: -1 }, { x: -1, y: 1 }, { x: 1, y: 1 },
  { x: -3, y: 0 }, { x: 3, y: 0 }, { x: 0, y: -3 }, { x: 0, y: 3 },
  { x: -3, y: -3 }, { x: 3, y: -3 }, { x: -3, y: 3 }, { x: 3, y: 3 },
  { x: -5, y: 0 }, { x: 5, y: 0 }, { x: 0, y: -5 }, { x: 0, y: 5 }
] as const);

const smallestEigenvector = (covariance: number[]) => {
  const matrix = [...covariance];
  const vectors = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let iteration = 0; iteration < 24; iteration += 1) {
    let p = 0;
    let q = 1;
    let largest = Math.abs(matrix[1]);
    for (const [a, b] of [[0, 2], [1, 2]] as const) {
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
  if (length < 1e-12) throw new Error('前表面深度样本无法计算稳定法向。');
  normal.x /= length;
  normal.y /= length;
  normal.z /= length;
  return {
    normal,
    eigenvalues: [matrix[0], matrix[4], matrix[8]].map((value) => Math.max(0, value)).sort((a, b) => a - b)
  };
};

const uniqueFinitePoints = (points: readonly Point3[]) => {
  const result: Point3[] = [];
  for (const point of points) {
    if (![point.x, point.y, point.z].every(Number.isFinite)) continue;
    if (result.some((other) =>
      (other.x - point.x) ** 2 + (other.y - point.y) ** 2 + (other.z - point.z) ** 2 < 1e-18
    )) continue;
    result.push(point);
  }
  return result;
};

export const createGaussianSurfaceSelection = (
  position: Point3,
  depthPoints: readonly Point3[],
  viewOrigin: Point3
): GaussianSurfaceSelection => {
  const points = uniqueFinitePoints(depthPoints);
  if (points.length < 3) {
    throw new Error('5 像素圆内至少需要 3 个由原生深度选择器返回的前表面采样点。');
  }

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

  const fit = smallestEigenvector(covariance);
  const largest = fit.eigenvalues[2];
  if (largest <= Number.EPSILON || fit.eigenvalues[1] / largest < 1e-6) {
    throw new Error('当前可见前表面采样接近一条线，无法可靠计算平面法向，请稍微移动视角后重试。');
  }

  const facing = {
    x: viewOrigin.x - centroid.x,
    y: viewOrigin.y - centroid.y,
    z: viewOrigin.z - centroid.z
  };
  if (fit.normal.x * facing.x + fit.normal.y * facing.y + fit.normal.z * facing.z < 0) {
    fit.normal.x *= -1;
    fit.normal.y *= -1;
    fit.normal.z *= -1;
  }
  const eigenSum = fit.eigenvalues.reduce((sum, value) => sum + value, 0);

  return {
    position,
    normal: fit.normal,
    selectionRadiusPixels: FIXED_CIRCLE_RADIUS_PIXELS,
    neighborCount: points.length,
    normalPlanarity: eigenSum > 0 ? 1 - fit.eigenvalues[0] / eigenSum : 0,
    normalEigenvalues: fit.eigenvalues,
    residentFileCount: 0,
    residentLodLevels: [],
    pickBackend: GAUSSIAN_SURFACE_PICK_BACKEND,
    selectionDataSource: GAUSSIAN_SURFACE_DATA_SOURCE
  };
};
