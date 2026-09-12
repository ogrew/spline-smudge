import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
const ready = async (page: any) => {
  await page.waitForFunction(() => (window as any).smudgeDebug?.ready);
};
const debug = async (page: any) =>
  page.evaluate(() => (window as any).smudgeDebug.state);
async function download(page: any, name: string) {
  const wait = page.waitForEvent("download");
  await page.locator("#export").click();
  const file = await wait;
  await file.saveAs(`/private/tmp/${name}.png`);
  await expect(page.locator("#status")).toContainText("書き出しました");
  const buffer = await readFile(`/private/tmp/${name}.png`);
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    filename: file.suggestedFilename(),
    bytes: buffer,
  };
}
async function fixture(page: any, format = "image/png") {
  const data = await page.evaluate((format: string) => {
    const c = document.createElement("canvas");
    c.width = 160;
    c.height = 100;
    const x = c.getContext("2d")!;
    x.fillStyle = "#ff0000";
    x.fillRect(0, 0, 80, 50);
    x.fillStyle = "#00ff00";
    x.fillRect(80, 0, 80, 50);
    x.fillStyle = "#0000ff";
    x.fillRect(0, 50, 80, 50);
    return c.toDataURL(format);
  }, format);
  return Buffer.from(data.split(",")[1], "base64");
}
test("editor, GPU replay, PNG output, image orientation and recovery", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto("/");
  await ready(page);
  await expect(page.locator("#width")).toHaveAttribute("max", "160");
  expect((await debug(page)).strokes[0].width).toBeLessThanOrEqual(160);
  for (const value of [0, 0.5, 0.999999]) {
    await page.evaluate((v) => {
      const random = Math.random;
      try {
        Math.random = () => v;
        (document.querySelector("#sample") as HTMLButtonElement).click();
      } finally {
        Math.random = random;
      }
    }, value);
    await ready(page);
    const points = (await debug(page)).strokes[0].points;
    expect(points.length).toBe(4 + Math.floor(value * 9));
    expect(
      points.every(
        (p: any) => p.x >= 0 && p.x <= 1600 && p.y >= 0 && p.y <= 1100,
      ),
    ).toBe(true);
    expect(points[0].x).toBeCloseTo(1600 * (0.05 + value * 0.9));
    expect(points[0].y).toBeCloseTo(1100 * (0.05 + value * 0.9));
    for (const point of points) {
      expect(point.factor).toBe(1); // All positions coincide with a constant RNG.
      expect(point.source.angle).toBe(Math.round(value * 360 - 180));
      expect(point.source.length).toBe(
        Math.max(1, Math.round(1100 * (0.05 + value * 0.45))),
      );
    }
  }
  await page.locator("#sample").click();
  await ready(page);
  const generated = (await debug(page)).strokes[0].points;
  expect(generated[0].factor).toBe(1);
  expect(generated.at(-1).factor).toBe(1);
  for (let i = 1; i < generated.length - 1; i++) {
    const a = generated[i - 1],
      p = generated[i],
      b = generated[i + 1];
    const acute = (a.x - p.x) * (b.x - p.x) + (a.y - p.y) * (b.y - p.y) > 0;
    expect(p.factor).toBeGreaterThanOrEqual(acute ? 2 : 0);
    expect(p.factor).toBeLessThanOrEqual(acute ? 10 : 0.5);
    expect(p.factor * 20).toBeCloseTo(Math.round(p.factor * 20));
  }
  for (const kind of ["catmull", "bspline", "centripetal", "natural", "tcb"]) {
    await page.locator("#kind").selectOption(kind);
    await ready(page);
    expect((await debug(page)).kind).toBe(kind);
    expect(
      await page.evaluate(() => (window as any).smudgeDebug.gl.getError()),
    ).toBe(0);
  }
  const before = (await debug(page)).strokes;
  await page.locator("#mode-b").click();
  await ready(page);
  expect((await debug(page)).strokes).toEqual(before);
  await page.locator("#mode-a").click();
  await ready(page);
  expect((await debug(page)).strokes).toEqual(before);
  for (const value of ["0", "10"]) {
    await page.locator("#factor").fill(value);
    await ready(page);
    expect((await debug(page)).strokes[0].points[2].factor).toBe(Number(value));
  }
  await page.locator("#undo").click();
  await ready(page);
  expect((await debug(page)).strokes[0].points[2].factor).toBe(0);
  await page.locator("#undo").click();
  await ready(page);
  await page.locator("#clear").click();
  await ready(page);
  const rect = await page.locator("#art").boundingBox();
  if (!rect) throw new Error("No image");
  for (const [x, y] of [
    [0.15, 0.3],
    [0.3, 0.7],
    [0.5, 0.3],
    [0.7, 0.65],
    [0.85, 0.35],
  ])
    await page.mouse.click(rect.x + x * rect.width, rect.y + y * rect.height);
  await ready(page);
  expect((await debug(page)).strokes[0].points.length).toBe(5);
  await page.mouse.move(rect.x + 0.5 * rect.width, rect.y + 0.3 * rect.height);
  await page.mouse.down();
  await page.mouse.move(
    rect.x + 0.52 * rect.width,
    rect.y + 0.42 * rect.height,
    { steps: 5 },
  );
  await page.mouse.up();
  await ready(page);
  expect((await debug(page)).strokes[0].points[2].y).toBeCloseTo(
    1100 * 0.42,
    0,
  );
  await page.mouse.dblclick(
    rect.x + 0.52 * rect.width,
    rect.y + 0.42 * rect.height,
  );
  await ready(page);
  expect((await debug(page)).strokes[0].points.length).toBe(4);
  await page.locator("#undo").click();
  await ready(page);
  expect((await debug(page)).strokes[0].points.length).toBe(5);
  await page.locator("#guides").uncheck();
  expect(await page.locator(".point-number").count()).toBe(0);
  expect(await page.locator("#overlay > *").count()).toBe(0);
  await page.locator("#guides").check();
  await expect(page.locator("#tool-source")).toHaveCount(0);
  await expect(page.locator("#load")).toContainText("画像を選択");
  await expect(page.locator("#export")).toHaveText("エクスポート ↓");
  await page.mouse.move(rect.x + 0.15 * rect.width, rect.y + 0.3 * rect.height);
  await page.mouse.down();
  await page.mouse.move(rect.x + 0.2 * rect.width, rect.y + 0.4 * rect.height, {
    steps: 4,
  });
  await page.mouse.up();
  await ready(page);
  let st = (await debug(page)).strokes[0];
  expect(st.source.x).toBe(st.points[0].x);
  expect(st.source.y).toBe(st.points[0].y);
  await page.mouse.dblclick(
    rect.x + 0.2 * rect.width,
    rect.y + 0.4 * rect.height,
  );
  await ready(page);
  st = (await debug(page)).strokes[0];
  expect(st.source.x).toBe(st.points[0].x);
  expect(st.source.y).toBe(st.points[0].y);
  await page.locator("#undo").click();
  await ready(page);
  await page.locator("#angle").fill("45");
  await ready(page);
  await page.locator("#source-length").fill("200");
  await ready(page);
  st = (await debug(page)).strokes[0];
  expect(st.source).toEqual({
    x: st.points[0].x,
    y: st.points[0].y,
    angle: 45,
    length: 200,
  });
  await page.locator("#mode-b").click();
  await ready(page);
  await expect(page.locator("#pickup")).toHaveCount(0);
  await page.mouse.click(
    rect.x + 0.52 * rect.width,
    rect.y + 0.42 * rect.height,
  );
  const sourcesBefore = (await debug(page)).strokes[0].points.map(
    (p: any) => p.source,
  );
  await page.locator("#angle").fill("15");
  await ready(page);
  await page.locator("#source-length").fill("120");
  await ready(page);
  let edited = (await debug(page)).strokes[0];
  expect(edited.points[2].source).toEqual({ angle: 15, length: 120 });
  expect(edited.points[1].source).toEqual(sourcesBefore[1]);
  await page.locator("#undo").click();
  await ready(page);
  expect((await debug(page)).strokes[0].points[2].source.length).toBe(
    sourcesBefore[2].length,
  );
  await page.locator("#redo").click();
  await ready(page);
  await page.locator("#mode-a").click();
  await ready(page);
  expect(await page.locator("#angle").inputValue()).toBe("45");
  expect(await page.locator("#source-length").inputValue()).toBe("200");
  await page.locator("#mode-b").click();
  await ready(page);
  expect(await page.locator("#angle").inputValue()).toBe("15");
  expect(await page.locator("#source-length").inputValue()).toBe("120");
  await page.evaluate(() => {
    const p = document.querySelector("#angle") as HTMLInputElement;
    p.value = "20";
    p.dispatchEvent(new Event("input"));
    (document.querySelector("#cancel") as HTMLButtonElement).click();
  });
  await expect(page.locator("#recalculate")).toBeVisible();
  await expect(page.locator("#export")).toBeDisabled();
  await page.locator("#recalculate").click();
  await ready(page);
  await page.evaluate(() => {
    const p = document.querySelector("#angle") as HTMLInputElement;
    for (let i = 1; i <= 12; i++) {
      p.value = String(i * 5);
      p.dispatchEvent(new Event("input"));
    }
  });
  await ready(page);
  expect((await debug(page)).strokes[0].points[2].source.angle).toBe(60);
  await page.locator("#resolution").selectOption("5000");
  await ready(page);
  console.log("B full resolution", await page.locator("#status").textContent());
  let start = Date.now();
  const b = await download(page, "spline-smudge-verified-B-5000");
  console.log("B export ms", Date.now() - start);
  expect([b.width, b.height]).toEqual([5000, 3438]);
  expect(b.filename).toMatch(/^tcb_B_.*\.png$/);
  await page.screenshot({ path: "/private/tmp/spline-smudge-per-point-B.png" });
  await page.locator("#mode-a").click();
  await ready(page);
  console.log("A full resolution", await page.locator("#status").textContent());
  start = Date.now();
  const a = await download(page, "spline-smudge-verified-A-5000");
  console.log("A export ms", Date.now() - start);
  expect([a.width, a.height]).toEqual([5000, 3438]);
  expect(a.bytes.equals(b.bytes)).toBe(false);
  await page.screenshot({ path: "/private/tmp/spline-smudge-verified-ui.png" });
  await page.locator("#one").click();
  await page.screenshot({ path: "/private/tmp/spline-smudge-100-percent.png" });
  await page.locator("#fit").click();
  await page.locator("#guides").uncheck();
  const withoutGuides = await download(page, "spline-smudge-guide-free");
  expect(withoutGuides.bytes.equals(a.bytes)).toBe(true);
  await page.locator("#mode-b").click();
  await ready(page);
  await page.locator("#mode-a").click();
  await ready(page);
  const replay = await download(page, "spline-smudge-replay");
  expect(replay.bytes.equals(a.bytes)).toBe(true);
  await page.locator("#file").setInputFiles({
    name: "transparent.png",
    mimeType: "image/png",
    buffer: await fixture(page),
  });
  await ready(page);
  await expect(page.locator("#image-name")).toHaveText("transparent.png");
  await page.locator("#resolution").selectOption("original");
  await ready(page);
  const png = await download(page, "spline-smudge-transparent");
  expect([png.width, png.height]).toEqual([160, 100]);
  const pixels = await page.evaluate(async (data: string) => {
    const im = await createImageBitmap(
      await (await fetch(`data:image/png;base64,${data}`)).blob(),
    );
    const c = document.createElement("canvas");
    c.width = im.width;
    c.height = im.height;
    const x = c.getContext("2d")!;
    x.drawImage(im, 0, 0);
    return [
      [20, 20],
      [120, 20],
      [20, 80],
      [120, 80],
    ].map(([a, b]) => Array.from(x.getImageData(a, b, 1, 1).data));
  }, png.bytes.toString("base64"));
  expect(pixels).toEqual([
    [255, 0, 0, 255],
    [0, 255, 0, 255],
    [0, 0, 255, 255],
    [243, 240, 232, 255],
  ]);
  // EXIF orientation 6: the browser decoder must rotate a landscape JPEG clockwise.
  const jpg = await fixture(page, "image/jpeg");
  const exif = Buffer.from(
    "45786966000049492a0008000000010012010300010000000600000000000000",
    "hex",
  );
  const app1 = Buffer.alloc(4);
  app1[0] = 255;
  app1[1] = 225;
  app1.writeUInt16BE(exif.length + 2, 2);
  const rotated = Buffer.concat([
    jpg.subarray(0, 2),
    app1,
    exif,
    jpg.subarray(2),
  ]);
  await page.locator("#file").setInputFiles({
    name: "rotated.jpg",
    mimeType: "image/jpeg",
    buffer: rotated,
  });
  await expect(page.locator("#image-name")).toHaveText("rotated.jpg");
  await ready(page);
  await expect(page.locator("#image-size")).toHaveText("100 × 160");
  await page.locator("#resolution").selectOption("original");
  await ready(page);
  const portrait = await download(page, "spline-smudge-rotated");
  expect([portrait.width, portrait.height]).toEqual([100, 160]);
  await page.locator("#file").setInputFiles({
    name: "invalid.png",
    mimeType: "image/png",
    buffer: Buffer.from("not an image"),
  });
  await expect(page.locator("#status")).toContainText("JPGまたはPNG");
  await expect(page.locator("#image-name")).toHaveText("rotated.jpg");
  await page.evaluate(() => {
    const ext = (window as any).smudgeDebug.gl.getExtension(
      "WEBGL_lose_context",
    );
    ext.loseContext();
    setTimeout(() => ext.restoreContext(), 100);
  });
  await ready(page);
  expect(
    await page.evaluate(() => (window as any).smudgeDebug.gl.getError()),
  ).toBe(0);
  expect(errors).toEqual([]);
});

