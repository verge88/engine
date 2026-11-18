// Procedural linear-HDR cubemap. Authored as a compute pass so the same sky
// powers the visible background, irradiance and reflection prefiltering.
struct Sky {
  sun: vec4<f32>,
  tint: vec4<f32>,
};
@group(0) @binding(0) var<uniform> sky: Sky;
@group(0) @binding(1) var outputCube: texture_storage_2d_array<rgba16float, write>;

fn cubeDirection(face: u32, uv: vec2<f32>) -> vec3<f32> {
  let u = uv.x;
  let v = uv.y;
  switch face {
    case 0u: { return normalize(vec3<f32>( 1.0, -v, -u)); }
    case 1u: { return normalize(vec3<f32>(-1.0, -v,  u)); }
    case 2u: { return normalize(vec3<f32>( u,  1.0,  v)); }
    case 3u: { return normalize(vec3<f32>( u, -1.0, -v)); }
    case 4u: { return normalize(vec3<f32>( u, -v,  1.0)); }
    default: { return normalize(vec3<f32>(-u, -v, -1.0)); }
  }
}
fn skyRadiance(dir: vec3<f32>) -> vec3<f32> {
  let above = smoothstep(-0.06, 0.2, dir.y);
  let horizon = exp(-abs(dir.y) * 8.0);
  let daylight = smoothstep(-0.15, 0.3, sky.sun.y);
  let zenith = mix(vec3<f32>(0.005, 0.009, 0.025),
                   vec3<f32>(0.23, 0.41, 0.75), daylight);
  let atmosphere = mix(vec3<f32>(0.045, 0.057, 0.075),
                       zenith * (0.45 + 0.55 * pow(max(dir.y, 0.0), 0.42)),
                       above);
  let sunset = vec3<f32>(0.95, 0.27, 0.055) *
               horizon * (1.0 - daylight * 0.7);
  let litHorizon = vec3<f32>(0.31, 0.39, 0.50) * horizon * daylight * 0.7;
  let cosSun = dot(normalize(dir), normalize(sky.sun.xyz));
  let glow = pow(max(cosSun, 0.0), 128.0) * 1.4;
  let disk = smoothstep(0.99986, 0.99995, cosSun) * 26.0;
  let sunTint = mix(vec3<f32>(1.0, 0.38, 0.12), vec3<f32>(1.0, 0.94, 0.83), daylight);
  return max(atmosphere + sunset + litHorizon + (glow + disk) * sunTint,
             vec3<f32>(0.0)) * sky.tint.rgb;
}
@compute @workgroup_size(8, 8, 1)
fn csSky(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dim = textureDimensions(outputCube);
  if (gid.x >= dim.x || gid.y >= dim.y || gid.z >= 6u) { return; }
  let uv = 2.0 * (vec2<f32>(gid.xy) + vec2<f32>(0.5)) /
           vec2<f32>(dim) - vec2<f32>(1.0);
  let direction = cubeDirection(gid.z, uv);
  textureStore(outputCube, vec2<i32>(gid.xy), i32(gid.z),
               vec4<f32>(skyRadiance(direction), 1.0));
}
