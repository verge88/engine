// Convert an equirectangular linear HDRI to the engine's shared sky cubemap.
const PI: f32 = 3.141592653589793;
@group(0) @binding(0) var hdri: texture_2d<f32>;
@group(0) @binding(1) var hdriSampler: sampler;
@group(0) @binding(2) var outputCube: texture_storage_2d_array<rgba16float, write>;

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
@compute @workgroup_size(8, 8, 1)
fn csEquirect(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dim = textureDimensions(outputCube);
  if (gid.x >= dim.x || gid.y >= dim.y || gid.z >= 6u) { return; }
  let uv = 2.0 * (vec2<f32>(gid.xy) + vec2<f32>(0.5)) /
           vec2<f32>(dim) - vec2<f32>(1.0);
  let dir = cubeDirection(gid.z, uv);
  let longitude = atan2(dir.z, dir.x);
  let latitude = acos(clamp(dir.y, -1.0, 1.0));
  let sourceUV = vec2<f32>(longitude / (2.0 * PI) + 0.5, latitude / PI);
  let radiance = textureSampleLevel(hdri, hdriSampler, sourceUV, 0.0);
  textureStore(outputCube, vec2<i32>(gid.xy), i32(gid.z), radiance);
}
