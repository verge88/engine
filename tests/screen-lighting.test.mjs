import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Scene } from '../src/engine/scene.js';
import {
  createPointLight, packPointLights, POINT_LIGHT_BYTES, MAX_POINT_LIGHTS
} from '../src/engine/point-lights.js';
import { makeScreenUniform } from '../src/engine/lighting.js';

test('point light storage buffer follows std430 array alignment', () => {
  const first = createPointLight({
    position: [1, 2, 3], range: 7, color: [0.5, 0.25, 1], intensity: 42
  });
  const second = createPointLight({
    position: [-2, 1, 0], range: 5, color: [1, 0, 0.1], intensity: 16
  });
  const data = packPointLights([first, second]);
  assert.equal(data.byteLength, 16 + MAX_POINT_LIGHTS * 32);
  assert.equal(POINT_LIGHT_BYTES, 528);
  const view = new DataView(data);
  assert.equal(view.getUint32(0, true), 2);
  assert.equal(view.getFloat32(16, true), 1);
  assert.equal(view.getFloat32(20, true), 2);
  assert.equal(view.getFloat32(24, true), 3);
  assert.equal(view.getFloat32(28, true), 7);
  assert.equal(view.getFloat32(32, true), 0.5);
  assert.equal(view.getFloat32(36, true), 0.25);
  assert.equal(view.getFloat32(40, true), 1);
  assert.equal(view.getFloat32(44, true), 42);
  assert.equal(view.getFloat32(48, true), -2);
  assert.equal(view.getFloat32(80, true), 0);
});

test('disabled lights are omitted and no more than 16 are packed', () => {
  const lights = Array.from({ length: 19 }, (_, i) =>
    createPointLight({ position: [i, 0, 0] }));
  lights[0].enabled = false;
  const data = packPointLights(lights);
  assert.equal(new DataView(data).getUint32(0, true), 16);
  assert.equal(new DataView(data).getFloat32(16, true), 1);
  const empty = packPointLights([]);
  assert.equal(new DataView(empty).getUint32(0, true), 0);
  assert.ok(new Uint8Array(empty).every(x => x === 0));
});

test('point lights reject invalid numeric inputs and capacity overflow', () => {
  assert.throws(() => createPointLight({ range: 0 }), RangeError);
  assert.throws(() => createPointLight({ intensity: -1 }), RangeError);
  assert.throws(() => createPointLight({ position: [1, NaN, 3] }), RangeError);
  assert.throws(() => createPointLight({ color: [-1, 0, 0] }), RangeError);
  assert.throws(() => packPointLights([{ position: [0, 0, 0], color: [1, 1, 1], intensity: 0, range: -1 }]), RangeError);
  const scene = new Scene();
  for (let i = 0; i < MAX_POINT_LIGHTS; i++) scene.addPointLight();
  assert.equal(scene.pointLights.length, MAX_POINT_LIGHTS);
  assert.throws(() => scene.addPointLight(), RangeError);
  scene.clear();
  assert.equal(scene.pointLights.length, 0);
});

test('screen-space uniform retains the bloom and sky camera prefix', () => {
  const scene = new Scene();
  scene.aoStrength = 0.9;
  scene.giStrength = 1.2;
  scene.ssrStrength = 0.6;
  scene.screenRadius = 55;
  const packed = makeScreenUniform(scene, [2, 3, 10], [0, 1, 0], 16 / 9);
  assert.equal(packed.length, 24);
  assert.equal(packed.byteLength, 96);
  assert.ok(Math.abs(packed[0] - 1) < 1e-6);
  assert.deepEqual(Array.from(packed.slice(16, 20)), [2, 3, 10, 1]);
  for (const [offset, desired] of [[20, 0.9], [21, 1.2], [22, 0.6], [23, 55]])
    assert.ok(Math.abs(packed[offset] - desired) < 1e-5);
  scene.ssrStrength = -2;
  assert.equal(makeScreenUniform(scene, [2, 3, 10], [0, 1, 0], 1)[22], 0);
  assert.throws(() => makeScreenUniform(scene, [NaN, 0, 0], [0, 0, 0], 1), RangeError);
});

test('screen shader does not sample the output of its own pass', () => {
  const shader = readFileSync(new URL('../src/engine/screen-space.wgsl', import.meta.url), 'utf8');
  assert.match(shader, /fn fsIndirect/);
  assert.match(shader, /fn fsReflection/);
  assert.match(shader, /textureSampleLevel\(sceneColor/);
  assert.match(shader, /textureSampleLevel\(normalDepth/);
  assert.doesNotMatch(shader, /texture_storage_2d/);
});
