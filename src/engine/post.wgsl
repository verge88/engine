struct Tonemap { exposure: f32, padding: vec3<f32> };
@group(0) @binding(0) var hdr: texture_2d<f32>;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var<uniform> settings: Tonemap;
struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@vertex
fn vsPost(@builtin(vertex_index) index: u32) -> VertexOut {
  let corners = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0)
  );
  var out: VertexOut;
  let p = corners[index];
  out.position = vec4<f32>(p, 0.0, 1.0);
  out.uv = vec2<f32>((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
  return out;
}
fn aces(c: vec3<f32>) -> vec3<f32> {
  return clamp((c * (2.51 * c + vec3<f32>(0.03))) /
    (c * (2.43 * c + vec3<f32>(0.59)) + vec3<f32>(0.14)),
    vec3<f32>(0.0), vec3<f32>(1.0));
}
@fragment
fn fsPost(input: VertexOut) -> @location(0) vec4<f32> {
  let source = textureSample(hdr, linearSampler, input.uv);
  let sky = mix(vec3<f32>(0.42, 0.57, 0.76), vec3<f32>(0.013, 0.032, 0.09),
                pow(1.0 - input.uv.y, 1.8));
  let linear = mix(sky, source.rgb, source.a) * settings.exposure;
  let mapped = aces(linear);
  let srgb = select(12.92 * mapped, 1.055 * pow(mapped, vec3<f32>(1.0 / 2.4)) - vec3<f32>(0.055),
                    mapped > vec3<f32>(0.0031308));
  return vec4<f32>(srgb, 1.0);
}
