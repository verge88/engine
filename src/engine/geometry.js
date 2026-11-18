// Interleaved vertex attributes: position.xyz, normal.xyz, uv.xy (8 floats).
export function plane(size = 30) {
  const s = size / 2;
  return {
    vertices: new Float32Array([
      -s, 0, -s, 0, 1, 0, 0, 0,
      -s, 0,  s, 0, 1, 0, 0, 1,
       s, 0,  s, 0, 1, 0, 1, 1,
       s, 0, -s, 0, 1, 0, 1, 0
    ]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3])
  };
}
export function cube(size = 1) {
  const vertices = [], indices = [], s = size / 2;
  const faces = [
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]]
  ];
  for (const [normal, u, v] of faces) {
    const base = vertices.length / 8;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = normal.map((n, i) => s * (n + a * u[i] + b * v[i]));
      vertices.push(...p, ...normal, (a + 1) / 2, (b + 1) / 2);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
}
export function sphere(radius = 1, segments = 48, rings = 32) {
  if (segments < 3 || rings < 2) throw new Error('Sphere requires >= 3 segments and >= 2 rings');
  const vertices = [], indices = [];
  for (let y = 0; y <= rings; y++) {
    const phi = Math.PI * y / rings;
    for (let x = 0; x <= segments; x++) {
      const theta = 2 * Math.PI * x / segments;
      const n = [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
      vertices.push(...n.map(v => v * radius), ...n, x / segments, y / rings);
    }
  }
  for (let y = 0; y < rings; y++) for (let x = 0; x < segments; x++) {
    const a = y * (segments + 1) + x, b = a + segments + 1;
    indices.push(a, a + 1, b, a + 1, b + 1, b);
  }
  return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
}
