import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fieldFromLuminance,
  traceFlow,
  tracePoints,
} from "../src/flow-field.ts";

/** Horizontal stripes: gradients point vertically, so the flow must run horizontally. */
function stripes(width: number, height: number) {
  const lum = new Float32Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      lum[y * width + x] = Math.sin((y / height) * Math.PI * 6) * 0.5 + 0.5;
  return lum;
}

test("flow field of horizontal stripes traces horizontally through the seed", () => {
  const field = fieldFromLuminance(stripes(64, 48), 64, 48);
  const iw = 640,
    ih = 480;
  const trace = traceFlow(field, { x: 320, y: 240 }, iw, ih, 400);
  assert.ok(trace.length > 20);
  for (const p of trace) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
    assert.ok(Math.abs(p.y - 240) < 24, `stayed near the seed row: ${p.y}`);
  }
  // Bidirectional: the trace extends to both sides of the seed.
  const xs = trace.map((p) => p.x);
  assert.ok(Math.min(...xs) < 300 && Math.max(...xs) > 340);
});

test("trace resampling returns evenly spaced points with exact endpoints", () => {
  const trace = Array.from({ length: 101 }, (_, i) => ({ x: i * 2, y: 7 }));
  const points = tracePoints(trace, 6);
  assert.equal(points.length, 6);
  assert.deepEqual(points[0], { x: 0, y: 7 });
  assert.deepEqual(points[5], { x: 200, y: 7 });
  for (let i = 1; i < points.length; i++)
    assert.ok(Math.abs(points[i].x - points[i - 1].x - 40) < 1e-6);
});

test("degenerate traces stay usable", () => {
  assert.equal(tracePoints([{ x: 5, y: 5 }], 8).length, 1);
  const collapsed = tracePoints(
    [
      { x: 5, y: 5 },
      { x: 5, y: 5 },
    ],
    8,
  );
  assert.equal(collapsed.length, 2);
});
