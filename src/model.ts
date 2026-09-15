/** Snapshots kept for undo. */
const HISTORY_LIMIT = 80;
/** Initial base width: this share of the short edge, but at least the floor. */
const INITIAL_WIDTH_RATIO = 0.05;
const INITIAL_WIDTH_FLOOR = 10;
/** The base-width slider maximum for an image: a tenth of the long edge. */
export const widthCap = (width: number, height: number) =>
  Math.max(1, Math.floor(Math.max(width, height) / 10));

/** Long edge for transient interaction previews, or null to render at the
 * output resolution. Display-sized with a quality floor and a cost ceiling;
 * below the skip ratio the saving is not worth rendering twice. */
const PREVIEW_MIN_EDGE = 800;
const PREVIEW_MAX_EDGE = 2048;
const PREVIEW_SKIP_RATIO = 0.8;
export function previewLongEdge(
  outputEdge: number,
  displayEdge: number,
): number | null {
  const edge = Math.min(
    PREVIEW_MAX_EDGE,
    Math.max(PREVIEW_MIN_EDGE, displayEdge),
    outputEdge,
  );
  return edge <= outputEdge * PREVIEW_SKIP_RATIO ? edge : null;
}

export type Vec = { x: number; y: number };
export type SourceSettings = { angle: number; length: number };
export type Point = Vec & {
  id: string;
  factor: number;
  source?: SourceSettings;
};
export type Kind = "catmull" | "bspline" | "centripetal" | "natural" | "tcb";
export const kinds: Record<Kind, string> = {
  catmull: "Catmull–Rom",
  bspline: "B-spline",
  centripetal: "Centripetal Catmull–Rom",
  natural: "Natural cubic",
  tcb: "Kochanek–Bartels / TCB",
};
/** Progression key for mode C: at band arc-ratio s (0..1), the sampling
 * position sits at path arc-ratio q (0..1). Interpolation is piecewise
 * linear; a flat segment holds one spot, a falling one runs backwards. */
export type PathKey = { s: number; q: number };
export const pathPresets: Record<string, PathKey[]> = {
  uniform: [
    { s: 0, q: 0 },
    { s: 1, q: 1 },
  ],
  hold: [
    { s: 0, q: 0 },
    { s: 0.25, q: 0.3 },
    { s: 0.65, q: 0.3 },
    { s: 0.8, q: 0.8 },
    { s: 1, q: 1 },
  ],
  reverse: [
    { s: 0, q: 0 },
    { s: 0.4, q: 0.7 },
    { s: 0.7, q: 0.2 },
    { s: 1, q: 1 },
  ],
};
/** Mode C sampling: a straight path on the photo walked by the progression
 * keys. The cross line has a fixed angle and length (it does not follow the
 * path's tangent), so speed edits and rotation stay separate concerns. */
export type PathSampling = {
  start: Vec;
  end: Vec;
  angle: number;
  length: number;
  keys: PathKey[];
};
export type Stroke = {
  id: string;
  name: string;
  visible: boolean;
  points: Point[];
  width: number;
  tension: number;
  continuity: number;
  bias: number;
  source: Vec & { angle: number; length: number };
  path: PathSampling;
};
/** B-mode color interpolation between adjacent source lines.
 * "srgb" mixes encoded channels (the original behaviour); the OKLab family
 * converts through a perceptual space so midpoints stay clean. "hueSpin"
 * follows OKLCH but adds a fixed extra hue rotation across each interval. */
export type MixMode = "srgb" | "oklab" | "oklch" | "oklchLong" | "hueSpin";
export const mixModes: Record<MixMode, string> = {
  srgb: "sRGB（従来）",
  oklab: "OKLab",
  oklch: "OKLCH · 色相近回り",
  oklchLong: "OKLCH · 色相遠回り",
  hueSpin: "色相回転（OKLCH）",
};
export type ReactionMode = "displace" | "edgeWidth";
export const reactionModes: Record<ReactionMode, string> = {
  displace: "輝度ディスプレイスメント",
  edgeWidth: "エッジで幅を変調",
};
/** Photo-reactive options. Whole-document, undoable, part of the render snapshot. */
export type Options = {
  /** Deform the ribbon from the photo with one selectable algorithm:
   * displace along the normal by luminance, or scale the width by edge strength.
   * Each algorithm keeps its own amount so switching modes preserves both. */
  reaction: {
    on: boolean;
    mode: ReactionMode;
    /** Displacement as % of the source short edge; negative flips direction. */
    displaceAmount: number;
    /** Width modulation −1..1; negative thins at edges. */
    edgeAmount: number;
  };
  /** Fake 3D: cylinder-profile shading across the ribbon cross-section, 0..1. */
  shade: { on: boolean; amount: number };
};
export function defaultOptions(): Options {
  return {
    reaction: { on: false, mode: "displace", displaceAmount: 6, edgeAmount: 0.6 },
    shade: { on: false, amount: 0.65 },
  };
}
// Positions, source length and width use original-image pixels. Export scales the composition uniformly.
export type DocumentState = {
  mode: "A" | "B" | "C";
  kind: Kind;
  strokes: Stroke[];
  activeId: string;
  nextStrokeNumber: number;
  background: string;
  longEdge: number;
  options: Options;
  /** turns: extra full hue rotations per interval for mode "hueSpin". Whole turns
   * keep the sampled colors exact at every control point and interval join. */
  mix: { mode: MixMode; turns: number };
};
export function initialState(width: number, height: number): DocumentState {
  return {
    mode: "A",
    kind: "centripetal",
    activeId: "stroke-1",
    nextStrokeNumber: 2,
    background: "#f3f0e8",
    longEdge: 2000,
    options: defaultOptions(),
    mix: { mode: "srgb", turns: 1 },
    strokes: [
      {
        id: "stroke-1",
        name: "Stroke 01",
        visible: true,
        points: [],
        // Tiny images resolve in the slider cap's favor.
        width: Math.min(
          Math.max(
            INITIAL_WIDTH_FLOOR,
            Math.round(Math.min(width, height) * INITIAL_WIDTH_RATIO),
          ),
          widthCap(width, height),
        ),
        tension: 0,
        continuity: 0,
        bias: 0,
        source: {
          x: width * 0.2,
          y: height * 0.65,
          angle: 90,
          length: Math.min(width, height) * 0.22,
        },
        path: {
          start: { x: width * 0.2, y: height * 0.5 },
          end: { x: width * 0.8, y: height * 0.5 },
          angle: 90,
          length: Math.min(width, height) * 0.22,
          keys: structuredClone(pathPresets.uniform),
        },
      },
    ],
  };
}
export const activeStroke = (state: DocumentState) =>
  state.strokes.find((s) => s.id === state.activeId)!;
