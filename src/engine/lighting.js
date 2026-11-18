import { clamp, cross, dot, normalize } from './math.js';

export function sunDirectionAtElevation(elevationDegrees, azimuthDegrees = 34) {
  if (!Number.isFinite(elevationDegrees) || !Number.isFinite(azimuthDegrees))
    throw new RangeError('Sun elevation and azimuth must be finite');
  const elevation = clamp(elevationDegrees, 1, 89) * Math.PI / 180;
  const azimuth = azimuthDegrees * Math.PI / 180;
  return [
    Math.cos(elevation) * Math.cos(azimuth),
    Math.sin(elevation),
    Math.cos(elevation) * Math.sin(azimuth)
  ];
}
export function cameraBasis(eye, target) {
  const forward = normalize(target.map((x, i) => x - eye[i]));
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = normalize(cross(right, forward));
  if (forward.length !== 3 || !forward.every(Number.isFinite) ||
      Math.hypot(...forward) < 0.9 || Math.hypot(...right) < 0.9)
    throw new RangeError('Camera eye and target must be finite, distinct and not exactly vertical');
  return { forward, right, up };
}
export function makePostUniform(scene, eye, target, aspect) {
  if (!Number.isFinite(aspect) || aspect <= 0) throw new RangeError('Invalid viewport aspect');
  const { forward, right, up } = cameraBasis(eye, target);
  const exposure = clamp(scene.exposure, 0.05, 10);
  const strength = clamp(scene.bloomStrength, 0, 2);
  const threshold = clamp(scene.bloomThreshold, 0.01, 20);
  return new Float32Array([
    exposure, strength, threshold, aspect,
    ...right, 0, ...up, 0, ...forward, 0
  ]);
}


// Extension of the 64-byte v0.3 uniform, retaining the first four vec4 slots
// for the existing bloom shader (controls + camera orientation).
export function makeScreenUniform(scene, eye, target, aspect) {
  const prefix = makePostUniform(scene, eye, target, aspect);
  const effects = [
    clamp(scene.aoStrength ?? 0.85, 0, 2),
    clamp(scene.giStrength ?? 0.45, 0, 2),
    clamp(scene.ssrStrength ?? 0.65, 0, 2),
    clamp(scene.screenRadius ?? 40, 4, 120)
  ];
  if (!Array.isArray(eye) || eye.length !== 3 || !eye.every(Number.isFinite))
    throw new RangeError('Invalid camera position');
  return new Float32Array([...prefix, ...eye, 1, ...effects]);
}
