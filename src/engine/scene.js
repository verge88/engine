import { fromTRS, identity, normalMatrix } from './math.js';

export class Scene {
  constructor() {
    this.objects = [];
    this.sunDirection = [0.45, 0.85, 0.32]; // Vector from a surface towards the sun
    this.sunColor = [1.0, 0.91, 0.78];
    this.sunIntensity = 5.0;
    this.exposure = 1.0;
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
  clear() {
    this.objects.length = 0;
  }
  static modelMatrix(object) {
    return object.matrix ?? fromTRS(object.position, object.rotation, object.scale);
  }
  static normalMatrix(object) {
    return normalMatrix(Scene.modelMatrix(object));
  }
}
