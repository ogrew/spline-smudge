import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState, activeStroke, pointSource } from "../src/model.ts";
import { sampleCurve, curvePoints } from "../src/geometry.ts";
import { ribbonMesh, ribbonStride } from "../src/ribbon-mesh.ts";

test("B source coordinates belong to clicked B-spline points, not the curve", () => {
  const s = activeStroke(initialState(600, 400));
  s.points = [
    { x: 20, y: 40 },
    { x: 200, y: 350 },
    { x: 400, y: 20 },
    { x: 580, y: 180 },
  ].map((p, i) => ({
    ...p,
    id: String(i),
    factor: 1,
    source: { angle: 0, length: 20 + i * 10 },
  }));
  const samples = sampleCurve(s, 2, "bspline"),
    mesh = ribbonMesh(samples, s, "B");
  assert.ok(samples.every((p) => Math.hypot(p.x - 200, p.y - 350) > 10));
  let found = false;
  for (let i = 0; i < mesh.length; i += ribbonStride) {
    if (Math.abs(mesh[i + 7] - 350) < 1e-4) {
      found = true;
      assert.ok(
        Math.abs(mesh[i + 6] - 185) < 1e-4 ||
          Math.abs(mesh[i + 6] - 215) < 1e-4,
      );
    }
    assert.ok(mesh[i + 9] >= 0 && mesh[i + 9] <= 1);
  }
  assert.ok(found);
});
test("A ignores per-point source changes", () => {
  const s = activeStroke(initialState(200, 100));
  s.points = [
    { id: "a", x: 20, y: 50, factor: 1 },
    { id: "b", x: 180, y: 50, factor: 1 },
  ];
  const samples = sampleCurve(s),
    before = ribbonMesh(samples, s, "A");
  s.points[1].source = { angle: 40, length: 90 };
  assert.deepEqual(ribbonMesh(samples, s, "A"), before);
});
test("vertex carries curve center, unit normal and signed half-width offset", () => {
  const s = activeStroke(initialState(200, 100));
  s.width = 30;
  s.points = [
    { id: "a", x: 20, y: 50, factor: 1 },
    { id: "b", x: 180, y: 50, factor: 1 },
  ];
  const mesh = ribbonMesh(sampleCurve(s), s, "A");
  for (let i = 0; i < mesh.length; i += ribbonStride) {
    assert.ok(Math.abs(Math.hypot(mesh[i + 2], mesh[i + 3]) - 1) < 1e-5);
    const edge = mesh[i + 8];
    assert.ok(edge === 0 || edge === 1);
    // Horizontal line, factor 1: offset is ± half the base width.
    assert.ok(Math.abs(Math.abs(mesh[i + 10]) - 15) < 1e-5);
    assert.equal(Math.sign(mesh[i + 10]), Math.sign(edge - 0.5));
  }
});
test("B mesh splits color intervals and is finite at zero widths and coincident points", () => {
  const s = activeStroke(initialState(200, 100));
  s.points = [
    { id: "a", x: 10, y: 50, factor: 0 },
    { id: "b", x: 100, y: 50, factor: 1 },
    { id: "c", x: 190, y: 50, factor: 0 },
  ];
  const mesh = ribbonMesh(sampleCurve(s, 37), s, "B");
  assert.ok([...mesh].every(Number.isFinite));
  assert.equal(mesh.byteLength, mesh.length * Float32Array.BYTES_PER_ELEMENT);
  const weights = [...mesh].filter((_, i) => i % ribbonStride === 9);
  assert.ok(weights.includes(0) && weights.includes(1));
  const duplicate = {
    ...s.points[1],
    id: "d",
    source: { angle: 30, length: 100 },
  };
  s.points.splice(2, 0, duplicate);
  assert.equal(curvePoints(s.points)[1].id, "d");
  assert.equal(pointSource(s, curvePoints(s.points)[1]).angle, 30);
  assert.ok([...ribbonMesh(sampleCurve(s), s, "B")].every(Number.isFinite));
});
