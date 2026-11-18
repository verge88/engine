// HDR presentation: equirect/cubemap sky + bloom + optional screen-space effects.
struct Settings {
  controls: vec4<f32>, // exposure, bloom strength, bloom threshold, aspect
  right: vec4<f32>,
  up: vec4<f32>,
  forward: vec4<f32>,
  camera: vec4<f32>,
  effects: vec4<f32>, // AO strength, bounce strength, SSR strength, kernel radius
};
@group(0) @binding(0) var hdr: texture_2d<f32>;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var<uniform> settings: Settings;
@group(0) @binding(3) var sky: texture_cube<f32>;
@group(0) @binding(4) var bloom: texture_2d<f32>;
@group(0) @binding(5) var indirect: texture_2d<f32>;
@group(0) @binding(6) var reflections: texture_2d<f32>;

struct VSOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@vertex
fn vsPost(@builtin(vertex_index) index: u32) -> VSOut {
  let corners = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0)
  );
  let p = corners[index];
  var out: VSOut;
  out.position = vec4<f32>(p, 0.0, 1.0);
  out.uv = vec2<f32>((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
  return out;
}
fn skyDirection(uv: vec2<f32>) -> vec3<f32> {
  let x = uv.x * 2.0 - 1.0;
  let y = 1.0 - uv.y * 2.0;
  const tanHalfFov: f32 = 0.57735026919;
  return normalize(settings.forward.xyz +
    x * tanHalfFov * settings.controls.w * settings.right.xyz +
    y * tanHalfFov * settings.up.xyz);
}
fn aces(c: vec3<f32>) -> vec3<f32> {
  return clamp((c * (2.51 * c + vec3<f32>(0.03))) /
    (c * (2.43 * c + vec3<f32>(0.59)) + vec3<f32>(0.14)),
    vec3<f32>(0.0), vec3<f32>(1.0));
}
fn linearToSRGB(c: vec3<f32>) -> vec3<f32> {
  return select(c * 12.92, 1.055 * pow(c, vec3<f32>(1.0 / 2.4)) -
                vec3<f32>(0.055), c > vec3<f32>(0.0031308));
}
@fragment
fn fsPost(input: VSOut) -> @location(0) vec4<f32> {
  let source = textureSample(hdr, linearSampler, input.uv);
  let background = textureSampleLevel(sky, linearSampler, skyDirection(input.uv), 0.0).rgb;
  var radiance = mix(background, source.rgb, clamp(source.a, 0.0, 1.0));
  if (source.a > 0.5) {
    // Screen-space AO darkens existing lighting; optional color bounce simulates
    // a *single visible-space* indirect pass, not true world-space GI.
    let gi = textureSample(indirect, linearSampler, input.uv);
    let reflectionSample = textureSample(reflections, linearSampler, input.uv);
    let ao = clamp(gi.a * settings.effects.x, 0.0, 0.7);
    radiance = radiance * (1.0 - ao * 0.75);
    radiance += gi.rgb * settings.effects.y * 2.0;
    radiance += reflectionSample.rgb * reflectionSample.a * settings.effects.z * 0.22;
  }
  let glow = textureSample(bloom, linearSampler, input.uv).rgb * settings.controls.y;
  let mapped = aces(max(radiance + glow, vec3<f32>(0.0)) * settings.controls.x);
  return vec4<f32>(linearToSRGB(mapped), 1.0);
}
