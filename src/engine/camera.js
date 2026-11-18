import { clamp, lookAt, multiply, perspective } from './math.js';

export class OrbitCamera {
  constructor(canvas) {
    this.target = [0, 0.8, 0];
    this.yaw = 0.55;
    this.pitch = 0.35;
    this.distance = 10;
    this.keys = new Set();
    this.dragging = false;
    canvas.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      this.dragging = true;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointerup', () => { this.dragging = false; });
    canvas.addEventListener('pointercancel', () => { this.dragging = false; });
    canvas.addEventListener('pointermove', e => {
      if (!this.dragging) return;
      this.yaw -= e.movementX * 0.005;
      this.pitch = clamp(this.pitch + e.movementY * 0.005, -1.48, 1.48);
    });
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      this.distance = clamp(this.distance * Math.exp(e.deltaY * 0.001), 1.5, 80);
    }, { passive: false });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    window.addEventListener('keydown', e => {
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
      this.keys.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', e => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }
  update(dt) {
    const speed = dt * Math.max(2, this.distance * 0.65);
    const dx = Number(this.keys.has('KeyD')) - Number(this.keys.has('KeyA'));
    const dz = Number(this.keys.has('KeyS')) - Number(this.keys.has('KeyW'));
    this.target[0] += speed * (Math.cos(this.yaw) * dx + Math.sin(this.yaw) * dz);
    this.target[2] += speed * (-Math.sin(this.yaw) * dx + Math.cos(this.yaw) * dz);
    this.target[1] += speed * (Number(this.keys.has('Space')) - Number(this.keys.has('ShiftLeft')));
  }
  frame(aspect) {
    const cp = Math.cos(this.pitch);
    const eye = [
      this.target[0] + Math.sin(this.yaw) * cp * this.distance,
      this.target[1] + Math.sin(this.pitch) * this.distance,
      this.target[2] + Math.cos(this.yaw) * cp * this.distance
    ];
    return {
      position: eye,
      viewProjection: multiply(
        perspective(Math.PI / 3, aspect, 0.05, 150),
        lookAt(eye, this.target)
      )
    };
  }
}
