// Independent shadow pipeline: each cascade reads its own light VP uniform.
// The depth-array resource is deliberately NOT sampled in this pass.
struct Object {
  model: mat4x4<f32>,
  normalMatrix: mat4x4<f32>,
  baseColor: vec4<f32>,
  material: vec4<f32>,
};
@group(0) @binding(0) var<uniform> lightProjection: mat4x4<f32>;
@group(1) @binding(0) var<uniform> object: Object;
@vertex
fn vsShadow(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> {
  return lightProjection * object.model * vec4<f32>(position, 1.0);
}
