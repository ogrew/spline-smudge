import type { DocumentState, Stroke, Vec } from "./model.ts";
import { pointSource } from "./model.ts";
import { curvePoints, type Sample } from "./geometry.ts";

/** Layout per vertex: center.xy, unit normal.xy, sourceA.xy, sourceB.xy,
 * (cross-section, interval fraction), (signed half-width offset px, 0).
 * The vertex shader assembles the final position so photo-reactive options
 * (displacement, edge-modulated width) can move vertices without new meshes. */
export const ribbonStride = 12;
function sampleAt(a: Sample, b: Sample, station: number): Sample {
  const t = (station - a.station) / (b.station - a.station);
  const out = { ...a, station };
  for (const k of ["x", "y", "factor", "nx", "ny", "distance"] as const)
    out[k] = a[k] + (b[k] - a[k]) * t;
  return out;
}
function sourceUV(
  source: Vec & { angle: number; length: number },
  cross: number,
): Vec {
  const angle = (source.angle * Math.PI) / 180,
    offset = (cross - 0.5) * source.length;
  return {
    x: source.x + Math.cos(angle) * offset,
    y: source.y + Math.sin(angle) * offset,
  };
}
export function ribbonMesh(
  samples: Sample[],
  stroke: Stroke,
  mode: DocumentState["mode"],
): Float32Array {
  const points = curvePoints(stroke.points);
  if (points.length < 2 || samples.length < 2) return new Float32Array();
  let quadCount = samples.length - 1;
  if (mode === "B")
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1],
        b = samples[i];
      for (let k = Math.floor(a.station) + 1; k < b.station; k++) quadCount++;
    }
  const vertices = new Float32Array(quadCount * 6 * ribbonStride);
  let offset = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1],
      b = samples[i];
    const cuts = [a];
    // A sampled mesh edge may straddle a color station. Split it so adjacent intervals
    // share exactly the same color at the join instead of interpolating source coordinates.
    if (mode === "B")
      for (let k = Math.floor(a.station) + 1; k < b.station; k++)
        cuts.push(sampleAt(a, b, k));
    cuts.push(b);
    for (let j = 1; j < cuts.length; j++) {
      const left = cuts[j - 1],
        right = cuts[j];
      const index = Math.max(
        0,
        Math.min(
          points.length - 2,
          Math.floor((left.station + right.station) / 2),
        ),
      );
      const first =
        mode === "A" ? stroke.source : pointSource(stroke, points[index]);
      const second =
        mode === "A" ? stroke.source : pointSource(stroke, points[index + 1]);
      for (const [p, cross] of [
        [left, 0],
        [left, 1],
        [right, 0],
        [right, 0],
        [left, 1],
        [right, 1],
      ] as const) {
        const r = (cross - 0.5) * stroke.width * p.factor,
          uvA = sourceUV(first, cross),
          uvB = sourceUV(second, cross);
        vertices[offset++] = p.x;
        vertices[offset++] = p.y;
        vertices[offset++] = p.nx;
        vertices[offset++] = p.ny;
        vertices[offset++] = uvA.x;
        vertices[offset++] = uvA.y;
        vertices[offset++] = uvB.x;
        vertices[offset++] = uvB.y;
        vertices[offset++] = cross;
        vertices[offset++] =
          mode === "A" ? 0 : Math.max(0, Math.min(1, p.station - index));
        vertices[offset++] = r;
        vertices[offset++] = 0;
      }
    }
  }
  return vertices;
}
