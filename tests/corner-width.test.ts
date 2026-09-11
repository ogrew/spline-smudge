import { test } from "node:test";
import assert from "node:assert/strict";
import { randomizeWidthsByCorner } from "../src/geometry.ts";
const points = (xy: number[][]) =>
  xy.map(([x, y], i) => ({
    x,
    y,
    id: String(i),
    factor: 3,
    source: { angle: 42, length: 50 },
  }));
test("corner widths distinguish acute, right and obtuse angles in either direction", () => {
  for (const sign of [-1, 1]) {
    for (const [x, y, acute] of [
      [1, 1, true],
      [0, 1, false],
      [-1, 1, false],
      [-1, 0, false],
      [1, 0, true],
    ] as const) {
      const p = points([
        [1, 0],
        [0, 0],
        [x, y * sign],
      ]);
      assert.equal(
        randomizeWidthsByCorner(p, () => 0)[1].factor,
        acute ? 2 : 0,
      );
      assert.equal(
        randomizeWidthsByCorner(p, () => 0.999999)[1].factor,
        acute ? 10 : 0.5,
      );
      const mid = randomizeWidthsByCorner(p, () => 0.5);
      assert.equal(mid[1].factor, acute ? 6 : 0.25);
      assert.equal(mid[0].factor, 1);
      assert.equal(mid[2].factor, 1);
      assert.deepEqual(
        mid.map(({ factor, ...rest }) => rest),
        p.map(({ factor, ...rest }) => rest),
      );
      assert.ok(p.every((p) => p.factor === 3));
    }
  }
});
test("undefined corner angles and short paths use unit width", () => {
  for (const xy of [
    [],
    [[1, 1]],
    [
      [1, 1],
      [2, 2],
    ],
    [
      [0, 0],
      [0, 0],
      [1, 1],
    ],
    [
      [0, 0],
      [1, 1],
      [1, 1],
    ],
  ]) {
    assert.ok(randomizeWidthsByCorner(points(xy)).every((p) => p.factor === 1));
  }
});
