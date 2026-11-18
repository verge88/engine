import { fromTRS, identity, multiply } from './math.js';

const COMPONENT = {
  5120: ['getInt8', 1], 5121: ['getUint8', 1],
  5122: ['getInt16', 2], 5123: ['getUint16', 2],
  5125: ['getUint32', 4], 5126: ['getFloat32', 4]
};
const ELEMENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const decode = bytes => new TextDecoder().decode(bytes);

export function parseGLB(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  if (arrayBuffer.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67)
    throw new Error('Not a GLB file');
  if (view.getUint32(4, true) !== 2) throw new Error('Only glTF 2.0 is supported');
  const length = view.getUint32(8, true);
  if (length !== arrayBuffer.byteLength) throw new Error('Invalid GLB file length');
  let json = null, binary = null, offset = 12;
  while (offset + 8 <= length) {
    const byteLength = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    offset += 8;
    if (offset + byteLength > length) throw new Error('Corrupt GLB chunk');
    const bytes = new Uint8Array(arrayBuffer, offset, byteLength);
    if (type === 0x4e4f534a) json = JSON.parse(decode(bytes).replace(/\u0000+$/, ''));
    if (type === 0x004e4942) binary = bytes.slice().buffer;
    offset += byteLength;
  }
  if (!json || offset !== length) throw new Error('Missing glTF JSON chunk or malformed GLB');
  return { json, binary };
}
function normalizedValue(v, componentType) {
  switch (componentType) {
    case 5120: return Math.max(v / 127, -1);
    case 5121: return v / 255;
    case 5122: return Math.max(v / 32767, -1);
    case 5123: return v / 65535;
    case 5125: return v / 4294967295;
    default: return v;
  }
}
export function readAccessor(gltf, buffers, accessorIndex) {
  const a = gltf.accessors[accessorIndex];
  if (!a || a.sparse || a.bufferView === undefined)
    throw new Error('Unsupported sparse/empty glTF accessor: ' + accessorIndex);
  const viewInfo = gltf.bufferViews[a.bufferView];
  const [reader, width] = COMPONENT[a.componentType] ?? [];
  const components = ELEMENTS[a.type];
  if (!reader || !components) throw new Error('Unsupported accessor component/type');
  const stride = viewInfo.byteStride ?? width * components;
  if (stride < width * components || stride % width) throw new Error('Invalid accessor stride');
  const start = (viewInfo.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const data = new DataView(buffers[viewInfo.buffer]);
  if (start + (a.count - 1) * stride + width * components > data.byteLength)
    throw new Error('Accessor exceeds buffer bounds');
  const values = new Float32Array(a.count * components);
  for (let i = 0; i < a.count; i++) for (let c = 0; c < components; c++) {
    const v = data[reader](start + i * stride + c * width, true);
    values[i * components + c] = a.normalized ? normalizedValue(v, a.componentType) : v;
  }
  return { data: values, count: a.count, components };
}
function geometryFromPrimitive(gltf, buffers, primitive) {
  if (primitive.mode !== undefined && primitive.mode !== 4)
    throw new Error('Only TRIANGLES glTF primitives are supported');
  const positions = readAccessor(gltf, buffers, primitive.attributes.POSITION);
  if (positions.components !== 3) throw new Error('POSITION must be VEC3');
  const normals = primitive.attributes.NORMAL === undefined
    ? null : readAccessor(gltf, buffers, primitive.attributes.NORMAL);
  const uvs = primitive.attributes.TEXCOORD_0 === undefined
    ? null : readAccessor(gltf, buffers, primitive.attributes.TEXCOORD_0);
  if (normals && (normals.components !== 3 || normals.count !== positions.count))
    throw new Error('Invalid NORMAL accessor');
  if (uvs && (uvs.components !== 2 || uvs.count !== positions.count))
    throw new Error('Invalid TEXCOORD_0 accessor');
  const indices = primitive.indices === undefined
    ? Uint32Array.from({ length: positions.count }, (_, i) => i)
    : Uint32Array.from(readAccessor(gltf, buffers, primitive.indices).data);
  if (indices.length % 3) throw new Error('Triangle index count must be divisible by 3');
  const generatedNormals = new Float32Array(positions.data.length);
  if (!normals) {
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i], b = indices[i + 1], c = indices[i + 2];
      if (a >= positions.count || b >= positions.count || c >= positions.count)
        throw new Error('Triangle index out of range');
      const p = positions.data, ai = a * 3, bi = b * 3, ci = c * 3;
      const ab = [p[bi] - p[ai], p[bi + 1] - p[ai + 1], p[bi + 2] - p[ai + 2]];
      const ac = [p[ci] - p[ai], p[ci + 1] - p[ai + 1], p[ci + 2] - p[ai + 2]];
      const n = [
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0]
      ];
      for (const vi of [a, b, c]) for (let j = 0; j < 3; j++) generatedNormals[vi * 3 + j] += n[j];
    }
    for (let i = 0; i < generatedNormals.length; i += 3) {
      const mag = Math.hypot(generatedNormals[i], generatedNormals[i + 1], generatedNormals[i + 2]) || 1;
      for (let j = 0; j < 3; j++) generatedNormals[i + j] /= mag;
    }
  }
  const vertices = new Float32Array(positions.count * 8);
  for (let i = 0; i < positions.count; i++) {
    vertices.set(positions.data.subarray(i * 3, i * 3 + 3), i * 8);
    vertices.set((normals?.data ?? generatedNormals).subarray(i * 3, i * 3 + 3), i * 8 + 3);
    if (uvs) vertices.set(uvs.data.subarray(i * 2, i * 2 + 2), i * 8 + 6);
  }
  return { vertices, indices };
}
async function load(gltf, embeddedBinary, baseURL, renderer, scene) {
  if (gltf.asset?.version !== '2.0') throw new Error('Only glTF 2.0 assets are supported');
  const buffers = await Promise.all((gltf.buffers ?? []).map(async (buffer, index) => {
    if (buffer.uri) {
      if (!baseURL && !buffer.uri.startsWith('data:'))
        throw new Error('External buffers require a URL-based glTF asset');
      const response = await fetch(new URL(buffer.uri, baseURL ?? location.href));
      if (!response.ok) throw new Error('Failed to download glTF buffer ' + index);
      return response.arrayBuffer();
    }
    if (!embeddedBinary) throw new Error('Missing GLB binary chunk');
    return embeddedBinary;
  }));
  const images = await Promise.all((gltf.images ?? []).map(async image => {
    let blob;
    if (image.bufferView !== undefined) {
      const view = gltf.bufferViews[image.bufferView];
      blob = new Blob([buffers[view.buffer].slice(view.byteOffset ?? 0,
        (view.byteOffset ?? 0) + view.byteLength)], { type: image.mimeType });
    } else if (image.uri) {
      if (!baseURL && !image.uri.startsWith('data:'))
        throw new Error('External textures require a URL-based glTF asset');
      const response = await fetch(new URL(image.uri, baseURL ?? location.href));
      if (!response.ok) throw new Error('Failed to download glTF image');
      blob = await response.blob();
    } else throw new Error('Image has no data');
    return createImageBitmap(blob);
  }));
  const textureCache = new Map();
  const makeTexture = (entry, srgb) => {
    if (!entry) return undefined;
    const index = entry.index, key = index + ':' + srgb;
    if (textureCache.has(key)) return textureCache.get(key);
    const sourceIndex = gltf.textures?.[index]?.source;
    if (sourceIndex === undefined || !images[sourceIndex]) throw new Error('Missing texture ' + index);
    const texture = renderer.textureFromBitmap(images[sourceIndex], srgb);
    textureCache.set(key, texture);
    return texture;
  };
  const materials = (gltf.materials ?? []).map(m => {
    const pbr = m.pbrMetallicRoughness ?? {};
    return {
      baseColor: pbr.baseColorFactor ?? [1, 1, 1, 1],
      metallic: pbr.metallicFactor ?? 1,
      roughness: pbr.roughnessFactor ?? 1,
      occlusionStrength: m.occlusionTexture?.strength ?? 1,
      baseColorTexture: makeTexture(pbr.baseColorTexture, true),
      metallicRoughnessTexture: makeTexture(pbr.metallicRoughnessTexture, false),
      normalTexture: makeTexture(m.normalTexture, false)
    };
  });
  const meshCache = new Map();
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const walk = (nodeIndex, parent, ancestry = new Set()) => {
    if (ancestry.has(nodeIndex)) throw new Error('Cycle in glTF node hierarchy');
    const node = gltf.nodes[nodeIndex];
    if (!node) throw new Error('Invalid glTF node');
    const nextAncestry = new Set(ancestry);
    nextAncestry.add(nodeIndex);
    const local = node.matrix ? new Float32Array(node.matrix)
      : fromTRS(node.translation, node.rotation, node.scale);
    const world = multiply(parent, local);
    if (node.mesh !== undefined) {
      const mesh = gltf.meshes[node.mesh];
      if (!mesh) throw new Error('Invalid glTF mesh');
      for (let index = 0; index < mesh.primitives.length; index++) {
        const primitive = mesh.primitives[index];
        const key = node.mesh + ':' + index;
        let entry = meshCache.get(key);
        if (!entry) {
          const raw = geometryFromPrimitive(gltf, buffers, primitive);
          entry = { raw, gpu: renderer.geometry(raw) };
          meshCache.set(key, entry);
        }
        scene.add(entry.gpu, materials[primitive.material] ?? {}, { matrix: world });
        const raw = entry.raw.vertices;
        for (let i = 0; i < raw.length; i += 8) {
          const x = raw[i], y = raw[i + 1], z = raw[i + 2];
          const p = [
            world[0] * x + world[4] * y + world[8] * z + world[12],
            world[1] * x + world[5] * y + world[9] * z + world[13],
            world[2] * x + world[6] * y + world[10] * z + world[14]
          ];
          for (let j = 0; j < 3; j++) {
            bounds.min[j] = Math.min(bounds.min[j], p[j]);
            bounds.max[j] = Math.max(bounds.max[j], p[j]);
          }
        }
      }
    }
    for (const child of node.children ?? []) walk(child, world, nextAncestry);
  };
  const roots = gltf.scenes?.[gltf.scene ?? 0]?.nodes ?? [];
  for (const nodeIndex of roots) walk(nodeIndex, identity());
  for (const bitmap of images) bitmap.close();
  if (!scene.objects.length) throw new Error('No triangle meshes found in glTF scene');
  const center = bounds.min.map((x, i) => (x + bounds.max[i]) / 2);
  const extent = Math.max(...bounds.max.map((x, i) => x - bounds.min[i]), 0.1);
  return { count: scene.objects.length, center, recommendedDistance: extent * 1.8 };
}
export async function loadGLB(file, renderer, scene) {
  const { json, binary } = parseGLB(await file.arrayBuffer());
  return load(json, binary, null, renderer, scene);
}
export async function loadGLTF(url, renderer, scene) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Failed to download glTF: HTTP ' + response.status);
  const bytes = await response.arrayBuffer();
  if (new DataView(bytes).getUint32(0, true) === 0x46546c67) {
    const { json, binary } = parseGLB(bytes);
    return load(json, binary, url, renderer, scene);
  }
  return load(JSON.parse(new TextDecoder().decode(bytes)), null, url, renderer, scene);
}
