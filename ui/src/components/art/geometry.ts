/** Isometric projection and plane mapping. Axes: +x down-right, +y down-left, +z up. */

const C = Math.cos(Math.PI / 6);
const S = Math.sin(Math.PI / 6);

export type Point3 = [number, number, number];

export function iso(x: number, y: number, z = 0): [number, number] {
  return [(x - y) * C, (x + y) * S - z];
}

export function pts(points: Point3[]): string {
  return points
    .map(([x, y, z]) =>
      iso(x, y, z)
        .map((n) => n.toFixed(2))
        .join(","),
    )
    .join(" ");
}

export function pathThrough(points: Point3[]): string {
  return points
    .map(
      (p, i) =>
        `${i ? "L" : "M"}${iso(...p)
          .map((n) => n.toFixed(2))
          .join(" ")}`,
    )
    .join(" ");
}

/** SVG transform that maps flat 2D drawing (x right, y "down" the plane) onto the plane z = `z`. */
export function planeTransform(z = 0, x0 = 0, y0 = 0): string {
  const [ex, ey] = iso(x0, y0, z);
  return `matrix(${C} ${S} ${-C} ${S} ${ex.toFixed(2)} ${ey.toFixed(2)})`;
}

/** Deterministic PRNG (mulberry32), so generated art is identical on every load. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Topographic contours: a smooth height field (a few random hills and basins) traced at evenly spaced
 * levels with marching squares. Returns one SVG path per level.
 */
export function contours({
  width,
  height,
  seed,
  cell = 10,
  levels = 16,
  hills = 7,
}: {
  width: number;
  height: number;
  seed: number;
  cell?: number;
  levels?: number;
  hills?: number;
}): string[] {
  const rand = seeded(seed);
  const peaks = Array.from({ length: hills }, () => ({
    x: rand() * width,
    y: rand() * height,
    a: (rand() < 0.3 ? -1 : 1) * (0.5 + rand()),
    s: (0.12 + rand() * 0.22) * Math.max(width, height),
  }));
  const cols = Math.ceil(width / cell) + 1;
  const rows = Math.ceil(height / cell) + 1;
  const field = new Float32Array(cols * rows);
  let min = Infinity;
  let max = -Infinity;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = i * cell;
      const y = j * cell;
      let v = 0.08 * Math.sin(x / 97 + y / 151) + 0.06 * Math.cos(x / 61 - y / 83);
      for (const p of peaks) {
        const dx = x - p.x;
        const dy = y - p.y;
        v += p.a * Math.exp(-(dx * dx + dy * dy) / (2 * p.s * p.s));
      }
      field[j * cols + i] = v;
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
  }
  const at = (i: number, j: number) => field[j * cols + i] ?? 0;
  const paths: string[] = [];
  for (let k = 1; k <= levels; k++) {
    const level = min + ((max - min) * k) / (levels + 1);
    let d = "";
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const a = at(i, j);
        const b = at(i + 1, j);
        const c = at(i + 1, j + 1);
        const e = at(i, j + 1);
        const idx = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (c > level ? 2 : 0) | (e > level ? 1 : 0);
        if (idx === 0 || idx === 15) continue;
        const x = i * cell;
        const y = j * cell;
        const lerp = (p: number, q: number) => (level - p) / (q - p);
        const top: [number, number] = [x + cell * lerp(a, b), y];
        const right: [number, number] = [x + cell, y + cell * lerp(b, c)];
        const bottom: [number, number] = [x + cell * lerp(e, c), y + cell];
        const left: [number, number] = [x, y + cell * lerp(a, e)];
        const seg = (p: [number, number], q: [number, number]) =>
          `M${p[0].toFixed(1)} ${p[1].toFixed(1)}L${q[0].toFixed(1)} ${q[1].toFixed(1)}`;
        switch (idx) {
          case 1:
          case 14:
            d += seg(left, bottom);
            break;
          case 2:
          case 13:
            d += seg(bottom, right);
            break;
          case 3:
          case 12:
            d += seg(left, right);
            break;
          case 4:
          case 11:
            d += seg(top, right);
            break;
          case 6:
          case 9:
            d += seg(top, bottom);
            break;
          case 7:
          case 8:
            d += seg(left, top);
            break;
          case 5:
            d += seg(left, top) + seg(bottom, right);
            break;
          case 10:
            d += seg(top, right) + seg(left, bottom);
            break;
        }
      }
    }
    paths.push(d);
  }
  return paths;
}

/** Content on the vertical plane y = y0 (faces the viewer's left): local u along +x, v downward. */
export function wallYTransform(y0: number, x0 = 0, z0 = 0): string {
  return `matrix(${C} ${S} 0 1 ${(C * (x0 - y0)).toFixed(2)} ${((x0 + y0) * S - z0).toFixed(2)})`;
}

/** Content on the vertical plane x = x0 (faces the viewer's right): local u along +y, v downward. */
export function wallXTransform(x0: number, y0 = 0, z0 = 0): string {
  return `matrix(${-C} ${S} 0 1 ${(C * (x0 - y0)).toFixed(2)} ${((x0 + y0) * S - z0).toFixed(2)})`;
}

/** A route of hops: each leg is a quadratic arc lifted `lift` units above the straight line. */
export function arcThrough(points: Point3[], lift: number): string {
  const fmt = (p: [number, number]) => p.map((n) => n.toFixed(2)).join(" ");
  const first = points.at(0);
  if (!first) return "";
  let d = `M${fmt(iso(...first))}`;
  for (let i = 1; i < points.length; i++) {
    const a = points.at(i - 1);
    const b = points.at(i);
    if (!a || !b) continue;
    const mid: Point3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2 + lift];
    d += ` Q${fmt(iso(...mid))} ${fmt(iso(...b))}`;
  }
  return d;
}
