export type Vec = { x: number; y: number };
export type Point = Vec & { id: string; factor: number };
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
  points: Point[];
  kind: Kind;
  width: number;
  tension: number;
  continuity: number;
  bias: number;
  source: Vec & { angle: number; length: number };
};
// Positions, source length and width use original-image pixels. Export scales the composition uniformly.
export type DocumentState = {
  mode: "A" | "B";
  strokes: Stroke[];
  activeId: string;
  pickup: number;
  background: string;
  longEdge: number;
};
export function initialState(width: number, height: number): DocumentState {
  return {
    mode: "A",
    activeId: "stroke-1",
    pickup: 0.12,
    background: "#f3f0e8",
    longEdge: 2000,
    strokes: [
      {
        id: "stroke-1",
        points: [],
        kind: "centripetal",
        width: Math.round(Math.min(width, height) * 0.13),
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
