// Fixed-capacity punctual lights: vec4(position.xyz, radius),
// vec4(linear RGB, intensity) per entry. GPU storage layout: 16-byte header
// followed by 16 * 32-byte entries. No hidden allocations per frame.
export const MAX_POINT_LIGHTS = 16;
export const POINT_LIGHT_BYTES = 16 + MAX_POINT_LIGHTS * 32;

const validVec3 = v => Array.isArray(v) && v.length === 3 &&
  v.every(value => typeof value === 'number' && Number.isFinite(value));

export function createPointLight({
  position = [0, 2, 0], color = [1, 1, 1], intensity = 30, range = 8
} = {}) {
  if (!validVec3(position) || !validVec3(color) || color.some(v => v < 0) ||
      !Number.isFinite(intensity) || intensity < 0 ||
      !Number.isFinite(range) || range <= 0) {
    throw new RangeError('Invalid point light position/color/intensity/range');
  }
  return {
    position: [...position], color: [...color], intensity, range, enabled: true
  };
}
export function packPointLights(lights, maxLights = MAX_POINT_LIGHTS) {
  if (!Array.isArray(lights) || maxLights !== MAX_POINT_LIGHTS)
    throw new TypeError('Expected a light array and the fixed renderer capacity');
  const visible = lights.filter(light => light.enabled !== false).slice(0, MAX_POINT_LIGHTS);
  const array = new ArrayBuffer(POINT_LIGHT_BYTES);
  const view = new DataView(array);
  view.setUint32(0, visible.length, true);
  const floats = new Float32Array(array);
  visible.forEach((light, i) => {
    if (!validVec3(light.position) || !validVec3(light.color) ||
        light.color.some(v => v < 0) || !Number.isFinite(light.intensity) ||
        light.intensity < 0 || !Number.isFinite(light.range) || light.range <= 0) {
      throw new RangeError('Malformed point light at index ' + i);
    }
    const base = 4 + i * 8;
    floats.set([...light.position, light.range], base);
    floats.set([...light.color, light.intensity], base + 4);
  });
  return array;
}
