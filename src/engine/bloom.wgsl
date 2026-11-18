// Half-resolution bright pass + two separable Gaussian blur passes.
struct PostSettings {
  controls: vec4<f32>,  // exposure, bloom strength, bloom threshold, aspect ratio
  right: vec4<f32>,
  up: vec4<f32>,
  forward: vec4<f32>,
};
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var<uniform> settings: PostSettings;
@group(0) @binding(3) var sky: texture_cube<f32>;
struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@vertex
fn vsFullscreen(@builtin(vertex_index) index: u32) -> VertexOut {
  let corners = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0)
  );
  var out: VertexOut;
  let p = corners[index];
  out.position = vec4<f32>(p, 0.0, 1.0);
  out.uv = vec2<f32>((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
  return out;
}
fn rayForUV(uv: vec2<f32>) -> vec3<f32> {
  const tanHalfFov: f32 = 0.57735026919;
  let xy = vec2<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  return normalize(settings.forward.xyz +
    xy.x * tanHalfFov * settings.controls.w * settings.right.xyz +
    xy.y * tanHalfFov * settings.up.xyz);
}
@fragment
fn fsExtract(input: VertexOut) -> @location(0) vec4<f32> {
  let pixel = textureSample(source, linearSampler, input.uv);
  let background = textureSampleLevel(sky, linearSampler, rayForUV(input.uv), 0.0).rgb;
  let radiance = mix(background, pixel.rgb, clamp(pixel.a, 0.0, 1.0));
  let peak = max(max(radiance.r, radiance.g), radiance.b);
  let weight = smoothstep(settings.controls.z, settings.controls.z + 1.0, peak);
  return vec4<f32>(radiance * weight, 1.0);
}
fn gaussian(uv: vec2<f32>, stepVector: vec2<f32>) -> vec3<f32> {
  var color = textureSample(source, linearSampler, uv).rgb * 0.227027;
  color += textureSample(source, linearSampler, uv + 1.384615 * stepVector).rgb * 0.316216;
  color += textureSample(source, linearSampler, uv - 1.384615 * stepVector).rgb * 0.316216;
  color += textureSample(source, linearSampler, uv + 3.230769 * stepVector).rgb * 0.070270;
  color += textureSample(source, linearSampler, uv - 3.230769 * stepVector).rgb * 0.070270;
  return color;
}
@fragment
fn fsBlurH(input: VertexOut) -> @location(0) vec4<f32> {
  let size = vec2<f32>(textureDimensions(source));
  return vec4<f32>(gaussian(input.uv, vec2<f32>(1.0 / size.x, 0.0)), 1.0);
}
@fragment
fn fsBlurV(input: VertexOut) -> @location(0) vec4<f32> {
  let size = vec2<f32>(textureDimensions(source));
  return vec4<f32>(gaussian(input.uv, vec2<f32>(0.0, 1.0 / size.y)), 1.0);
}