export const outputSize = (w: number, h: number, edge: number) => ({
  width: Math.max(1, Math.round((w * edge) / Math.max(w, h))),
  height: Math.max(1, Math.round((h * edge) / Math.max(w, h))),
});
export class History {
  private past: DocumentState[] = [];
  private future: DocumentState[] = [];
  private futureBeforePush: DocumentState[] = [];
  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
  push(state: DocumentState) {
    this.past.push(structuredClone(state));
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.futureBeforePush = this.future;
    this.future = [];
  }
  discardLatestPush() {
    const value = this.past.pop();
    this.future = this.futureBeforePush;
    this.futureBeforePush = [];
    return value;
  }
  undo(state: DocumentState) {
    this.futureBeforePush = [];
    const value = this.past.pop();
    if (value) this.future.push(structuredClone(state));
    return value ?? state;
  }
  redo(state: DocumentState) {
    this.futureBeforePush = [];
    const value = this.future.pop();
    if (value) this.past.push(structuredClone(state));
    return value ?? state;
  }
  clear() {
    this.past = [];
    this.future = [];
    this.futureBeforePush = [];
  }
}

/** B sources stay at clicked control points, including non-interpolating B-splines. */
export function pointSource(
  stroke: Stroke,
  point: Point,
): Vec & SourceSettings {
  return {
    x: point.x,
    y: point.y,
    angle: point.source?.angle ?? stroke.source.angle,
    length: point.source?.length ?? stroke.source.length,
  };
}

/** Array order is back to front. Names are stable when order changes. */
export function addStroke(state: DocumentState, duplicate = false): Stroke {
  const previous = activeStroke(state);
  const next = structuredClone(previous);
  next.id = crypto.randomUUID();
  next.name = `Stroke ${String(state.nextStrokeNumber++).padStart(2, "0")}`;
  next.visible = true;
  next.points = duplicate
    ? next.points.map((p) => ({ ...p, id: crypto.randomUUID() }))
    : [];
  state.strokes.push(next);
  state.activeId = next.id;
  return next;
}
export function deleteStroke(state: DocumentState) {
  const index = state.strokes.findIndex((s) => s.id === state.activeId);
  // Keep an empty editable stroke when removing the last one.
  if (state.strokes.length === 1) addStroke(state);
  state.strokes.splice(index, 1);
  state.activeId = state.strokes[Math.min(index, state.strokes.length - 1)].id;
}
export function moveStroke(state: DocumentState, direction: -1 | 1) {
  const index = state.strokes.findIndex((s) => s.id === state.activeId),
    target = index + direction;
  if (target < 0 || target >= state.strokes.length) return;
  [state.strokes[index], state.strokes[target]] = [
    state.strokes[target],
    state.strokes[index],
  ];
}
export function exportKind(state: DocumentState) {
  return state.kind;
}

/** Fit the whole document into a new image size: one uniform scale for every
 * stroke (the old frame fits inside the new one) plus centering, so curve
 * shapes and the relationships between strokes are preserved. Widths and
 * source-line lengths scale with the same factor; angles, per-point factors,
 * modes and other settings stay. longEdge is left to the caller. */
export function rescaleDocument(
  state: DocumentState,
  from: { width: number; height: number },
  to: { width: number; height: number },
): DocumentState {
  const s = Math.min(to.width / from.width, to.height / from.height);
  const dx = (to.width - from.width * s) / 2,
    dy = (to.height - from.height * s) / 2;
  const cap = widthCap(to.width, to.height);
  const next = structuredClone(state);
  for (const stroke of next.strokes) {
    stroke.width = Math.max(1, Math.min(Math.round(stroke.width * s), cap));
    stroke.source.x = stroke.source.x * s + dx;
    stroke.source.y = stroke.source.y * s + dy;
    stroke.source.length = Math.max(1, stroke.source.length * s);
    for (const end of [stroke.path.start, stroke.path.end]) {
      end.x = end.x * s + dx;
      end.y = end.y * s + dy;
    }
    stroke.path.length = Math.max(1, stroke.path.length * s);
    for (const point of stroke.points) {
      point.x = point.x * s + dx;
      point.y = point.y * s + dy;
      if (point.source)
        point.source.length = Math.max(1, point.source.length * s);
    }
  }
  return next;
}
