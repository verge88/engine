import test from 'node:test';
import assert from 'node:assert/strict';
import { dot } from '../src/engine/math.js';
import { cameraBasis, makePostUniform, sunDirectionAtElevation } from '../src/engine/lighting.js';
import {
  ENV_SIZE, IRRADIANCE_SIZE, SPECULAR_SIZE, SPECULAR_MIPS, BRDF_SIZE, roughnessAtMip
} from '../src/engine/environment.js';
import { Scene } from '../src/engine/scene.js';

const near = (actual, expected, eps = 1e-5) =>
  assert.ok(Math.abs(actual - expected) < eps, 'Expected ' + actual + ' ≈ ' + expected);

test('GPU cube convolution dimensions remain valid and mip range is monotonic', () => {
  assert.equal(SPECULAR_SIZE >> (SPECULAR_MIPS - 1), 4);
  assert.ok(ENV_SIZE >= SPECULAR_SIZE);
  assert.ok(SPECULAR_SIZE >= IRRADIANCE_SIZE);
  assert.ok(BRDF_SIZE >= 64);
  near(roughnessAtMip(0), 0);
  near(roughnessAtMip(SPECULAR_MIPS - 1), 1);
  for (let mip = 1; mip < SPECULAR_MIPS; mip++) {
    assert.ok(roughnessAtMip(mip) > roughnessAtMip(mip - 1));
  }
  assert.throws(() => roughnessAtMip(-1), RangeError);
  assert.throws(() => roughnessAtMip(SPECULAR_MIPS), RangeError);
});

test('sun direction remains normalized, finite and correctly elevated', () => {
  for (const elevation of [5, 30, 56, 80]) {
    const direction = sunDirectionAtElevation(elevation);
    near(Math.hypot(...direction), 1);
    near(direction[1], Math.sin(elevation * Math.PI / 180));
  }
  assert.throws(() => sunDirectionAtElevation(NaN), RangeError);
  assert.throws(() => sunDirectionAtElevation(12, Infinity), RangeError);
});

test('camera basis is orthonormal for sky ray reconstruction', () => {
  const { forward, right, up } = cameraBasis([3, 2, 8], [0, 1, 0]);
  for (const v of [forward, right, up]) near(Math.hypot(...v), 1);
  near(dot(forward, up), 0);
  near(dot(forward, right), 0);
  near(dot(up, right), 0);
  assert.throws(() => cameraBasis([0, 0, 0], [0, 0, 0]), RangeError);
  assert.throws(() => cameraBasis([0, 4, 0], [0, 0, 0]), RangeError);
});

test('postprocess uniform matches 4 std140-style vec4 WGSL slots', () => {
  const scene = new Scene();
  scene.exposure = 1.35;
  scene.bloomStrength = 0.4;
  scene.bloomThreshold = 1.8;
  const uniform = makePostUniform(scene, [0, 2, 5], [0, 0, 0], 16 / 9);
  assert.equal(uniform.length, 16);
  near(uniform[0], 1.35);
  near(uniform[1], 0.4);
  near(uniform[2], 1.8);
  near(uniform[3], 16 / 9);
  // The camera looks roughly into -Z; right must point to +X.
  near(uniform[4], 1);
  assert.ok(uniform[14] < 0);
  for (const index of [7, 11, 15]) near(uniform[index], 0);
  assert.throws(() => makePostUniform(scene, [0, 2, 5], [0, 0, 0], 0), RangeError);
});

test('scene initializes predictable bloom defaults and can disable it', () => {
  const scene = new Scene();
  assert.ok(scene.bloomStrength > 0);
  assert.ok(scene.bloomThreshold > 0);
  scene.bloomStrength = 0;
  near(makePostUniform(scene, [0, 1, 5], [0, 0, 0], 1)[1], 0);
});