test("B shader reproduces point colors and interpolates RGB without picking up intervening pixels", async ({
  page,
}) => {
  await page.goto("/");
  await ready(page);
  const result = await page.evaluate(async () => {
    const { Renderer } = await import("/src/renderer.ts");
    const { initialState, activeStroke } = await import("/src/model.ts");
    const image = document.createElement("canvas");
    image.width = 200;
    image.height = 150;
    const x = image.getContext("2d")!;
    x.fillStyle = "#ffffff";
    x.fillRect(0, 0, 200, 150);
    for (const [pos, color] of [
      [20, "#ff0000"],
      [100, "#00ff00"],
      [180, "#0000ff"],
    ] as const) {
      x.fillStyle = color;
      x.fillRect(pos - 10, 0, 20, 150);
    }
    const target = document.createElement("canvas"),
      r = new Renderer(target),
      state = initialState(200, 150);
    state.mode = "B";
    state.longEdge = 200;
    const s = activeStroke(state);
    s.width = 20;
    s.points = [20, 100, 180].map((pos, i) => ({
      id: String(i),
      x: pos,
      y: 75,
      factor: 1,
      source: { angle: 90, length: 10 },
    }));
    const pixels = async () => {
      await r.render(
        image,
        200,
        150,
        state,
        () => false,
        () => {},
      );
      const blob = await r.exportPNG(),
        bitmap = await createImageBitmap(blob),
        c = document.createElement("canvas");
      c.width = 200;
      c.height = 150;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(bitmap, 0, 0);
      const result = [21, 60, 100, 140, 178].map((pos) =>
        Array.from(ctx.getImageData(pos, 75, 1, 1).data),
      );
      bitmap.close();
      return result;
    };
    const baseline = await pixels();
    // Perceptual interpolation: endpoints stay put, midpoints move.
    state.mix = { mode: "oklab", turns: 1 };
    const oklab = await pixels();
    state.mix = { mode: "oklch", turns: 1 };
    const oklch = await pixels();
    state.mix = { mode: "hueSpin", turns: 1 };
    const hueSpin = await pixels();
    state.mix = { mode: "srgb", turns: 1 };
    x.fillStyle = "#ffff00";
    x.fillRect(45, 0, 30, 150);
    // A new source object invalidates the image cache, keeping settings identical.
    const copy = document.createElement("canvas");
    copy.width = 200;
    copy.height = 150;
    copy.getContext("2d")!.drawImage(image, 0, 0);
    await r.render(
      copy,
      200,
      150,
      state,
      () => false,
      () => {},
    );
    const b = await createImageBitmap(await r.exportPNG());
    const c = document.createElement("canvas");
    c.width = 200;
    c.height = 150;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(b, 0, 0);
    const changed = Array.from(ctx.getImageData(60, 75, 1, 1).data);
    const glError = r.gl.getError();
    r.gl.getExtension("WEBGL_lose_context")?.loseContext();
    return { baseline, oklab, oklch, hueSpin, changed, glError };
  });
  const expected = [
    [255, 0, 0, 255],
    [128, 128, 0, 255],
    [0, 255, 0, 255],
    [0, 128, 128, 255],
    [0, 0, 255, 255],
  ];
  const near = (pixel: number[], target: number[], tolerance: number) =>
    pixel.forEach((channel, j) =>
      expect(Math.abs(channel - target[j])).toBeLessThanOrEqual(tolerance),
    );
  result.baseline.forEach((pixel: number[], i: number) =>
    near(pixel, expected[i], 4),
  );
  // Endpoints reproduce the sampled colors in every interpolation mode.
  for (const mode of [result.oklab, result.oklch, result.hueSpin])
    for (const i of [0, 2, 4]) near(mode[i], expected[i], 4);
  // Red→green midpoint: OKLab keeps brightness, OKLCH passes through orange.
  near(result.oklab[1], [208, 168, 0, 255], 6);
  near(result.oklch[1], [249, 149, 0, 255], 6);
  // A full extra hue turn flips the midpoint hue while endpoints stay exact.
  const hueDistance = Math.hypot(
    result.hueSpin[1][0] - result.oklch[1][0],
    result.hueSpin[1][1] - result.oklch[1][1],
    result.hueSpin[1][2] - result.oklch[1][2],
  );
  expect(hueDistance).toBeGreaterThan(60);
  expect(result.changed).toEqual(result.baseline[1]);
  expect(result.glError).toBe(0);
});

