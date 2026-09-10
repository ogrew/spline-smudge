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
  }
  await page.locator("#sample").click();
  await ready(page);
  for (const kind of ["catmull", "bspline", "centripetal", "natural", "tcb"]) {
    await page.locator("#kind").selectOption(kind);
    await ready(page);
    expect((await debug(page)).strokes[0].kind).toBe(kind);
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
  await page.locator("#numbers").uncheck();
  expect(await page.locator(".point-number").count()).toBe(0);
  await page.locator("#numbers").check();
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
  await page.evaluate(() => {
    const p = document.querySelector("#pickup") as HTMLInputElement;
    p.value = "0.1";
    p.dispatchEvent(new Event("input"));
    (document.querySelector("#cancel") as HTMLButtonElement).click();
  });
  await expect(page.locator("#recalculate")).toBeVisible();
  await expect(page.locator("#export")).toBeDisabled();
  await page.locator("#recalculate").click();
  await ready(page);
  await page.evaluate(() => {
    const p = document.querySelector("#pickup") as HTMLInputElement;
    for (let i = 1; i <= 12; i++) {
      p.value = String(i / 100);
      p.dispatchEvent(new Event("input"));
    }
  });
  await ready(page);
  expect((await debug(page)).pickup).toBe(0.12);
  await page.locator("#resolution").selectOption("5000");
  await ready(page);
  console.log("B full resolution", await page.locator("#status").textContent());
  let start = Date.now();
  const b = await download(page, "spline-smudge-verified-B-5000");
  console.log("B export ms", Date.now() - start);
  expect([b.width, b.height]).toEqual([5000, 3438]);
  expect(b.filename).toMatch(/^tcb_B_.*\.png$/);
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
  await page.locator("#numbers").uncheck();
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
