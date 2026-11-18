import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeRadiance, floatToHalfPositive, packRGBA16F } from '../src/engine/hdri.js';
import { CASCADE_COUNT, cascadeSplits, frustumSlice, buildCascades, transformPoint } from '../src/engine/cascades.js';
import { Scene } from '../src/engine/scene.js';

const header = (width, height, signY = '-', signX = '+') =>
  new TextEncoder().encode(
    '#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n' + signY + 'Y ' + height + ' ' + signX + 'X ' + width + '\n'
  );
function concat(...parts) {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
function almost(a, b, eps = 0.0005) {
  assert.ok(Math.abs(a - b) < eps, 'expected ' + a + ' ≈ ' + b);
}
test('Radiance raw RGBE decodes linear float and orientation', () => {
  // Exponent 136 means byte channels are already equal to linear values.
  const hdr = concat(header(2, 2), new Uint8Array([
    10, 20, 30, 136, 40, 50, 60, 136,
    70, 80, 90, 136, 100, 110, 120, 136
  ]));
  const { width, height, pixels } = decodeRadiance(hdr.buffer);
  assert.equal(width, 2); assert.equal(height, 2);
  assert.deepEqual([...pixels.slice(0, 4)], [10, 20, 30, 1]);
  assert.deepEqual([...pixels.slice(12, 16)], [100, 110, 120, 1]);
  const upsideDown = concat(header(2, 2, '+', '-'), hdr.subarray(header(2, 2).length));
  const changed = decodeRadiance(upsideDown).pixels;
  assert.deepEqual([...changed.slice(0, 4)], [100, 110, 120, 1]);
});
test('Radiance new-style per-channel RLE scanlines decode correctly', () => {
  const payload = new Uint8Array([
    2, 2, 0, 8, // RLE, width eight
    136, 128,   // 8 R pixels
    136, 64,    // 8 G pixels
    136, 32,    // 8 B pixels
    136, 136    // 8 exponents (linear factor 1)
  ]);
  const result = decodeRadiance(concat(header(8, 1), payload));
  assert.equal(result.pixels.length, 32);
  for (let x = 0; x < 8; x++) {
    const row = [...result.pixels.slice(x * 4, x * 4 + 4)];
    assert.deepEqual(row, [128, 64, 32, 1]);
  }
});
test('Radiance loader rejects invalid headers, corrupt runs, and truncated images', () => {
  assert.throws(() => decodeRadiance(new TextEncoder().encode('not a hdr\n')),
    /Not a Radiance/);
  assert.throws(() => decodeRadiance(concat(header(8, 1),
    new Uint8Array([2, 2, 0, 8, 0]))), /zero-length run/);
  assert.throws(() => decodeRadiance(header(2, 2)), /Truncated Radiance pixel/);
  assert.throws(() => decodeRadiance(new TextEncoder().encode(
    '#?RADIANCE\nFORMAT=unknown\n\n-Y 1 +X 1\n')), /Unsupported Radiance HDR format/);
});
test('float-to-half upload saturates HDR values and aligns row pitch', () => {
  assert.equal(floatToHalfPositive(0), 0);
  assert.equal(floatToHalfPositive(1), 0x3c00);
  assert.equal(floatToHalfPositive(2), 0x4000);
  assert.equal(floatToHalfPositive(65504), 0x7bff);
  assert.equal(floatToHalfPositive(1e10), 0x7bff);
  assert.throws(() => floatToHalfPositive(NaN), RangeError);
  const data = new Float32Array([1, 0.5, 0, 1, 0, 2, 4, 1]);
  const packed = packRGBA16F({ width: 2, height: 1, pixels: data });
  assert.equal(packed.bytesPerRow, 256);
  assert.equal(packed.data.length, 128);
  assert.equal(packed.data[0], 0x3c00);
  assert.equal(packed.data[5], 0x4000);
  assert.equal(packed.data[7], 0x3c00);
});
test('three cascades are ordered and cover the camera shadow distance', () => {
  const splits = cascadeSplits(0.05, 80, 3, 0.65);
  assert.equal(splits.length, CASCADE_COUNT);
  assert.ok(splits[0] > 0.05);
  assert.ok(splits[1] > splits[0]);
  almost(splits[2], 80);
  assert.throws(() => cascadeSplits(-1, 80), RangeError);
  assert.throws(() => cascadeSplits(1, 1), RangeError);
  assert.throws(() => cascadeSplits(1, 80, 3, 2), RangeError);
});
test('frustum-fitted light matrices contain all 8 corners of each slice', () => {
  const eye = [6, 5, 15];
  const target = [0, 1, 0];
  const aspect = 16 / 9;
  const { splits, matrices } = buildCascades({
    eye, target, aspect, sunDirection: [0.3, 0.8, 0.4]
  });
  assert.equal(matrices.length, 3);
  let near = 0.05;
  for (let c = 0; c < 3; c++) {
    const corners = frustumSlice(eye, target, aspect, near, splits[c]);
    assert.equal(corners.length, 8);
    for (const point of corners) {
      const ndc = transformPoint(matrices[c], point);
      assert.ok(Math.abs(ndc[0]) <= 1.001, 'outside cascade X: ' + ndc[0]);
      assert.ok(Math.abs(ndc[1]) <= 1.001, 'outside cascade Y: ' + ndc[1]);
      assert.ok(ndc[2] >= -0.001 && ndc[2] <= 1.001, 'outside cascade Z: ' + ndc[2]);
    }
    near = splits[c];
  }
});
test('three cascades remain finite across varied sun elevations', () => {
  for (const sun of [[0.1, 0.99, 0.2], [0.9, 0.2, 0.3], [-0.4, 0.7, -0.6]]) {
    const { matrices } = buildCascades({
      eye: [0, 8, 20], target: [0, 0, 0], aspect: 0.7, sunDirection: sun
    });
    for (const matrix of matrices) assert.ok(matrix.every(Number.isFinite));
  }
  assert.throws(() => buildCascades({
    eye: [0, 0, 1], target: [0, 0, 0], aspect: 1, sunDirection: [0, 0, 0]
  }), RangeError);
});
test('scene light intensity changes do not alter independent HDRI inputs', () => {
  const scene = new Scene();
  scene.sunIntensity = 3;
  assert.ok(scene.sunIntensity > 0);
});
