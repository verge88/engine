// Column-major matrices, right-handed world, WebGPU depth range [0, 1].
export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function identity() {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}
export function multiply(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  }
  return out;
}
export function perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = far / (near - far);
  out[11] = -1;
  out[14] = (near * far) / (near - far);
  return out;
}
export function orthographic(left, right, bottom, top, near, far) {
  const out = identity();
  out[0] = 2 / (right - left);
  out[5] = 2 / (top - bottom);
  out[10] = 1 / (near - far);
  out[12] = -(right + left) / (right - left);
  out[13] = -(top + bottom) / (top - bottom);
  out[14] = near / (near - far);
  return out;
}
export function normalize(v) {
  const length = Math.hypot(...v);
  return length < 1e-8 ? v.map(() => 0) : v.map(x => x / length);
}
export function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function lookAt(eye, target, up = [0, 1, 0]) {
  const z = normalize(eye.map((x, i) => x - target[i]));
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1
  ]);
}
export function fromTRS(t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return new Float32Array([
    (1 - yy - zz) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - xx - zz) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - xx - yy) * s[2], 0,
    t[0], t[1], t[2], 1
  ]);
}
export function fromYaw(angle) {
  return [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)];
}
export function normalMatrix(m) {
  const a = [m[0], m[1], m[2]];
  const b = [m[4], m[5], m[6]];
  const c = [m[8], m[9], m[10]];
  const n0 = cross(b, c), n1 = cross(c, a), n2 = cross(a, b);
  const det = dot(a, n0);
  if (Math.abs(det) < 1e-9) return identity();
  const inv = 1 / det;
  return new Float32Array([
    ...n0.map(v => v * inv), 0, ...n1.map(v => v * inv), 0,
    ...n2.map(v => v * inv), 0, 0, 0, 0, 1
  ]);
}
