import type { Vec, Point, Stroke } from "./model.ts";
export type Sample = Vec & {
  factor: number;
  station: number;
  nx: number;
  ny: number;
  distance: number;
};
export const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);
const add = (a: Vec, b: Vec, u = 1, v = 1): Vec => ({
  x: a.x * u + b.x * v,
  y: a.y * u + b.y * v,
});
const sub = (a: Vec, b: Vec) => add(a, b, 1, -1);
const reflect = (a: Vec, b: Vec) => add(a, b, 2, -1);
export const widthAt = (a: number, b: number, t: number) => {
  t = Math.max(0, Math.min(1, t));
  const u = t * t * (3 - 2 * t);
  return Math.max(0, Math.min(10, a * (1 - u) + b * u));
};
function hermite(p: Vec, q: Vec, m: Vec, n: Vec, t: number): Vec {
  const t2 = t * t,
    t3 = t2 * t;
  return add(
    add(p, q, 2 * t3 - 3 * t2 + 1, -2 * t3 + 3 * t2),
    add(m, n, t3 - 2 * t2 + t, t3 - t2),
  );
}
export function greville(knots: number[], degree: number, count: number) {
  return Array.from(
    { length: count },
    (_, i) =>
      knots.slice(i + 1, i + degree + 1).reduce((a, b) => a + b, 0) / degree,
  );
}
export function curvePoints(points: Point[]): Point[] {
  // Last coincident point owns the width and B source of that station.
  const ps: Point[] = [];
  for (const p of points) {
    if (ps.length && dist(ps.at(-1)!, p) < 1e-7) ps[ps.length - 1] = p;
    else ps.push(p);
  }
  return ps;
}
export function sampleCurve(stroke: Stroke, step = 2): Sample[] {
  const ps = curvePoints(stroke.points);
  if (ps.length < 2) return [];
  const count = ps.length,
    last = count - 1;
  let raw: (Vec & { factor: number; station: number })[] = [];
  if (stroke.kind === "bspline") {
    const degree = Math.min(3, last),
      spans = count - degree;
    const knots = [
      ...Array(degree + 1).fill(0),
      ...Array.from({ length: spans - 1 }, (_, i) => (i + 1) / spans),
      ...Array(degree + 1).fill(1),
    ];
    const stations = greville(knots, degree, count);
    const length = ps.slice(1).reduce((sum, p, i) => sum + dist(ps[i], p), 0);
    const divisions = Math.max(64, Math.ceil(length / step));
    const times = [
      ...new Set([
        ...Array.from({ length: divisions + 1 }, (_, i) => i / divisions),
        ...stations,
      ]),
    ].sort((a, b) => a - b);
    raw = times.map((t) => {
      let k = degree;
      while (k < last && t >= knots[k + 1]) k++;
      const d: Vec[] = Array.from({ length: degree + 1 }, (_, j) => ({
        ...ps[k - degree + j],
      }));
      for (let r = 1; r <= degree; r++)
        for (let j = degree; j >= r; j--) {
          const i = k - degree + j,
            u = (t - knots[i]) / (knots[i + degree - r + 1] - knots[i]);
          d[j] = add(d[j - 1], d[j], 1 - u, u);
        }
      let i = 0;
      while (i < last - 1 && t > stations[i + 1]) i++;
      const u = (t - stations[i]) / (stations[i + 1] - stations[i]);
      return {
        ...d[degree],
        factor: widthAt(ps[i].factor, ps[i + 1].factor, u),
        station: i + u,
      };
    });
  } else {
    const h = ps.slice(1).map((p, i) => dist(ps[i], p));
    const second = (axis: "x" | "y") => {
      const diag = Array(count).fill(1),
        upper = Array(count).fill(0),
        rhs = Array(count).fill(0);
      for (let i = 1; i < last; i++) {
        diag[i] = 2 * (h[i - 1] + h[i]);
        upper[i] = h[i];
        rhs[i] =
          6 *
          ((ps[i + 1][axis] - ps[i][axis]) / h[i] -
            (ps[i][axis] - ps[i - 1][axis]) / h[i - 1]);
        const ratio = h[i - 1] / diag[i - 1];
        diag[i] -= ratio * upper[i - 1];
        rhs[i] -= ratio * rhs[i - 1];
      }
      const out = Array(count).fill(0);
      for (let i = last - 1; i >= 0; i--)
        out[i] = (rhs[i] - upper[i] * out[i + 1]) / diag[i];
      return out;
    };
    const mx = stroke.kind === "natural" ? second("x") : [],
      my = stroke.kind === "natural" ? second("y") : [];
    const tangent = (i: number, outgoing: boolean) => {
      const p = ps[i],
        a = ps[i - 1] ?? reflect(p, ps[i + 1]),
        b = ps[i + 1] ?? reflect(p, ps[i - 1]);
      const T = stroke.tension,
        C = stroke.continuity * (outgoing ? 1 : -1),
        B = stroke.bias;
      return add(
        sub(p, a),
        sub(b, p),
        ((1 - T) * (1 + C) * (1 + B)) / 2,
        ((1 - T) * (1 - C) * (1 - B)) / 2,
      );
    };
    for (let i = 0; i < last; i++) {
      const p = ps[i],
        q = ps[i + 1],
        a = ps[i - 1] ?? reflect(p, q),
        b = ps[i + 2] ?? reflect(q, p);
      let m = add(q, a, 0.5, -0.5),
        n = add(b, p, 0.5, -0.5);
      if (stroke.kind === "centripetal") {
        const h0 = Math.sqrt(dist(a, p)),
          h1 = Math.sqrt(dist(p, q)),
          h2 = Math.sqrt(dist(q, b));
        m = add(
          add(sub(p, a), sub(q, a), 1 / h0, -1 / (h0 + h1)),
          sub(q, p),
          h1,
          1,
        );
        n = add(
          add(sub(q, p), sub(b, p), 1 / h1, -1 / (h1 + h2)),
          sub(b, q),
          h1,
          h1 / h2,
        );
      } else if (stroke.kind === "tcb") {
        m = tangent(i, true);
        n = tangent(i + 1, false);
      }
      const divisions = Math.max(
        32,
        Math.ceil((dist(a, p) + dist(p, q) + dist(q, b)) / step),
      );
      for (let j = i ? 1 : 0; j <= divisions; j++) {
        const t = j / divisions,
          u = 1 - t;
        let xy = hermite(p, q, m, n, t);
        if (stroke.kind === "natural")
          xy = {
            x:
              u * p.x +
              t * q.x +
              (h[i] ** 2 / 6) *
                ((u ** 3 - u) * mx[i] + (t ** 3 - t) * mx[i + 1]),
            y:
              u * p.y +
              t * q.y +
              (h[i] ** 2 / 6) *
                ((u ** 3 - u) * my[i] + (t ** 3 - t) * my[i + 1]),
          };
        raw.push({
          ...xy,
          factor: widthAt(p.factor, q.factor, t),
          station: i + t,
        });
      }
    }
  }
  // Resample by arc length for stable ribbon spacing, independent of input event rate.
  const sampled = [raw[0]];
  let remaining = step,
    previous = raw[0];
  for (let i = 1; i < raw.length; i++) {
    const end = raw[i];
    let length = dist(previous, end);
    while (length >= remaining && length > 1e-9) {
      const t = remaining / length;
      previous = {
        ...add(previous, end, 1 - t, t),
        factor: previous.factor * (1 - t) + end.factor * t,
        station: previous.station * (1 - t) + end.station * t,
      };
      sampled.push(previous);
      length = dist(previous, end);
      remaining = step;
    }
    remaining -= length;
    previous = end;
  }
  if (dist(sampled.at(-1)!, raw.at(-1)!) > 1e-7) sampled.push(raw.at(-1)!);
  let distance = 0;
  return sampled.map((p, i) => {
    const a = sampled[Math.max(0, i - 1)],
      b = sampled[Math.min(sampled.length - 1, i + 1)];
    const length = dist(a, b),
      fallback = i ? sub(p, a) : { x: 1, y: 0 };
    const dx = length > 1e-9 ? b.x - a.x : fallback.x,
      dy = length > 1e-9 ? b.y - a.y : fallback.y;
    const norm = Math.hypot(dx, dy) || 1;
    if (i) distance += dist(sampled[i - 1], p);
    return { ...p, nx: -dy / norm, ny: dx / norm, distance };
  });
}
