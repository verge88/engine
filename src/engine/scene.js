import { fromTRS, identity, normalMatrix } from './math.js';
import { createPointLight, MAX_POINT_LIGHTS } from './point-lights.js';

export class Scene {
  constructor() {
    this.objects = [];
    this.pointLights = [];
    this.aoStrength = 0.75;
    this.giStrength = 0.5;
    this.ssrStrength = 0.5;
    this.screenRadius = 48;
    this.sunDirection = [0.45, 0.85, 0.32]; // Vector from a surface towards the sun
    this.sunColor = [1.0, 0.91, 0.78];
    this.sunIntensity = 5.0;
    this.exposure = 1.0;
    this.bloomStrength = 0.24;
    this.bloomThreshold = 1.2;
  }
  add(geometry, material = {}, transform = {}) {
    const object = {
      geometry,
      material,
      position: transform.position ?? [0, 0, 0],
      rotation: transform.rotation ?? [0, 0, 0, 1],
      scale: transform.scale ?? [1, 1, 1],
      matrix: transform.matrix ?? null,
      visible: true
    };
    this.objects.push(object);
    return object;
  }
  addPointLight(config = {}) {
    if (this.pointLights.length >= MAX_POINT_LIGHTS) {
      throw new RangeError('At most ' + MAX_POINT_LIGHTS + ' point lights are supported');
    }
    const light = createPointLight(config);
    this.pointLights.push(light);
    return light;
  }
  clear() {
    this.objects.length = 0;
    this.pointLights.length = 0;
  }
  static modelMatrix(object) {
    return object.matrix ?? fromTRS(object.position, object.rotation, object.scale);
  }
  static normalMatrix(object) {
    return normalMatrix(Scene.modelMatrix(object));
  }
}