test("multiple stroke selection, duplication, visibility, ordering and history", async ({
  page,
}) => {
  await page.goto("/");
  await ready(page);
  const initial = (await debug(page)).strokes[0];
  await page.locator("#stroke-copy").click();
  await ready(page);
  let state = await debug(page),
    copy = state.strokes[1];
  expect(copy.name).toBe("Stroke 02");
  expect(copy.points.length).toBe(initial.points.length);
  expect(copy.points[0].id).not.toBe(initial.points[0].id);
  await page.locator("#kind").selectOption("natural");
  await ready(page);
  expect((await debug(page)).strokes[0]).toEqual(initial);
  await page.locator("#mode-b").click();
  await ready(page);
  const rect = await page.locator("#art").boundingBox();
  if (!rect) throw new Error("No image");
  const p = copy.points[0];
  await page.mouse.click(
    rect.x + (p.x / 1600) * rect.width,
    rect.y + (p.y / 1100) * rect.height,
  );
  await page.locator("#angle").fill("30");
  await ready(page);
  const edited = (await debug(page)).strokes[1];
  expect(edited.points[0].source.angle).toBe(30);
  await page.locator(`[data-select-stroke="${initial.id}"]`).click();
  expect((await debug(page)).strokes[0]).toEqual(initial);
  expect(await page.locator("#kind").inputValue()).toBe("natural");
  expect(await page.locator(".point").count()).toBe(initial.points.length);
  await page.locator("#stroke-up").click();
  await ready(page);
  expect((await debug(page)).strokes.map((s: any) => s.id)).toEqual([
    copy.id,
    initial.id,
  ]);
  expect(
    await page
      .locator("[data-select-stroke]")
      .first()
      .getAttribute("data-select-stroke"),
  ).toBe(initial.id);
  await page.locator("#undo").click();
  await ready(page);
  expect((await debug(page)).strokes.map((s: any) => s.id)).toEqual([
    initial.id,
    copy.id,
  ]);
  await page.locator(`[data-visibility="${initial.id}"]`).uncheck();
  await ready(page);
  expect(await page.locator("#overlay > *").count()).toBe(0);
  const count = initial.points.length;
  await page.mouse.click(
    rect.x + rect.width * 0.45,
    rect.y + rect.height * 0.45,
  );
  expect((await debug(page)).strokes[0].points.length).toBe(count);
  await page.locator("#undo").click();
  await ready(page);
  expect((await debug(page)).strokes[0].visible).toBe(true);
  await page.locator("#stroke-add").click();
  await ready(page);
  state = await debug(page);
  expect(state.strokes.length).toBe(3);
  expect(state.strokes[2].points).toEqual([]);
  await page.mouse.click(rect.x + rect.width * 0.4, rect.y + rect.height * 0.4);
  await ready(page);
  expect((await debug(page)).strokes[2].points.length).toBe(1);
  await page.locator("#stroke-delete").click();
  await ready(page);
  expect((await debug(page)).strokes.length).toBe(2);
  await page.locator("#undo").click();
  await ready(page);
  expect((await debug(page)).strokes[2].points.length).toBe(1);
  await page.locator("#stroke-delete").click();
  await ready(page);
  await page.locator("#resolution").selectOption("5000");
  await ready(page);
  const output = await download(page, "spline-smudge-multiple");
  expect([output.width, output.height]).toEqual([5000, 3438]);
  expect(output.filename).toMatch(/^natural_B_/);
  await page.screenshot({ path: "/private/tmp/spline-smudge-multiple-ui.png" });
  await page.locator("#stroke-delete").click();
  await ready(page);
  await page.locator("#stroke-delete").click();
  await ready(page);
  state = await debug(page);
  expect(state.strokes.length).toBe(1);
  expect(state.strokes[0].points).toEqual([]);
});

