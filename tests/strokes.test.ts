import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialState,
  activeStroke,
  addStroke,
  deleteStroke,
  moveStroke,
  History,
  exportKind,
  previewLongEdge,
  rescaleDocument,
} from "../src/model.ts";
test("duplicate gets independent point IDs, source settings and stable name", () => {
  const state = initialState(200, 100),
    s = activeStroke(state);
  s.points = [
    { id: "p", x: 20, y: 30, factor: 2, source: { angle: 25, length: 30 } },
  ];
  const copy = addStroke(state, true);
  assert.notEqual(copy.id, s.id);
  assert.notEqual(copy.points[0].id, s.points[0].id);
  assert.equal(copy.name, "Stroke 02");
  copy.points[0].source!.angle = 90;
  copy.points[0].x = 100;
  copy.source.length = 90;
  assert.equal(s.points[0].source!.angle, 25);
  assert.equal(s.points[0].x, 20);
  assert.notEqual(copy.source.length, s.source.length);
  moveStroke(state, -1);
  assert.equal(state.strokes[0].id, copy.id);
  assert.equal(copy.name, "Stroke 02");
});
test("undo restores ordering, visibility and removed strokes; last deletion leaves editable empty stroke", () => {
  let state = initialState(200, 100);
  const first = activeStroke(state),
    second = addStroke(state, true),
    h = new History();
  h.push(state);
  first.visible = false;
  moveStroke(state, -1);
  deleteStroke(state);
  assert.equal(state.strokes.length, 1);
  state = h.undo(state);
  assert.deepEqual(
    state.strokes.map((s) => s.id),
    [first.id, second.id],
  );
  assert.equal(state.strokes[0].visible, true);
  deleteStroke(state);
  deleteStroke(state);
  assert.equal(state.strokes.length, 1);
  assert.equal(activeStroke(state).points.length, 0);
  assert.equal(activeStroke(state).visible, true);
});
test("export name uses the global spline type, independent of selection or visibility", () => {
  const state = initialState(200, 100),
    s = activeStroke(state);
  s.points = [
    { id: "a", x: 0, y: 0, factor: 1 },
    { id: "b", x: 30, y: 30, factor: 1 },
  ];
  const copy = addStroke(state, true);
  state.kind = "natural";
  assert.equal(exportKind(state), "natural");
  copy.visible = false;
  assert.equal(exportKind(state), "natural");
  s.visible = false;
  assert.equal(exportKind(state), "natural");
});
test("discarding a canceled edit removes its undo entry and preserves redo", () => {
  let state = initialState(200, 100);
  const history = new History();
  history.push(state);
  state.background = "#000000";
  state = history.undo(state);
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, true);

  history.push(state);
  state = history.discardLatestPush() ?? state;
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, true);
  assert.equal(state.background, "#f3f0e8");
  assert.equal(history.redo(state).background, "#000000");
});
test("initial base width is 5% of the short edge, at least 10px, under the slider cap", () => {
  const width = (w: number, h: number) => activeStroke(initialState(w, h)).width;
  assert.equal(width(1600, 1100), 55);
  assert.equal(width(6000, 4000), 200);
  // The 10px floor applies when 5% of the short edge is smaller.
  assert.equal(width(400, 100), 10);
  // Tiny images resolve in favor of the long-edge/10 slider cap.
  assert.equal(width(50, 40), 5);
});
test("rescaling to a new image keeps shape via uniform scale and centering", () => {
  const state = initialState(200, 100),
    s = activeStroke(state);
  s.width = 20;
  s.tension = 0.5;
  s.points = [
    { id: "a", x: 40, y: 20, factor: 2, source: { angle: 30, length: 40 } },
    { id: "b", x: 120, y: 80, factor: 0.5, source: { angle: -90, length: 10 } },
  ];
  s.source = { x: 40, y: 20, angle: 45, length: 30 };
  // Portrait target: scale = min(100/200, 200/100) = 0.5, centered vertically.
  const next = rescaleDocument(
    state,
    { width: 200, height: 100 },
    { width: 100, height: 200 },
  );
  const moved = activeStroke(next);
  assert.deepEqual(
    moved.points.map((p) => [p.x, p.y]),
    [
      [20, 85],
      [60, 115],
    ],
  );
  assert.equal(moved.width, 10);
  assert.deepEqual(moved.source, { x: 20, y: 85, angle: 45, length: 15 });
  assert.deepEqual(
    moved.points.map((p) => [p.factor, p.source!.angle, p.source!.length]),
    [
      [2, 30, 20],
      [0.5, -90, 5],
    ],
  );
  assert.equal(moved.tension, 0.5);
  // The same size is an identity transform.
  assert.deepEqual(
    rescaleDocument(
      state,
      { width: 200, height: 100 },
      { width: 200, height: 100 },
    ),
    state,
  );
  // Width stays inside the new slider cap and lengths keep their 1px floor.
  const tiny = rescaleDocument(
    state,
    { width: 200, height: 100 },
    { width: 20, height: 10 },
  );
  assert.equal(activeStroke(tiny).width, 2);
  assert.equal(activeStroke(tiny).source.length, 3);
  assert.equal(activeStroke(tiny).points[1].source!.length, 1);
});
test("rescaling scales the brush texture grain within its slider bounds", () => {
  const state = initialState(200, 100);
  state.options.texture.grain = 8;
  const grow = (to: { width: number; height: number }) =>
    rescaleDocument(state, { width: 200, height: 100 }, to).options.texture
      .grain;
  assert.equal(grow({ width: 400, height: 200 }), 16);
  assert.equal(grow({ width: 4000, height: 2000 }), 48);
  assert.equal(grow({ width: 20, height: 10 }), 2);
});
test("preview edge follows the display within bounds, or is skipped when the saving is small", () => {
  // Display-sized when it saves enough against the output resolution.
  assert.equal(previewLongEdge(5000, 1400), 1400);
  assert.equal(previewLongEdge(2000, 1200), 1200);
  // Ceiling on large displays, floor on small ones.
  assert.equal(previewLongEdge(5000, 2800), 2048);
  assert.equal(previewLongEdge(5000, 400), 800);
  // No preview when it would not be meaningfully smaller than the output.
  assert.equal(previewLongEdge(2000, 2800), null);
  assert.equal(previewLongEdge(2000, 1900), null);
  assert.equal(previewLongEdge(800, 400), null);
});
test("rescaling carries the mode C sampling path with the same transform", () => {
  const state = initialState(200, 100);
  activeStroke(state).path = {
    start: { x: 40, y: 20 },
    end: { x: 160, y: 80 },
    angle: 30,
    length: 40,
    keys: [
      { s: 0, q: 0 },
      { s: 0.5, q: 0.9 },
      { s: 1, q: 1 },
    ],
  };
  const next = activeStroke(
    rescaleDocument(state, { width: 200, height: 100 }, { width: 100, height: 200 }),
  ).path;
  assert.deepEqual(next.start, { x: 20, y: 85 });
  assert.deepEqual(next.end, { x: 80, y: 115 });
  assert.equal(next.angle, 30);
  assert.equal(next.length, 20);
  assert.deepEqual(next.keys[1], { s: 0.5, q: 0.9 });
});
