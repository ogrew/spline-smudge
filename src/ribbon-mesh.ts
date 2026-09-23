import type { DocumentState, Stroke, Vec } from "./model.ts";
import { pointSource } from "./model.ts";
import { curvePoints, progressAt, type Sample } from "./geometry.ts";

/** Layout per vertex: center.xy, unit normal.xy, sourceA.xy, sourceB.xy,
 * (cross-section, interval fraction), (signed half-width offset px, band arc
 * length px). The arc length is whole-band, not per-interval, so textures in
 * band space never restart at color-station or progression-key joins. The
 * vertex shader assembles the final position so photo-reactive options
 * (displacement, edge-modulated width) can move vertices without new meshes.
 * With glow the ribbon becomes three strips — halo, core, halo — and the
 * cross-section runs -1..2: the halos carry the clamped edge color, and the
 * fragment shader reads |cross| outside 0..1 as the normalized halo depth. */
export const ribbonStride = 12;
export type GlowMesh = {
  /** Halo width as a multiple of the ribbon width. */
  width: number;
  /** −1..1: + widens the halo toward the band's end, − toward the start. */
  spread: number;
};
function lerpSample(a: Sample, b: Sample, t: number): Sample {
  const out = { ...a };
  for (const k of [
    "x",
    "y",
    "factor",
    "nx",
    "ny",
    "distance",
    "station",
  ] as const)
    out[k] = a[k] + (b[k] - a[k]) * t;
  return out;
}
const sampleAtStation = (a: Sample, b: Sample, station: number) =>
  lerpSample(a, b, (station - a.station) / (b.station - a.station));
const sampleAtDistance = (a: Sample, b: Sample, distance: number) =>
  lerpSample(a, b, (distance - a.distance) / (b.distance - a.distance));
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
  glow: GlowMesh | null = null,
): Float32Array {
  const points = curvePoints(stroke.points);
  if (points.length < 2 || samples.length < 2) return new Float32Array();
  // Mode C walks the sampling path by arc ratio; progression keys become
  // extra cut positions so each mesh quad stays linear in the source photo.
  const total = samples[samples.length - 1].distance,
    path = stroke.path,
    pathVector =
      mode === "C"
        ? { x: path.end.x - path.start.x, y: path.end.y - path.start.y }
        : { x: 0, y: 0 };
  const keyDistances =
    mode === "C" && total > 0
      ? [...new Set(path.keys.map((key) => key.s * total))]
          .filter((d) => d > 0 && d < total)
          .sort((a, b) => a - b)
      : [];
  const sourceAt = (distance: number) => {
    const q = progressAt(path.keys, total > 0 ? distance / total : 0);
    return {
      x: path.start.x + pathVector.x * q,
      y: path.start.y + pathVector.y * q,
      angle: path.angle,
      length: path.length,
    };
  };
  const cutsBetween = (a: Sample, b: Sample) => {
    const cuts = [a];
    if (mode === "B")
      for (let k = Math.floor(a.station) + 1; k < b.station; k++)
        cuts.push(sampleAtStation(a, b, k));
    if (mode === "C")
      for (const d of keyDistances)
        if (a.distance < d && d < b.distance)
          cuts.push(sampleAtDistance(a, b, d));
    cuts.push(b);
    return cuts;
  };
  // Halo width multiplier at a sample, varying linearly along the arc so the
  // trail can diffuse toward one end. Clamped at 0: a fully asymmetric spread
  // pinches the halo shut at the opposite end.
  const glowAt = (p: Sample) =>
    glow === null
      ? 0
      : glow.width *
        Math.max(
          0,
          1 + glow.spread * ((total > 0 ? (2 * p.distance) / total : 0) - 1),
        );
  // Strip endpoints across the section: [color cross, strip cross, is halo].
  // Halo vertices reuse the clamped edge color and only extend the geometry.
  const strips: readonly (readonly (readonly [number, number, boolean])[])[] =
    glow === null
      ? [
          [
            [0, 0, false],
            [1, 1, false],
          ],
        ]
      : [
          [
            [0, -1, true],
            [0, 0, false],
          ],
          [
            [0, 0, false],
            [1, 1, false],
          ],
          [
            [1, 1, false],
            [1, 2, true],
          ],
        ];
  let quadCount = 0;
  for (let i = 1; i < samples.length; i++)
    quadCount +=
      (cutsBetween(samples[i - 1], samples[i]).length - 1) * strips.length;
  const vertices = new Float32Array(quadCount * 6 * ribbonStride);
  let offset = 0;
  for (let i = 1; i < samples.length; i++) {
    // A sampled mesh edge may straddle a color station (B) or a progression
    // key (C). Split it so adjacent intervals share exactly the same source
    // at the join instead of interpolating across the discontinuity.
    const cuts = cutsBetween(samples[i - 1], samples[i]);
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
      for (const [a, b] of strips)
        for (const [p, [cross, strip, halo]] of [
          [left, a],
          [left, b],
          [right, a],
          [right, a],
          [left, b],
          [right, b],
        ] as const) {
          const moving = mode === "C" ? sourceAt(p.distance) : null;
          const half = (cross - 0.5) * stroke.width * p.factor,
            r = halo ? half * (1 + glowAt(p)) : half,
            uvA = sourceUV(moving ?? first, cross),
            uvB = sourceUV(moving ?? second, cross);
          vertices[offset++] = p.x;
          vertices[offset++] = p.y;
          vertices[offset++] = p.nx;
          vertices[offset++] = p.ny;
          vertices[offset++] = uvA.x;
          vertices[offset++] = uvA.y;
          vertices[offset++] = uvB.x;
          vertices[offset++] = uvB.y;
          vertices[offset++] = strip;
          vertices[offset++] =
            mode === "B" ? Math.max(0, Math.min(1, p.station - index)) : 0;
          vertices[offset++] = r;
          vertices[offset++] = p.distance;
        }
    }
  }
  return vertices;
}