test("all visible strokes are composited in order in A and B exports", async ({
  page,
}) => {
  await page.goto("/");
  await ready(page);
  const results = await page.evaluate(async () => {
    const { Renderer } = await import("/src/renderer.ts");
    const { initialState, activeStroke, addStroke, moveStroke } =
      await import("/src/model.ts");
    const source = document.createElement("canvas");
    source.width = 200;
    source.height = 150;
    const x = source.getContext("2d")!;
    x.fillStyle = "white";
    x.fillRect(0, 0, 200, 150);
    x.fillStyle = "red";
    x.fillRect(10, 60, 20, 30);
    x.fillRect(170, 60, 20, 30);
    x.fillStyle = "blue";
    x.fillRect(90, 10, 20, 20);
    x.fillRect(90, 120, 20, 20);
    const r = new Renderer(document.createElement("canvas")),
      state = initialState(200, 150);
    state.longEdge = 200;
    const red = activeStroke(state);
    red.width = 20;
    red.source = { x: 20, y: 75, angle: 90, length: 10 };
    red.points = [20, 180].map((x, i) => ({
      id: `r${i}`,
      x,
      y: 75,
      factor: 1,
      source: { angle: 90, length: 10 },
    }));
    const blue = addStroke(state);
    blue.width = 20;
    blue.source = { x: 100, y: 20, angle: 0, length: 10 };
    blue.points = [20, 130].map((y, i) => ({
      id: `b${i}`,
      x: 100,
      y,
      factor: 1,
      source: { angle: 0, length: 10 },
    }));
    const render = async () => {
      await r.render(
        source,
        200,
        150,
        state,
        () => false,
        () => {},
      );
      const b = await createImageBitmap(await r.exportPNG()),
        c = document.createElement("canvas");
      c.width = 200;
      c.height = 150;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(b, 0, 0);
      const pixels = [
        [100, 75],
        [60, 75],
        [100, 50],
      ].map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data));
      b.close();
      return pixels;
    };
    const result = [];
    for (const mode of ["A", "B"] as const) {
      state.mode = mode;
      state.strokes = [red, blue];
      blue.visible = true;
      state.activeId = blue.id;
      const top = await render();
      moveStroke(state, -1);
      const reordered = await render();
      state.strokes = [red, blue];
      blue.visible = false;
      const hidden = await render();
      result.push({ mode, top, reordered, hidden });
    }
    r.gl.getExtension("WEBGL_lose_context")?.loseContext();
    return result;
  });
  for (const r of results) {
    expect(r.top).toEqual([
      [0, 0, 255, 255],
      [255, 0, 0, 255],
      [0, 0, 255, 255],
    ]);
    expect(r.reordered[0]).toEqual([255, 0, 0, 255]);
    expect(r.hidden).toEqual([
      [255, 0, 0, 255],
      [255, 0, 0, 255],
      [255, 255, 255, 255],
    ]);
  }
});

