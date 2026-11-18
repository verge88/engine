import { lookAt, multiply, normalize, orthographic } from './math.js';
import { cameraBasis } from './lighting.js';

export const CASCADE_COUNT = 3;
export const CASCADE_SHADOW_SIZE = 2048;
export const SHADOW_DISTANCE = 80;

export function cascadeSplits(near = 0.05, far = SHADOW_DISTANCE,
                              count = CASCADE_COUNT, lambda = 0.65) {
  if (!(near > 0) || !(far > near) || !Number.isInteger(count) || count < 1 ||
      count > 8 || !(lambda >= 0 && lambda <= 1))
    throw new RangeError('Invalid cascade split configuration');
  const splits = [];
  for (let i = 1; i <= count; i++) {
    const t = i / count;
    const logSplit = near * Math.pow(far / near, t);
    const linearSplit = near + (far - near) * t;
    splits.push(i === count ? far : linearSplit * (1 - lambda) + logSplit * lambda);
  }
  return splits;
}

export function frustumSlice(eye, target, aspect, near, far, fovY = Math.PI / 3) {
  if (!Number.isFinite(aspect) || aspect <= 0 ||
      !(near > 0) || !(far > near) || !(fovY > 0 && fovY < Math.PI))
    throw new RangeError('Invalid camera frustum slice');
  const { forward, right, up } = cameraBasis(eye, target);
  const corners = [];
  const tan = Math.tan(fovY / 2);
  for (const z of [near, far]) {
    const halfHeight = z * tan;
    const halfWidth = halfHeight * aspect;
    for (const y of [-1, 1]) for (const x of [-1, 1]) {
      corners.push(eye.map((v, i) =>
        v + forward[i] * z + right[i] * x * halfWidth + up[i] * y * halfHeight
      ));
    }
  }
  return corners;
}

export function transformPoint(matrix, point) {
  const [x, y, z] = point;
  const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  return [
    (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / w,
    (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / w,
    (matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]) / w
  ];
}

export function buildCascades({
  eye, target, aspect, sunDirection, near = 0.05, far = SHADOW_DISTANCE,
  shadowSize = CASCADE_SHADOW_SIZE, count = CASCADE_COUNT, lambda = 0.65
}) {
  if (!Number.isInteger(shadowSize) || shadowSize < 16 ||
      !Array.isArray(sunDirection) || sunDirection.length !== 3 ||
      !sunDirection.every(Number.isFinite) || Math.hypot(...sunDirection) < 0.001)
    throw new RangeError('Invalid shadow map size or sunlight direction');
  const sun = normalize(sunDirection);
  const splits = cascadeSplits(near, far, count, lambda);
  const matrices = [];
  let sliceNear = near;
  for (const sliceFar of splits) {
    const corners = frustumSlice(eye, target, aspect, sliceNear, sliceFar);
    const center = [0, 0, 0];
    for (const corner of corners) for (let i = 0; i < 3; i++) center[i] += corner[i] / 8;
    const radius = Math.max(...corners.map(p =>
      Math.hypot(...p.map((v, i) => v - center[i]))
    ));
    const lightEye = center.map((v, i) => v + sun[i] * (radius * 2 + 25));
    const view = lookAt(lightEye, center);
    const lightPoints = corners.map(point => transformPoint(view, point));
    const min = [0, 1, 2].map(i => Math.min(...lightPoints.map(p => p[i])));
    const max = [0, 1, 2].map(i => Math.max(...lightPoints.map(p => p[i])));

    // A square footprint and texel snapping reduce shadow swimming when panning.
    const halfExtent = Math.max(max[0] - min[0], max[1] - min[1]) * 0.56 + 0.35;
    const texel = (halfExtent * 2) / shadowSize;
    const cx = Math.round(((min[0] + max[0]) / 2) / texel) * texel;
    const cy = Math.round(((min[1] + max[1]) / 2) / texel) * texel;
    // Give casters additional depth range outside the camera slice.
    const depthMargin = Math.max(12, radius);
    const nearPlane = Math.max(0.01, -max[2] - depthMargin);
    const farPlane = Math.max(nearPlane + 0.1, -min[2] + depthMargin);
    const projection = orthographic(cx - halfExtent, cx + halfExtent,
      cy - halfExtent, cy + halfExtent, nearPlane, farPlane);
    matrices.push(multiply(projection, view));
    sliceNear = sliceFar;
  }
  return { splits, matrices };
}
