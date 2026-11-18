import test from 'node:test';
import assert from 'node:assert/strict';
import { identity, multiply, perspective, lookAt, fromTRS, fromYaw, normalMatrix } from '../src/engine/math.js';
import { plane, cube, sphere } from '../src/engine/geometry.js';
import { Scene } from '../src/engine/scene.js';
import { parseGLB, readAccessor } from '../src/engine/gltf.js';

const almost = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-5, actual + ' != ' + expected);

test('column-major identity and translation composition', () => {
  const transform = fromTRS([3, 4, 5], fromYaw(0), [2, 3, 4]);
  const result = multiply(identity(), transform);
  assert.deepEqual([...result], [...transform]);
  assert.deepEqual([...result.slice(12, 15)], [3, 4, 5]);
  assert.deepEqual([...result.slice(0, 3)], [2, 0, 0]);
});
test('camera projection uses WebGPU zero-to-one depth', () => {
  const p = perspective(Math.PI / 2, 1, 0.1, 100);
  const clipZ = z => (p[10] * z + p[14]) / (-z);
  almost(clipZ(-0.1), 0);
  almost(clipZ(-100), 1);
  const v = lookAt([0, 0, 5], [0, 0, 0]);
  almost(v[14], -5);
});
test('normal matrix accounts for nonuniform scale', () => {
  const n = normalMatrix(fromTRS([0, 0, 0], fromYaw(0), [2, 4, 5]));
  almost(n[0], 0.5);
  almost(n[5], 0.25);
  almost(n[10], 0.2);
});
test('sphere/cube/plane meshes have valid indices and stride', () => {
  for (const mesh of [plane(10), cube(2), sphere(1, 12, 8)]) {
    assert.equal(mesh.vertices.length % 8, 0);
    assert.equal(mesh.indices.length % 3, 0);
    assert.ok(mesh.indices.every(i => i < mesh.vertices.length / 8));
  }
  assert.equal(cube().vertices.length / 8, 24);
  assert.equal(cube().indices.length, 36);
  assert.equal(sphere(1, 12, 8).vertices.length / 8, 13 * 9);
});
test('scene stores user transforms and material', () => {
  const scene = new Scene();
  const mesh = {};
  const object = scene.add(mesh, { metallic: 1 }, { position: [1, 2, 3] });
  assert.equal(object.geometry, mesh);
  assert.equal(object.material.metallic, 1);
  assert.equal(Scene.modelMatrix(object)[12], 1);
  scene.clear();
  assert.equal(scene.objects.length, 0);
});
test('GLB 2.0 parser checks header and JSON chunk', () => {
  const json = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' } }));
  const padded = (json.byteLength + 3) & ~3;
  const data = new ArrayBuffer(20 + padded);
  const view = new DataView(data);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, data.byteLength, true);
  view.setUint32(12, padded, true);
  view.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(data, 20).fill(32);
  new Uint8Array(data, 20).set(json);
  assert.equal(parseGLB(data).json.asset.version, '2.0');
  assert.throws(() => parseGLB(new ArrayBuffer(24)), /Not a GLB/);
});
test('glTF accessor reads strided buffer views', () => {
  const buffer = new Float32Array([1, 2, 3, 99, 4, 5, 6, 99]).buffer;
  const gltf = {
    accessors: [{ bufferView: 0, componentType: 5126, count: 2, type: 'VEC3' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteStride: 16 }]
  };
  assert.deepEqual([...readAccessor(gltf, [buffer], 0).data], [1, 2, 3, 4, 5, 6]);
});
