const PI: f32 = 3.14159265359;

struct Frame {
  viewProjection: mat4x4<f32>,
  lightProjections: array<mat4x4<f32>, 3>,
  cameraPosition: vec4<f32>,
  cameraForward: vec4<f32>,
  sunDirection: vec4<f32>,
  sunColor: vec4<f32>,
  ambient: vec4<f32>,
  shadowSplits: vec4<f32>,
};
struct Object {
  model: mat4x4<f32>,
  normalMatrix: mat4x4<f32>,
  baseColor: vec4<f32>,
  material: vec4<f32>,
};
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var shadowMap: texture_depth_2d_array;
@group(0) @binding(2) var shadowSampler: sampler_comparison;
@group(0) @binding(3) var diffuseIrradiance: texture_cube<f32>;
@group(0) @binding(4) var specularEnvironment: texture_cube<f32>;
@group(0) @binding(5) var integratedBRDF: texture_2d<f32>;
@group(0) @binding(6) var environmentSampler: sampler;
const MAX_POINT_LIGHTS: u32 = 16u;
struct PointLight {
  positionRange: vec4<f32>,
  colorIntensity: vec4<f32>,
};
struct PointLights {
  header: vec4<u32>,
  items: array<PointLight, 16>,
};
@group(0) @binding(7) var<storage, read> lightBuffer: PointLights;
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
  // Shadow UV is chosen per fragment from camera depth and cascade matrix.
};
@vertex
fn vsMain(input: VertexIn) -> VertexOut {
  var out: VertexOut;
  let world = object.model * vec4<f32>(input.position, 1.0);
  out.position = world.xyz;
  out.normal = normalize((object.normalMatrix * vec4<f32>(input.normal, 0.0)).xyz);
  out.uv = input.uv;
  out.clipPosition = frame.viewProjection * world;
  return out;
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
fn visibility(worldPos: vec3<f32>, nDotL: f32) -> f32 {
  let viewDepth = dot(worldPos - frame.cameraPosition.xyz, frame.cameraForward.xyz);
  if (viewDepth <= 0.0 || viewDepth > frame.shadowSplits.z) {
    return 1.0;
  }
  var layer: i32 = 0;
  if (viewDepth > frame.shadowSplits.x) { layer = 1; }
  if (viewDepth > frame.shadowSplits.y) { layer = 2; }
  let lightClip = frame.lightProjections[u32(layer)] * vec4<f32>(worldPos, 1.0);
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
        uv + vec2<f32>(f32(x), f32(y)) * texel, layer, ndc.z - bias);
    }
  }
  return total / 9.0;
}
struct PBRResult {
  @location(0) radiance: vec4<f32>,
  @location(1) normalDepth: vec4<f32>,
};
fn brdfContribution(N: vec3<f32>, V: vec3<f32>, L: vec3<f32>,
                    base: vec3<f32>, f0: vec3<f32>,
                    metallic: f32, roughness: f32) -> vec3<f32> {
  let nDotL = max(dot(N, L), 0.0);
  if (nDotL <= 0.0) { return vec3<f32>(0.0); }
  let H = normalize(V + L);
  let nDotV = max(dot(N, V), 0.0001);
  let nDotH = saturate(dot(N, H));
  let hDotV = saturate(dot(H, V));
  let F = fresnelSchlick(hDotV, f0);
  let D = distributionGGX(nDotH, roughness);
  let G = geometrySchlickGGX(nDotV, roughness) * geometrySchlickGGX(nDotL, roughness);
  let specular = D * G * F / max(4.0 * nDotV * nDotL, 0.0001);
  let diffuse = (vec3<f32>(1.0) - F) * (1.0 - metallic) * base / PI;
  return (diffuse + specular) * nDotL;
}
@fragment
fn fsMain(input: VertexOut, @builtin(front_facing) frontFace: bool) -> PBRResult {
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
  let nDotV = max(dot(N, V), 0.0001);
  let f0 = mix(vec3<f32>(0.04), base, metallic);
  let sunL = normalize(frame.sunDirection.xyz);
  var direct = brdfContribution(N, V, sunL, base, f0, metallic, roughness) *
    frame.sunColor.rgb * frame.sunColor.a *
    visibility(input.position, saturate(dot(N, sunL)));

  // Local unshadowed punctual lights, range-gated inverse-square intensity.
  // The fixed storage array avoids rebuilding render pipelines when lights change.
  for (var i: u32 = 0u; i < min(lightBuffer.header.x, MAX_POINT_LIGHTS); i += 1u) {
    let light = lightBuffer.items[i];
    let toLight = light.positionRange.xyz - input.position;
    let distanceSquared = max(dot(toLight, toLight), 0.01);
    let dist = sqrt(distanceSquared);
    let radius = light.positionRange.w;
    if (dist >= radius) { continue; }
    let direction = toLight / dist;
    let rangeFactor = saturate(1.0 - pow(dist / radius, 4.0));
    let attenuation = rangeFactor * rangeFactor / distanceSquared;
    let irradiance = light.colorIntensity.rgb * light.colorIntensity.a * attenuation;
    direct += brdfContribution(N, V, direction, base, f0, metallic, roughness) * irradiance;
  }

  // Physically-based image-based lighting, generated from a linear-HDR cubemap.
  // Diffuse cube stores integral(L * cosTheta); divide by PI for Lambertian BRDF.
  let irradiance = textureSampleLevel(diffuseIrradiance, environmentSampler, N, 0.0).rgb;
  let ambientDiffuse = (vec3<f32>(1.0) - fresnelSchlick(nDotV, f0)) *
                       (1.0 - metallic) * base * irradiance / PI;
  let R = reflect(-V, N);
  let reflected = textureSampleLevel(specularEnvironment, environmentSampler, R,
                                    roughness * 5.0).rgb;
  let brdf = textureSampleLevel(integratedBRDF, environmentSampler,
                               vec2<f32>(nDotV, roughness), 0.0).rg;
  let ambientSpecular = reflected * (f0 * brdf.x + vec3<f32>(brdf.y));
  let radiance = direct + (ambientDiffuse + ambientSpecular) * ao;
  var result: PBRResult;
  result.radiance = vec4<f32>(radiance, 1.0);
  result.normalDepth = vec4<f32>(N * 0.5 + vec3<f32>(0.5),
    max(dot(input.position - frame.cameraPosition.xyz, frame.cameraForward.xyz), 0.0));
  return result;
}
