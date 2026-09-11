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
