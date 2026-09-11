import type { Vec } from "./model.ts";

/** Edge-flow orientations on a coarse grid, stored as doubled angles so
 * opposite directions compare equal (an edge has no inherent sign). */
export type FlowField = {
  width: number;
  height: number;
  cos2: Float32Array;
  sin2: Float32Array;
};

/** Structure-tensor orientation of the luminance grid. Pure — usable in node tests. */
export function fieldFromLuminance(
  lum: Float32Array,
  width: number,
  height: number,
): FlowField {
  const at = (x: number, y: number) =>
    lum[
      Math.min(height - 1, Math.max(0, y)) * width +
        Math.min(width - 1, Math.max(0, x))
    ];
  const jxx = new Float32Array(width * height),
    jxy = new Float32Array(width * height),
    jyy = new Float32Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      // Sobel gradients with clamped borders.
      const gx =
        at(x + 1, y - 1) +
        2 * at(x + 1, y) +
        at(x + 1, y + 1) -
        at(x - 1, y - 1) -
        2 * at(x - 1, y) -
        at(x - 1, y + 1);
      const gy =
        at(x - 1, y + 1) +
        2 * at(x, y + 1) +
        at(x + 1, y + 1) -
        at(x - 1, y - 1) -
        2 * at(x, y - 1) -
        at(x + 1, y - 1);
      const i = y * width + x;
      jxx[i] = gx * gx;
      jxy[i] = gx * gy;
      jyy[i] = gy * gy;
    }
  // Smoothing the tensor merges opposite gradients on thin features instead of cancelling them.
  for (const channel of [jxx, jxy, jyy]) blur(channel, width, height, 2, 3);
  const cos2 = new Float32Array(width * height),
    sin2 = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    // Dominant eigenvector angle φ of the tensor is the gradient direction;
    // the flow follows edges at φ + 90°, i.e. the doubled angle is negated and flipped.
    const gradientCos2 = jxx[i] - jyy[i],
      gradientSin2 = 2 * jxy[i];
    cos2[i] = -gradientCos2;
    sin2[i] = -gradientSin2;
    const norm = Math.hypot(cos2[i], sin2[i]);
    if (norm > 1e-12) {
      cos2[i] /= norm;
      sin2[i] /= norm;
    } else {
      cos2[i] = 1; // Flat area: default to horizontal flow.
      sin2[i] = 0;
    }
  }
  return { width, height, cos2, sin2 };
}

function blur(
  data: Float32Array,
  width: number,
  height: number,
  radius: number,
  passes: number,
) {
  const temp = new Float32Array(data.length);
  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++)
          sum += data[y * width + Math.min(width - 1, Math.max(0, x + k))];
        temp[y * width + x] = sum / (2 * radius + 1);
      }
    for (let x = 0; x < width; x++)
      for (let y = 0; y < height; y++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++)
          sum += temp[Math.min(height - 1, Math.max(0, y + k)) * width + x];
        data[y * width + x] = sum / (2 * radius + 1);
      }
  }
}

/** Bilinear direction sample as a unit vector, sign-aligned with `previous`. */
function direction(field: FlowField, x: number, y: number, previous: Vec): Vec {
  const fx = Math.min(field.width - 1.001, Math.max(0, x)),
    fy = Math.min(field.height - 1.001, Math.max(0, y));
  const x0 = Math.floor(fx),
    y0 = Math.floor(fy),
    tx = fx - x0,
    ty = fy - y0;
  let c = 0,
    s = 0;
  for (const [dx, dy, w] of [
    [0, 0, (1 - tx) * (1 - ty)],
    [1, 0, tx * (1 - ty)],
    [0, 1, (1 - tx) * ty],
    [1, 1, tx * ty],
  ]) {
    const i = (y0 + dy) * field.width + x0 + dx;
    c += field.cos2[i] * w;
    s += field.sin2[i] * w;
  }
  const angle = 0.5 * Math.atan2(s, c);
  const d = { x: Math.cos(angle), y: Math.sin(angle) };
  return d.x * previous.x + d.y * previous.y < 0 ? { x: -d.x, y: -d.y } : d;
}

/** Trace a streamline through the field in both directions from `seed`.
 * All coordinates are source-image pixels; `length` is the total path length. */
export function traceFlow(
  field: FlowField,
  seed: Vec,
  iw: number,
  ih: number,
  length: number,
): Vec[] {
  const sx = field.width / iw,
    sy = field.height / ih;
  const step = Math.max(1.5, length / 240);
  const initial = direction(field, seed.x * sx, seed.y * sy, { x: 1, y: 1e-3 });
  const half = (start: Vec) => {
    const points: Vec[] = [];
    let p = { ...seed },
      previous = start;
    for (let travelled = 0; travelled < length / 2; travelled += step) {
      // Midpoint (RK2) integration keeps traces on curved structures.
      const d1 = direction(field, p.x * sx, p.y * sy, previous);
      const mid = { x: p.x + (d1.x * step) / 2, y: p.y + (d1.y * step) / 2 };
      const d2 = direction(field, mid.x * sx, mid.y * sy, d1);
      p = { x: p.x + d2.x * step, y: p.y + d2.y * step };
      previous = d2;
      if (p.x < 0 || p.y < 0 || p.x > iw || p.y > ih) break;
      points.push({ ...p });
    }
    return points;
  };
  return [
    ...half({ x: -initial.x, y: -initial.y }).reverse(),
    { ...seed },
    ...half(initial),
  ];
}

/** Resample a traced polyline into evenly spaced control points. */
export function tracePoints(trace: Vec[], count: number): Vec[] {
  if (trace.length < 2) return trace.map((p) => ({ ...p }));
  const n = Math.max(2, count);
  const lengths = [0];
  for (let i = 1; i < trace.length; i++)
    lengths.push(
      lengths[i - 1] + Math.hypot(trace[i].x - trace[i - 1].x, trace[i].y - trace[i - 1].y),
    );
  const total = lengths[trace.length - 1];
  if (total < 1e-9) return [{ ...trace[0] }, { ...trace.at(-1)! }];
  const out: Vec[] = [];
  let segment = 0;
  for (let i = 0; i < n; i++) {
    const target = (total * i) / (n - 1);
    while (segment < trace.length - 2 && lengths[segment + 1] < target) segment++;
    const span = lengths[segment + 1] - lengths[segment];
    const t = span > 1e-9 ? (target - lengths[segment]) / span : 0;
    out.push({
      x: trace[segment].x + (trace[segment + 1].x - trace[segment].x) * t,
      y: trace[segment].y + (trace[segment + 1].y - trace[segment].y) * t,
    });
  }
  return out;
}

/** DOM wrapper: build the field from the loaded photo at a coarse resolution. */
export function buildFlowField(
  source: CanvasImageSource,
  iw: number,
  ih: number,
  maxEdge = 256,
): FlowField {
  const scale = maxEdge / Math.max(iw, ih);
  const w = Math.max(2, Math.round(iw * scale)),
    h = Math.max(2, Math.round(ih * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++)
    lum[i] =
      (0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2]) /
      255;
  canvas.width = canvas.height = 1;
  return fieldFromLuminance(lum, w, h);
}
