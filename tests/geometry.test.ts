import { test } from "node:test";
import assert from "node:assert/strict";
import { sampleCurve, widthAt } from "../src/geometry.ts";
import {
  initialState,
  activeStroke,
  History,
  outputSize,
  kinds,
} from "../src/model.ts";
function fixture() {
  const s = activeStroke(initialState(800, 600));
  s.points = [
    { x: 30, y: 30 },
    { x: 180, y: 400 },
    { x: 330, y: 180 },
    { x: 560, y: 450 },
    { x: 760, y: 60 },
  ].map((p, i) => ({ ...p, id: String(i), factor: 1 }));
  return s;
}
for (const kind of Object.keys(kinds))
  test(`${kind}: finite endpoints, bounded width, width-independent shape`, () => {
    const s = fixture();
    s.kind = kind as typeof s.kind;
    const before = sampleCurve(s);
    assert.ok(before.length > 2);
    assert.ok(Math.hypot(before[0].x - 30, before[0].y - 30) < 1e-5);
    assert.ok(Math.hypot(before.at(-1)!.x - 760, before.at(-1)!.y - 60) < 1e-5);
    s.points[2].factor = 10;
    s.points[0].factor = 0;
    const after = sampleCurve(s);
    assert.equal(after.length, before.length);
    after.forEach((p, i) => {
      assert.ok(Object.values(p).every(Number.isFinite));
      assert.ok(p.factor >= 0 && p.factor <= 10);
      assert.equal(p.x, before[i].x);
      assert.equal(p.y, before[i].y);
    });
    assert.ok(after.some((p) => p.factor > 9.99));
    assert.equal(after[0].factor, 0);
  });
test("zero TCB matches uniform Catmull–Rom", () => {
  const s = fixture();
  s.kind = "catmull";
  const a = sampleCurve(s);
  s.kind = "tcb";
  const b = sampleCurve(s);
  assert.deepEqual(a, b);
});
test("coincident points and all-zero widths remain finite", () => {
  for (const kind of Object.keys(kinds)) {
    const s = fixture();
    s.kind = kind as typeof s.kind;
    s.points.splice(2, 0, { ...s.points[1], id: "duplicate" });
    s.points.forEach((p) => (p.factor = 0));
    for (const p of sampleCurve(s)) {
      assert.equal(p.factor, 0);
      assert.ok(Number.isFinite(p.x));
    }
    s.points = s.points.map((p) => ({ ...p, x: 1, y: 1 }));
    assert.deepEqual(sampleCurve(s), []);
  }
});
test("smooth width never overshoots, at exact endpoints", () => {
  assert.equal(widthAt(0, 10, 0), 0);
  assert.equal(widthAt(0, 10, 1), 10);
  assert.equal(widthAt(0, 10, 0.5), 5);
  assert.ok(widthAt(0, 10, 0.001) < 0.0001);
});
test("undo and redo copy the complete non-destructive document", () => {
  const h = new History(),
    s = initialState(800, 600);
  h.push(s);
  s.mode = "B";
  activeStroke(s).width = 37;
  const old = h.undo(s);
  assert.equal(old.mode, "A");
  const again = h.redo(old);
  assert.equal(again.mode, "B");
  assert.equal(activeStroke(again).width, 37);
  h.push(again);
  assert.equal(h.canRedo, false);
});
test("export preserves aspect for landscape, portrait and small images", () => {
  assert.deepEqual(outputSize(6000, 4000, 5000), { width: 5000, height: 3333 });
  assert.deepEqual(outputSize(4000, 6000, 5000), { width: 3333, height: 5000 });
  assert.deepEqual(outputSize(1, 10000, 2000), { width: 1, height: 2000 });
});
