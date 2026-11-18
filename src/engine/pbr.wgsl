const PI: f32 = 3.14159265359;

struct Frame {
  viewProjection: mat4x4<f32>,
  lightProjection: mat4x4<f32>,
  cameraPosition: vec4<f32>,
  sunDirection: vec4<f32>,
  sunColor: vec4<f32>,
  ambient: vec4<f32>,
};
struct Object {
  model: mat4x4<f32>,
  normalMatrix: mat4x4<f32>,
  baseColor: vec4<f32>,
  material: vec4<f32>,
};
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var shadowMap: texture_depth_2d;
@group(0) @binding(2) var shadowSampler: sampler_comparison;
@group(1) @binding(0) var<uniform> object: Object;
@group(1) @binding(1) var colorTexture: texture_2d<f32>;
@group(1) @binding(2) var normalTexture: texture_2d<f32>;
@group(1) @binding(3) var ormTexture: texture_2d<f32>;
@group(1) @binding(4) var surfaceSampler: sampler;

struct VertexIn {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
};
struct VertexOut {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) lightClip: vec4<f32>,
};
@vertex
fn vsMain(input: VertexIn) -> VertexOut {
  var out: VertexOut;
  let world = object.model * vec4<f32>(input.position, 1.0);
  out.position = world.xyz;
  out.normal = normalize((object.normalMatrix * vec4<f32>(input.normal, 0.0)).xyz);
  out.uv = input.uv;
  out.clipPosition = frame.viewProjection * world;
  out.lightClip = frame.lightProjection * world;
  return out;
}
@vertex
fn vsShadow(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> {
  return frame.lightProjection * object.model * vec4<f32>(position, 1.0);
}
fn saturate(x: f32) -> f32 { return clamp(x, 0.0, 1.0); }
fn fresnelSchlick(cosTheta: f32, f0: vec3<f32>) -> vec3<f32> {
  return f0 + (vec3<f32>(1.0) - f0) * pow(1.0 - saturate(cosTheta), 5.0);
}
fn distributionGGX(nDotH: f32, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let a2 = a * a;
  let denom = nDotH * nDotH * (a2 - 1.0) + 1.0;
  return a2 / max(PI * denom * denom, 0.00001);
}
fn geometrySchlickGGX(nDotV: f32, roughness: f32) -> f32 {
  let r = roughness + 1.0;
  let k = r * r / 8.0;
  return nDotV / max(nDotV * (1.0 - k) + k, 0.00001);
}
fn visibility(lightClip: vec4<f32>, nDotL: f32) -> f32 {
  let ndc = lightClip.xyz / lightClip.w;
  let uv = vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  if (ndc.z <= 0.0 || ndc.z >= 1.0 ||
      uv.x <= 0.0 || uv.x >= 1.0 || uv.y <= 0.0 || uv.y >= 1.0) {
    return 1.0;
  }
  let texel = 1.0 / vec2<f32>(textureDimensions(shadowMap));
  let bias = max(0.00035 * (1.0 - nDotL), 0.00008);
  var total = 0.0;
  for (var y: i32 = -1; y <= 1; y = y + 1) {
    for (var x: i32 = -1; x <= 1; x = x + 1) {
      total += textureSampleCompareLevel(shadowMap, shadowSampler,
        uv + vec2<f32>(f32(x), f32(y)) * texel, ndc.z - bias);
    }
  }
  return total / 9.0;
}
@fragment
fn fsMain(input: VertexOut, @builtin(front_facing) frontFace: bool) -> @location(0) vec4<f32> {
  let base = textureSample(colorTexture, surfaceSampler, input.uv).rgb * object.baseColor.rgb;
  let packed = textureSample(ormTexture, surfaceSampler, input.uv).rgb;
  let metallic = saturate(object.material.x * packed.b);
  let roughness = clamp(object.material.y * packed.g, 0.055, 1.0);
  let ao = mix(1.0, packed.r, saturate(object.material.z));

  var N = normalize(input.normal);
  if (!frontFace) { N = -N; }
  let tangentNormal = textureSample(normalTexture, surfaceSampler, input.uv).xyz * 2.0 - 1.0;
  let dp1 = dpdx(input.position);
  let dp2 = dpdy(input.position);
  let duv1 = dpdx(input.uv);
  let duv2 = dpdy(input.uv);
  let det = duv1.x * duv2.y - duv1.y * duv2.x;
  if (abs(det) > 0.000001) {
    let T = normalize((dp1 * duv2.y - dp2 * duv1.y) / det);
    let tangent = normalize(T - N * dot(N, T));
    let bitangent = cross(N, tangent) * sign(det);
    N = normalize(tangent * tangentNormal.x + bitangent * tangentNormal.y + N * tangentNormal.z);
  }
  let V = normalize(frame.cameraPosition.xyz - input.position);
  let L = normalize(frame.sunDirection.xyz);
  let H = normalize(V + L);
  let nDotV = max(dot(N, V), 0.0001);
  let nDotL = max(dot(N, L), 0.0);
  let nDotH = saturate(dot(N, H));
  let hDotV = saturate(dot(H, V));

  let f0 = mix(vec3<f32>(0.04), base, metallic);
  let F = fresnelSchlick(hDotV, f0);
  let D = distributionGGX(nDotH, roughness);
  let G = geometrySchlickGGX(nDotV, roughness) * geometrySchlickGGX(nDotL, roughness);
  let specular = D * G * F / max(4.0 * nDotV * nDotL, 0.0001);
  let diffuse = (vec3<f32>(1.0) - F) * (1.0 - metallic) * base / PI;
  let direct = (diffuse + specular) * frame.sunColor.rgb * frame.sunColor.a *
                nDotL * visibility(input.lightClip, nDotL);

  // Low-cost sky/ground fill and approximated environment reflections.
  // Replace with prefiltered IBL probes for truly photoreal materials.
  let sky = vec3<f32>(0.24, 0.38, 0.60);
  let ground = vec3<f32>(0.10, 0.085, 0.07);
  let irradiance = mix(ground, sky, saturate(N.y * 0.5 + 0.5));
  let ambientDiffuse = irradiance * base * (1.0 - metallic) * 0.42;
  let R = reflect(-V, N);
  let reflectedSky = mix(ground, sky, saturate(R.y * 0.5 + 0.5));
  let ambientSpecular = reflectedSky * fresnelSchlick(nDotV, f0) *
                        (1.0 - 0.8 * roughness) * 0.85;
  let radiance = direct + (ambientDiffuse + ambientSpecular) * ao;
  return vec4<f32>(radiance, 1.0);
}