test("integer base width, point factor reset, and Shift wheel angle editing", async ({
  page,
}) => {
  await page.goto("/");
  await ready(page);
  await expect(page.locator("#width")).toHaveAttribute("step", "1");
  await expect(page.locator("#width")).toHaveAttribute("min", "1");
  await page.locator("#width").evaluate((input: HTMLInputElement) => {
    input.value = "42.6";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new Event("change"));
  });
  await ready(page);
  expect(Number.isInteger((await debug(page)).strokes[0].width)).toBe(true);
  await page.locator("#factor").fill("2.5");
  await ready(page);
  await page.locator("#factor-reset").click();
  await ready(page);
  expect((await debug(page)).strokes[0].points[2].factor).toBe(1);
  await expect(page.locator("#factor-value")).toHaveText("1.00 ×");
  await page.locator("#undo").click();
  await ready(page);
  expect((await debug(page)).strokes[0].points[2].factor).toBe(2.5);
  await page.locator("#mode-b").click();
  await ready(page);
  const before = (await debug(page)).strokes[0],
    angle = before.points[2].source.angle,
    zoom = await page.locator("#zoom-label").textContent();
  const box = await page.locator("#art").boundingBox();
  if (!box) throw new Error("No image");
  const position = { x: box.x + box.width * 0.5, y: box.y + box.height * 0.5 };
  await page.locator("#stage").evaluate((stage, p) => {
    for (let i = 0; i < 3; i++)
      stage.dispatchEvent(
        new WheelEvent("wheel", {
          clientX: p.x,
          clientY: p.y,
          deltaY: -120,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
  }, position);
  await ready(page);
  expect((await debug(page)).strokes[0].points[2].source.angle).toBe(
    ((((angle + 30 + 180) % 360) + 360) % 360) - 180,
  );
  expect(await page.locator("#zoom-label").textContent()).toBe(zoom);
  expect((await debug(page)).strokes[0].points[1]).toEqual(before.points[1]);
  await page.locator("#undo").click();
  await ready(page);
  expect((await debug(page)).strokes[0].points[2].source.angle).toBe(angle);
  // Actual keyboard/wheel events: downward movement decreases the selected angle.
  await page.mouse.move(position.x, position.y);
  await page.keyboard.down("Shift");
  await page.mouse.wheel(0, 120);
  await page.keyboard.up("Shift");
  await expect
    .poll(async () => (await debug(page)).strokes[0].points[2].source.angle)
    .toBe(((((angle - 10 + 180) % 360) + 360) % 360) - 180);
  expect(await page.locator("#zoom-label").textContent()).toBe(zoom);
  await page.locator("#mode-a").click();
  await ready(page);
  const a = (await debug(page)).strokes[0].source.angle;
  await page.locator("#stage").evaluate(
    (stage, p) =>
      stage.dispatchEvent(
        new WheelEvent("wheel", {
          clientX: p.x,
          clientY: p.y,
          deltaY: -120,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    position,
  );
  await ready(page);
  expect((await debug(page)).strokes[0].source.angle).toBe(
    ((((a + 10 + 180) % 360) + 360) % 360) - 180,
  );
  await page.locator("#stroke-add").click();
  await ready(page);
  await expect(page.locator("#factor-reset")).toBeDisabled();
  await page.locator("#stage").evaluate(
    (stage, p) =>
      stage.dispatchEvent(
        new WheelEvent("wheel", {
          clientX: p.x,
          clientY: p.y,
          deltaY: -120,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    position,
  );
  expect(await page.locator("#zoom-label").textContent()).toBe(zoom);
  await page.mouse.move(position.x, position.y);
  await page.mouse.wheel(0, 120);
  await expect
    .poll(() => page.locator("#zoom-label").textContent())
    .not.toBe(zoom);
});

test("no-op editing, blank double click history, point drag and cursor zoom", async ({
  page,
}) => {
  await page.goto("/");
  await ready(page);
  await expect(page.locator("#undo")).toBeDisabled();

  const initial = (await debug(page)).strokes[0].points;
  const art = await page.locator("#art").boundingBox();
  if (!art) throw new Error("No image");
  const screen = (p: { x: number; y: number }) => ({
    x: art.x + (p.x / 1600) * art.width,
    y: art.y + (p.y / 1100) * art.height,
  });

  // Selecting an existing point and touching an unchanged slider add no history.
  const selectedPosition = screen(initial[0]);
  await page.mouse.click(selectedPosition.x, selectedPosition.y);
  await expect(page.locator("#undo")).toBeDisabled();
  await page.locator("#width").evaluate((input: HTMLInputElement) => {
    input.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.locator("#undo")).toBeDisabled();

  // Find empty image space, then verify a double click leaves no point or history.
  const empty = await page.evaluate(() => {
    const points = (window as any).smudgeDebug.state.strokes[0].points;
    for (let y = 100; y < 1100; y += 100)
      for (let x = 100; x < 1600; x += 100)
        if (points.every((p: any) => Math.hypot(p.x - x, p.y - y) > 100))
          return { x, y };
    throw new Error("No empty position");
  });
  const emptyPosition = screen(empty);
  await page.mouse.dblclick(emptyPosition.x, emptyPosition.y, { delay: 50 });
  expect((await debug(page)).strokes[0].points).toEqual(initial);
  await expect(page.locator("#undo")).toBeDisabled();

  // The first real pointer movement creates one undoable edit.
  await page.mouse.move(selectedPosition.x, selectedPosition.y);
  await page.mouse.down();
  await page.mouse.move(selectedPosition.x + 24, selectedPosition.y + 18);
  await page.mouse.up();
  await ready(page);
  expect((await debug(page)).strokes[0].points[0]).not.toEqual(initial[0]);
  await expect(page.locator("#undo")).toBeEnabled();
  await page.locator("#undo").click();
  await ready(page);
  expect((await debug(page)).strokes[0].points).toEqual(initial);
  await expect(page.locator("#undo")).toBeDisabled();

  // Wheel zoom keeps the image coordinate under the cursor fixed on screen.
  const before = await page.locator("#art").boundingBox();
  if (!before) throw new Error("No image before zoom");
  const cursor = {
    x: before.x + before.width * 0.31,
    y: before.y + before.height * 0.67,
  };
  const beforeRelative = {
    x: (cursor.x - before.x) / before.width,
    y: (cursor.y - before.y) / before.height,
  };
  const sampleComputations = (await debug(page)).overlaySampleComputations;
  await page.mouse.move(cursor.x, cursor.y);
  await page.mouse.wheel(0, -240);
  const after = await page.locator("#art").boundingBox();
  if (!after) throw new Error("No image after zoom");
  expect((cursor.x - after.x) / after.width).toBeCloseTo(beforeRelative.x, 3);
  expect((cursor.y - after.y) / after.height).toBeCloseTo(beforeRelative.y, 3);
  expect((await debug(page)).overlaySampleComputations).toBe(
    sampleComputations,
  );
});

test("clicking selects the closest control point, not the first within range", async ({
  page,
}) => {
  await page.goto("/");
  await ready(page);
  await page.locator("#clear").click();
  await ready(page);
  const rect = await page.locator("#art").boundingBox();
  if (!rect) throw new Error("No image");
  const y = rect.y + rect.height * 0.5,
    x1 = rect.x + rect.width * 0.4;
  await page.mouse.click(x1, y);
  await ready(page);
  await page.mouse.click(x1 + 25, y);
  await ready(page);
  // Drag the second point to about 7 CSS px from the first; both now sit
  // inside the 11px hit radius of a click on the second point.
  await page.mouse.move(x1 + 25, y);
  await page.mouse.down();
  await page.mouse.move(x1 + 7, y, { steps: 4 });
  await page.mouse.up();
  await ready(page);
  await page.mouse.click(x1 + 7, y);
  await expect(page.locator("#selected-name")).toHaveText("POINT 02");
  // The hit test stays correct at a different zoom.
  await page.locator("#one").click();
  const zoomed = await page.locator("#art").boundingBox();
  if (!zoomed) throw new Error("No image");
  const second = (await debug(page)).strokes[0].points[1];
  await page.mouse.click(
    zoomed.x + (second.x / 1600) * zoomed.width,
    zoomed.y + (second.y / 1100) * zoomed.height,
  );
  await expect(page.locator("#selected-name")).toHaveText("POINT 02");
  await page.locator("#fit").click();
  // Double-click deletion uses the same hit test and removes the second point.
  const back = await page.locator("#art").boundingBox();
  if (!back) throw new Error("No image");
  await page.mouse.dblclick(
    back.x + (second.x / 1600) * back.width,
    back.y + (second.y / 1100) * back.height,
  );
  await ready(page);
  const points = (await debug(page)).strokes[0].points;
  expect(points.length).toBe(1);
  expect(
    Math.abs(points[0].x - ((x1 - rect.x) / rect.width) * 1600),
  ).toBeLessThan(2);
});

test("renderer clears stale errors and reuses ribbon GPU state", async ({
  page,
}) => {
  await page.goto("/");
  await ready(page);
  const result = await page.evaluate(async () => {
    const { Renderer } = await import("/src/renderer.ts");
    const { initialState, activeStroke, addStroke } =
      await import("/src/model.ts");
    const canvas = document.createElement("canvas"),
      renderer = new Renderer(canvas),
      gl = renderer.gl as any;

    gl.enable(0xffffffff); // Queue INVALID_ENUM before an otherwise valid allocation.
    const target = (renderer as any).target(8, 8);
    (renderer as any).drop(target);
    const allocationError = gl.getError();

    let allocations = 0,
      uploads = 0,
      setups = 0,
      mipmaps = 0;
    const bufferData = gl.bufferData.bind(gl),
      bufferSubData = gl.bufferSubData.bind(gl),
      generateMipmap = gl.generateMipmap.bind(gl),
      ribbonSetup = (renderer as any).ribbonSetup.bind(renderer);
    gl.bufferData = (...args: any[]) => {
      if (args[0] === gl.ARRAY_BUFFER) allocations++;
      return bufferData(...args);
    };
    gl.bufferSubData = (...args: any[]) => {
      if (args[0] === gl.ARRAY_BUFFER) uploads++;
      return bufferSubData(...args);
    };
    gl.generateMipmap = (...args: any[]) => {
      if (args[0] === gl.TEXTURE_2D) mipmaps++;
      return generateMipmap(...args);
    };
    (renderer as any).ribbonSetup = (...args: any[]) => {
      setups++;
      return ribbonSetup(...args);
    };

    const image = document.createElement("canvas"),
      state = initialState(200, 150),
      stroke = activeStroke(state);
    image.width = 200;
    image.height = 150;
    image.getContext("2d")!.fillRect(0, 0, 200, 150);
    state.longEdge = 200;
    stroke.points = [
      { id: "a", x: 20, y: 30, factor: 1 },
      { id: "b", x: 100, y: 120, factor: 1 },
      { id: "c", x: 180, y: 30, factor: 1 },
    ];
    addStroke(state, true);
    for (let i = 0; i < 2; i++)
      await renderer.render(
        image,
        200,
        150,
        state,
        () => false,
        () => {},
      );
    gl.bindTexture(gl.TEXTURE_2D, (renderer as any).complete.texture);
    const usesMipmapFilter =
        gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER) ===
        gl.LINEAR_MIPMAP_LINEAR,
      finalError = gl.getError();
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return {
      allocationError,
      finalError,
      allocations,
      uploads,
      setups,
      mipmaps,
      usesMipmapFilter,
    };
  });
  expect(result).toEqual({
    allocationError: 0,
    finalError: 0,
    allocations: 1,
    uploads: 4,
    setups: 2,
    mipmaps: 2,
    usesMipmapFilter: true,
  });
});

test("photo options change the output, reveal settings only while on, and off matches baseline", async ({
  page,
}) => {
  await page.goto("/");
  await ready(page);
  await expect(page.locator("#reaction-settings")).toBeHidden();
  await expect(page.locator("#shade-settings")).toBeHidden();
  const baseline = await download(page, "spline-smudge-options-baseline");
  // Reaction: one toggle, two selectable algorithms with their own amounts.
  await page.locator("#reaction").check();
  await ready(page);
  await expect(page.locator("#reaction-settings")).toBeVisible();
  await expect(page.locator("#reaction-displace")).toBeVisible();
  await expect(page.locator("#reaction-edge")).toBeHidden();
  const displaced = await download(page, "spline-smudge-options-displace");
  expect(displaced.bytes.equals(baseline.bytes)).toBe(false);
  await page.locator("#reaction-mode").selectOption("edgeWidth");
  await ready(page);
  await expect(page.locator("#reaction-displace")).toBeHidden();
  await expect(page.locator("#reaction-edge")).toBeVisible();
  const edged = await download(page, "spline-smudge-options-edge");
  expect(edged.bytes.equals(baseline.bytes)).toBe(false);
  expect(edged.bytes.equals(displaced.bytes)).toBe(false);
  await page.locator("#reaction").uncheck();
  await ready(page);
  await expect(page.locator("#reaction-settings")).toBeHidden();
  // Fake 3D defaults to 0.65 when first enabled.
  await page.locator("#shade").check();
  await ready(page);
  await expect(page.locator("#shade-settings")).toBeVisible();
  expect(await page.locator("#shade-amount").inputValue()).toBe("0.65");
  const shaded = await download(page, "spline-smudge-options-shade");
  expect(shaded.bytes.equals(baseline.bytes)).toBe(false);
  await page.locator("#shade").uncheck();
  await ready(page);
  // Everything off again restores the exact baseline pixels.
  const restored = await download(page, "spline-smudge-options-restored");
  expect(restored.bytes.equals(baseline.bytes)).toBe(true);
  // Toggles participate in undo and redo.
  await page.locator("#undo").click();
  await ready(page);
  expect((await debug(page)).options.shade.on).toBe(true);
  await page.locator("#redo").click();
  await ready(page);
  expect((await debug(page)).options.shade.on).toBe(false);
  expect(
    await page.evaluate(() => (window as any).smudgeDebug.gl.getError()),
  ).toBe(0);
});

test("B color interpolation select swaps modes and shows the spin slider only for hue rotation", async ({
  page,
}) => {
  await page.goto("/");
  await ready(page);
  await page.locator("#mode-b").click();
  await ready(page);
  await expect(page.locator("#mix-spin-row")).toBeHidden();
  const baseline = await download(page, "spline-smudge-mix-srgb");
  await page.locator("#mix-mode").selectOption("oklab");
  await ready(page);
  const oklab = await download(page, "spline-smudge-mix-oklab");
  expect(oklab.bytes.equals(baseline.bytes)).toBe(false);
  await page.locator("#mix-mode").selectOption("hueSpin");
  await ready(page);
  await expect(page.locator("#mix-spin-row")).toBeVisible();
  expect(await page.locator("#mix-spin").inputValue()).toBe("1");
  const spun = await download(page, "spline-smudge-mix-spin");
  expect(spun.bytes.equals(oklab.bytes)).toBe(false);
  await page.locator("#mix-mode").selectOption("srgb");
  await ready(page);
  await expect(page.locator("#mix-spin-row")).toBeHidden();
  const restored = await download(page, "spline-smudge-mix-restored");
  expect(restored.bytes.equals(baseline.bytes)).toBe(true);
  // Mode changes participate in undo.
  await page.locator("#undo").click();
  await ready(page);
  expect((await debug(page)).mix.mode).toBe("hueSpin");
});
