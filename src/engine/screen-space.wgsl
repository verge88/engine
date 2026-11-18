// Experimental screen-space passes. They see only geometry visible in this frame.
// Both passes read the completed main HDR/G-buffer attachments; never sample a
// texture while it is attached for writing.
const PI: f32 = 3.141592653589793;
const TAN_FOV: f32 = 0.5773502691896257; // same camera 60-degree vertical FOV
struct Settings {
  controls: vec4<f32>, // exposure,bloomStrength,bloomThreshold,aspect
  right: vec4<f32>,
  up: vec4<f32>,
  forward: vec4<f32>,
  camera: vec4<f32>,
  effects: vec4<f32>, // AO, bounced color, SSR, radius in screen pixels
};
@group(0) @binding(0) var sceneColor: texture_2d<f32>;
@group(0) @binding(1) var normalDepth: texture_2d<f32>;
@group(0) @binding(2) var linearSampler: sampler;
@group(0) @binding(3) var<uniform> params: Settings;

struct VSOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@vertex
fn vsFull(@builtin(vertex_index) index: u32) -> VSOut {
  let corners = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0)
  );
  let xy = corners[index];
  var out: VSOut;
  out.position = vec4<f32>(xy, 0.0, 1.0);
  out.uv = vec2<f32>((xy.x + 1.0) * 0.5, (1.0 - xy.y) * 0.5);
  return out;
}
fn inViewport(uv: vec2<f32>) -> bool {
  return all(uv > vec2<f32>(0.002)) && all(uv < vec2<f32>(0.998));
}
fn normalFromGBuffer(sample: vec4<f32>) -> vec3<f32> {
  return normalize(sample.rgb * 2.0 - vec3<f32>(1.0));
}
fn positionFromDepth(uv: vec2<f32>, viewDepth: f32) -> vec3<f32> {
  let ndc = vec2<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  return params.camera.xyz + viewDepth * (
    params.forward.xyz + ndc.x * TAN_FOV * params.controls.w * params.right.xyz +
    ndc.y * TAN_FOV * params.up.xyz);
}
fn projectToUV(point: vec3<f32>) -> vec3<f32> {
  let relative = point - params.camera.xyz;
  let z = dot(relative, params.forward.xyz);
  if (z < 0.08) { return vec3<f32>(-1.0, -1.0, z); }
  let x = dot(relative, params.right.xyz) / (z * TAN_FOV * params.controls.w);
  let y = dot(relative, params.up.xyz) / (z * TAN_FOV);
  return vec3<f32>(x * 0.5 + 0.5, 0.5 - y * 0.5, z);
}

// Single-bounce approximation: 16 spatial taps in the visible scene.
// Returned alpha is the screen-space occlusion estimate.
@fragment
fn fsIndirect(input: VSOut) -> @location(0) vec4<f32> {
  if (params.effects.x <= 0.0 && params.effects.y <= 0.0) {
    return vec4<f32>(0.0);
  }
  let center = textureSampleLevel(normalDepth, linearSampler, input.uv, 0.0);
  if (center.a <= 0.0) { return vec4<f32>(0.0); }
  let N = normalFromGBuffer(center);
  let P = positionFromDepth(input.uv, center.a);
  let pixelSize = 1.0 / vec2<f32>(textureDimensions(normalDepth));
  var bleed = vec3<f32>(0.0);
  var occlusion = 0.0;

  for (var i: u32 = 0u; i < 16u; i += 1u) {
    let t = (f32(i) + 0.5) / 16.0;
    let angle = f32(i) * 2.3999632297;
    let radius = sqrt(t) * params.effects.w;
    let uv = input.uv + vec2<f32>(cos(angle), sin(angle)) * radius * pixelSize;
    if (!inViewport(uv)) { continue; }
    let neighbor = textureSampleLevel(normalDepth, linearSampler, uv, 0.0);
    if (neighbor.a <= 0.0) { continue; }
    let Q = positionFromDepth(uv, neighbor.a);
    let d = Q - P;
    let distanceToSample = length(d);
    if (distanceToSample < 0.05 || distanceToSample > 5.0) { continue; }
    let direction = d / distanceToSample;
    let normalFacing = max(dot(N, direction), 0.0);
    let sourceFacing = max(dot(normalFromGBuffer(neighbor), -direction), 0.0);
    let falloff = 1.0 / (1.0 + distanceToSample * distanceToSample);
    let weight = normalFacing * sourceFacing * falloff;
    let sourceColor = textureSampleLevel(sceneColor, linearSampler, uv, 0.0).rgb;
    bleed += min(sourceColor, vec3<f32>(10.0)) * weight;
    if (neighbor.a + 0.12 < center.a && abs(neighbor.a - center.a) < 3.0) {
      occlusion += (1.0 - smoothstep(0.0, 3.0, distanceToSample)) * 0.0625;
    }
  }
  let indirect = bleed / 16.0;
  return vec4<f32>(indirect, clamp(occlusion, 0.0, 1.0));
}

// Experimental ray marching in the currently visible HDR scene. No temporal
// accumulation, offscreen geometry or true rough-reflection filtering yet.
@fragment
fn fsReflection(input: VSOut) -> @location(0) vec4<f32> {
  if (params.effects.z <= 0.0) { return vec4<f32>(0.0); }
  let surface = textureSampleLevel(normalDepth, linearSampler, input.uv, 0.0);
  if (surface.a <= 0.0) { return vec4<f32>(0.0); }
  let P = positionFromDepth(input.uv, surface.a);
  let N = normalFromGBuffer(surface);
  let towardsEye = normalize(params.camera.xyz - P);
  let direction = normalize(reflect(-towardsEye, N));
  if (dot(direction, params.forward.xyz) < -0.85) { return vec4<f32>(0.0); }
  let bias = N * 0.07;
  let stepSize = clamp(surface.a * 0.028, 0.15, 0.7);
  var found = vec4<f32>(0.0);
  for (var i: u32 = 1u; i <= 32u; i += 1u) {
    let rayPoint = P + bias + direction * (f32(i) * stepSize);
    let projected = projectToUV(rayPoint);
    let uv = projected.xy;
    if (!inViewport(uv)) { break; }
    let candidate = textureSampleLevel(normalDepth, linearSampler, uv, 0.0);
    if (candidate.a <= 0.0) { continue; }
    let difference = projected.z - candidate.a;
    if (difference >= 0.0 && difference < stepSize * 1.8 + 0.08) {
      let color = textureSampleLevel(sceneColor, linearSampler, uv, 0.0).rgb;
      let edge = min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y));
      let confidence = smoothstep(0.005, 0.12, edge) *
        (1.0 - f32(i) / 36.0) * smoothstep(0.02, 0.24, f32(i) * stepSize);
      found = vec4<f32>(min(color, vec3<f32>(20.0)), max(confidence, 0.0));
      break;
    }
  }
  return found;
}
