// Split-sum IBL: cosine-weighted irradiance and GGX-prefiltered reflections.
// One output 2D-array texture view per mip; all samples read an independent sky cube.
const PI: f32 = 3.141592653589793;
struct Config {
  roughness: f32,
  count: u32,
  pad0: u32,
  pad1: u32,
};
@group(0) @binding(0) var<uniform> config: Config;
@group(0) @binding(1) var environment: texture_cube<f32>;
@group(0) @binding(2) var envSampler: sampler;
@group(0) @binding(3) var outputCube: texture_storage_2d_array<rgba16float, write>;

fn cubeDirection(face: u32, uv: vec2<f32>) -> vec3<f32> {
  let u = uv.x; let v = uv.y;
  switch face {
    case 0u: { return normalize(vec3<f32>( 1.0, -v, -u)); }
    case 1u: { return normalize(vec3<f32>(-1.0, -v,  u)); }
    case 2u: { return normalize(vec3<f32>( u,  1.0,  v)); }
    case 3u: { return normalize(vec3<f32>( u, -1.0, -v)); }
    case 4u: { return normalize(vec3<f32>( u, -v,  1.0)); }
    default: { return normalize(vec3<f32>(-u, -v, -1.0)); }
  }
}
fn radicalInverse(input: u32) -> f32 {
  var bits = input;
  bits = (bits << 16u) | (bits >> 16u);
  bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
  bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
  bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
  bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
  return f32(bits) * 2.3283064365386963e-10;
}
fn hammersley(i: u32, samples: u32) -> vec2<f32> {
  return vec2<f32>(f32(i) / f32(samples), radicalInverse(i));
}
fn basis(n: vec3<f32>) -> mat3x3<f32> {
  let up = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(0.0, 0.0, 1.0), abs(n.y) > 0.99);
  let t = normalize(cross(up, n));
  let b = cross(n, t);
  return mat3x3<f32>(t, b, n);
}
fn importanceGGX(xi: vec2<f32>, roughness: f32) -> vec3<f32> {
  let a = roughness * roughness;
  let phi = 2.0 * PI * xi.x;
  let cosTheta = sqrt((1.0 - xi.y) / max(1.0 + (a * a - 1.0) * xi.y, 0.0001));
  let sinTheta = sqrt(max(1.0 - cosTheta * cosTheta, 0.0));
  return vec3<f32>(sinTheta * cos(phi), sinTheta * sin(phi), cosTheta);
}
@compute @workgroup_size(8, 8, 1)
fn csIrradiance(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dim = textureDimensions(outputCube);
  if (gid.x >= dim.x || gid.y >= dim.y || gid.z >= 6u) { return; }
  let uv = 2.0 * (vec2<f32>(gid.xy) + vec2<f32>(0.5)) /
           vec2<f32>(dim) - vec2<f32>(1.0);
  let N = cubeDirection(gid.z, uv);
  let tbn = basis(N);
  var total = vec3<f32>(0.0);
  for (var i = 0u; i < config.count; i = i + 1u) {
    let xi = hammersley(i, config.count);
    let phi = 2.0 * PI * xi.x;
    let cosTheta = sqrt(1.0 - xi.y);
    let sinTheta = sqrt(xi.y);
    let local = vec3<f32>(cos(phi) * sinTheta, sin(phi) * sinTheta, cosTheta);
    let world = tbn * local;
    total += textureSampleLevel(environment, envSampler, world, 0.0).rgb;
  }
  // Lambertian E = PI * mean(L) when sampling with cosine-weighted PDF.
  let irradiance = PI * total / f32(config.count);
  textureStore(outputCube, vec2<i32>(gid.xy), i32(gid.z), vec4<f32>(irradiance, 1.0));
}
@compute @workgroup_size(8, 8, 1)
fn csSpecular(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dim = textureDimensions(outputCube);
  if (gid.x >= dim.x || gid.y >= dim.y || gid.z >= 6u) { return; }
  let uv = 2.0 * (vec2<f32>(gid.xy) + vec2<f32>(0.5)) /
           vec2<f32>(dim) - vec2<f32>(1.0);
  let N = cubeDirection(gid.z, uv);
  // For prefiltered reflection, assume N = V = R.
  if (config.roughness < 0.001) {
    textureStore(outputCube, vec2<i32>(gid.xy), i32(gid.z),
      textureSampleLevel(environment, envSampler, N, 0.0));
    return;
  }
  let tbn = basis(N);
  var total = vec3<f32>(0.0);
  var weight = 0.0;
  for (var i = 0u; i < config.count; i = i + 1u) {
    let H = normalize(tbn * importanceGGX(hammersley(i, config.count), config.roughness));
    let L = normalize(2.0 * dot(N, H) * H - N);
    let nDotL = max(dot(N, L), 0.0);
    if (nDotL > 0.0) {
      total += textureSampleLevel(environment, envSampler, L, 0.0).rgb * nDotL;
      weight += nDotL;
    }
  }
  textureStore(outputCube, vec2<i32>(gid.xy), i32(gid.z),
               vec4<f32>(total / max(weight, 0.0001), 1.0));
}
