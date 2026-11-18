// Environment BRDF integration LUT (Epic split-sum approximation).
const PI: f32 = 3.141592653589793;
@group(0) @binding(0) var outputLUT: texture_storage_2d<rgba16float, write>;
fn radicalInverse(input: u32) -> f32 {
  var bits = input;
  bits = (bits << 16u) | (bits >> 16u);
  bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
  bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
  bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
  bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
  return f32(bits) * 2.3283064365386963e-10;
}
fn sampleGGX(xi: vec2<f32>, roughness: f32) -> vec3<f32> {
  let a = roughness * roughness;
  let phi = 2.0 * PI * xi.x;
  let cosTheta = sqrt((1.0 - xi.y) / max(1.0 + (a * a - 1.0) * xi.y, 0.0001));
  let sinTheta = sqrt(max(1.0 - cosTheta * cosTheta, 0.0));
  return vec3<f32>(sinTheta * cos(phi), sinTheta * sin(phi), cosTheta);
}
fn geometrySchlick(nDot: f32, roughness: f32) -> f32 {
  let k = roughness * roughness * 0.5;
  return nDot / max(nDot * (1.0 - k) + k, 0.00001);
}
@compute @workgroup_size(8, 8, 1)
fn csBRDF(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dim = textureDimensions(outputLUT);
  if (gid.x >= dim.x || gid.y >= dim.y) { return; }
  let nDotV = clamp((f32(gid.x) + 0.5) / f32(dim.x), 0.001, 0.999);
  let roughness = max((f32(gid.y) + 0.5) / f32(dim.y), 0.045);
  let V = vec3<f32>(sqrt(1.0 - nDotV * nDotV), 0.0, nDotV);
  var A = 0.0;
  var B = 0.0;
  const COUNT: u32 = 128u;
  for (var i = 0u; i < COUNT; i = i + 1u) {
    let H = sampleGGX(vec2<f32>(f32(i) / f32(COUNT), radicalInverse(i)), roughness);
    let L = normalize(2.0 * dot(V, H) * H - V);
    let nDotL = max(L.z, 0.0);
    let nDotH = max(H.z, 0.0);
    let vDotH = max(dot(V, H), 0.0);
    if (nDotL > 0.0) {
      let G = geometrySchlick(nDotV, roughness) * geometrySchlick(nDotL, roughness);
      let visibility = G * vDotH / max(nDotH * nDotV, 0.0001);
      let Fc = pow(1.0 - vDotH, 5.0);
      A += (1.0 - Fc) * visibility;
      B += Fc * visibility;
    }
  }
  textureStore(outputLUT, vec2<i32>(gid.xy),
    vec4<f32>(A / f32(COUNT), B / f32(COUNT), 0.0, 1.0));
}
