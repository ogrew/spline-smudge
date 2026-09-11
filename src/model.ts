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
};
// Positions, source length and width use original-image pixels. Export scales the composition uniformly.
export type DocumentState = {
  mode: "A" | "B";
  kind: Kind;
  strokes: Stroke[];
  activeId: string;
  nextStrokeNumber: number;
  background: string;
  longEdge: number;
};
export function initialState(width: number, height: number): DocumentState {
  return {
    mode: "A",
    kind: "centripetal",
    activeId: "stroke-1",
    nextStrokeNumber: 2,
    background: "#f3f0e8",
    longEdge: 2000,
    strokes: [
      {
        id: "stroke-1",
        name: "Stroke 01",
        visible: true,
        points: [],
        width: Math.max(
          1,
          Math.min(
            Math.round(Math.min(width, height) * 0.13),
            Math.floor(Math.max(width, height) / 10),
          ),
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
  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
  push(state: DocumentState) {
    this.past.push(structuredClone(state));
    if (this.past.length > 80) this.past.shift();
    this.future = [];
  }
  undo(state: DocumentState) {
    const value = this.past.pop();
    if (value) this.future.push(structuredClone(state));
    return value ?? state;
  }
  redo(state: DocumentState) {
    const value = this.future.pop();
    if (value) this.past.push(structuredClone(state));
    return value ?? state;
  }
  clear() {
    this.past = [];
    this.future = [];
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
