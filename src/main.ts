import "./style.css";
import { Renderer } from "./renderer.ts";
import {
  History,
  addStroke,
  deleteStroke,
  moveStroke,
  exportKind,
  activeStroke,
  initialState,
  kinds,
  outputSize,
  pointSource,
  rescaleDocument,
  reactionModes,
  mixModes,
  type MixMode,
  type SourceSettings,
  type DocumentState,
  type Kind,
  type ReactionMode,
} from "./model.ts";
import { sampleCurve, randomizeWidthsByCorner } from "./geometry.ts";
import { RenderQueue } from "./render-queue.ts";
import { appTemplate } from "./ui-template.ts";

const presetEdges = [2000, 3508, 5000];

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
document.querySelector("#app")!.innerHTML = appTemplate();

let renderer: Renderer;
try {
  renderer = new Renderer($<HTMLCanvasElement>("image"));
} catch (error) {
  $("stage").innerHTML = `<div class="fatal"></div>`;
  $("stage").querySelector(".fatal")!.textContent = String(error);
  throw error;
}
let iw = 1600,
  ih = 1100,
  state = initialState(iw, ih),
  selected: string | null = null;
let source: CanvasImageSource,
  originalFile: File | null = null,
  sourceBitmap: ImageBitmap | null = null;
let guides = true;
let zoom = 1,
  pan = { x: 0, y: 0 },
  fitted = true,
  space = false;
let exporting = false,
  loadId = 0;
let overlaySampleCache: {
  revision: number;
  strokeId: string;
  samples: ReturnType<typeof sampleCurve>;
} | null = null;
let overlaySampleComputations = 0;
const history = new History();
const queue = new RenderQueue<DocumentState>({
  snapshot: () => structuredClone(state),
  begin: () => {
    $("cancel").hidden = false;
    $("progress").hidden = false;
  },
  started: (snapshot) => setStatus(`${snapshot.mode} を描画中…`),
  run: (snapshot, cancelled) =>
    renderer.render(source, iw, ih, snapshot, cancelled, (p) => {
      $<HTMLProgressElement>("progress").value = p;
    }),
  completed: (snapshot, elapsed) => {
    layout();
    setStatus(
      `${snapshot.mode} · ${size().width} × ${size().height} px · ${elapsed.toFixed(0)} ms`,
    );
  },
  failed: (error) => {
    setStatus(error instanceof Error ? error.message : String(error));
    $("recalculate").hidden = false;
  },
  idle: (complete) => {
    $("cancel").hidden = true;
    $("progress").hidden = true;
    $<HTMLButtonElement>("export").disabled = !complete || !renderer.ready;
  },
});
const stroke = () => activeStroke(state);
const options = () => state.options;
const point = () => stroke().points.find((p) => p.id === selected);
const currentSource = () =>
  state.mode === "B" && point()
    ? pointSource(stroke(), point()!)
    : stroke().source;
function updateSource(key: keyof SourceSettings, value: number) {
  if (state.mode === "A") stroke().source[key] = value;
  else if (point()) {
    const source = pointSource(stroke(), point()!);
    point()!.source = {
      angle: source.angle,
      length: source.length,
      [key]: value,
    };
  }
}
const size = () => outputSize(iw, ih, state.longEdge);
const setStatus = (text: string) => {
  $("status").textContent = text;
};
function sync() {
  $("stroke-list").innerHTML = [...state.strokes]
    .reverse()
    .map(
      (s) =>
        `<div class="stroke-item ${s.id === state.activeId ? "is-active" : ""}" data-stroke-id="${s.id}"><input type="checkbox" data-visibility="${s.id}" aria-label="${s.name}を表示" ${s.visible ? "checked" : ""}><button type="button" data-select-stroke="${s.id}" aria-pressed="${s.id === state.activeId}"><span>${s.name}</span><small>${s.points.length}点${s.visible ? "" : " · 非表示"}</small></button></div>`,
    )
    .join("");
  const strokeIndex = state.strokes.findIndex((s) => s.id === state.activeId);
  $<HTMLButtonElement>("stroke-up").disabled =
    strokeIndex === state.strokes.length - 1;
  $<HTMLButtonElement>("stroke-down").disabled = strokeIndex === 0;
  $<HTMLSelectElement>("kind").value = state.kind;
  $("mode-a").setAttribute("aria-pressed", String(state.mode === "A"));
  $("mode-b").setAttribute("aria-pressed", String(state.mode === "B"));
  const source = currentSource();
  $("source-selected").textContent =
    state.mode === "A"
      ? "始点の採取線 · A"
      : point()
        ? `POINT ${String(stroke().points.indexOf(point()!) + 1).padStart(2, "0")} の採取線 · B`
        : "編集する点を選択してください";
  for (const id of ["angle", "source-length"])
    $<HTMLInputElement>(id).disabled = state.mode === "B" && !point();
  $("tcb").hidden = state.kind !== "tcb";
  const values: Record<string, [number, string]> = {
    width: [stroke().width, `${stroke().width} px`],
    factor: [point()?.factor ?? 1, `${(point()?.factor ?? 1).toFixed(2)} ×`],
    angle: [source.angle, `${Math.round(source.angle)}°`],
    "source-length": [source.length, `${Math.round(source.length)} px`],
    tension: [stroke().tension, stroke().tension.toFixed(2)],
    continuity: [stroke().continuity, stroke().continuity.toFixed(2)],
    bias: [stroke().bias, stroke().bias.toFixed(2)],
    "displace-amount": [
      options().reaction.displaceAmount,
      `${options().reaction.displaceAmount.toFixed(1)}%`,
    ],
    "edge-amount": [
      options().reaction.edgeAmount,
      options().reaction.edgeAmount.toFixed(2),
    ],
    "shade-amount": [options().shade.amount, options().shade.amount.toFixed(2)],
    "mix-spin": [
      state.mix.turns,
      `${state.mix.turns > 0 ? "+" : ""}${state.mix.turns} 回転`,
    ],
  };
  // Option settings appear only while their toggle is on.
  $<HTMLInputElement>("reaction").checked = options().reaction.on;
  $<HTMLInputElement>("shade").checked = options().shade.on;
  $<HTMLSelectElement>("reaction-mode").value = options().reaction.mode;
  $<HTMLSelectElement>("mix-mode").value = state.mix.mode;
  $("mix-spin-row").hidden = state.mix.mode !== "hueSpin";
  $("reaction-settings").hidden = !options().reaction.on;
  $("reaction-displace").hidden = options().reaction.mode !== "displace";
  $("reaction-edge").hidden = options().reaction.mode !== "edgeWidth";
  $("shade-settings").hidden = !options().shade.on;
  $<HTMLInputElement>("width").max = String(
    Math.max(1, Math.floor(Math.max(iw, ih) / 10)),
  );
  $<HTMLInputElement>("source-length").max = String(
    Math.ceil(Math.hypot(iw, ih)),
  );
  for (const [id, [value, text]] of Object.entries(values)) {
    $<HTMLInputElement>(id).value = String(value);
    $(`${id}-value`).textContent = text;
  }
  $<HTMLInputElement>("factor").disabled = !point();
  $<HTMLButtonElement>("factor-reset").disabled =
    !point() || point()!.factor === 1;
  $("selected-name").textContent = point()
    ? `POINT ${String(stroke().points.indexOf(point()!) + 1).padStart(2, "0")}`
    : "点を選択してください";
  $<HTMLButtonElement>("undo").disabled = !history.canUndo || exporting;
  $<HTMLButtonElement>("redo").disabled = !history.canRedo || exporting;
  $<HTMLInputElement>("background").value = state.background;
  $<HTMLSelectElement>("resolution").value = presetEdges.includes(
    state.longEdge,
  )
    ? String(state.longEdge)
    : "original";
  const s = size();
  $("dimensions").textContent = `${s.width} × ${s.height} px`;
  $("empty-hint").textContent = stroke().visible
    ? "写真の上をクリックして、曲線をつくる"
    : `${stroke().name} · 非表示`;
  $("empty-hint").hidden = stroke().visible && stroke().points.length > 0;
  overlay();
}
function overlay() {
  const view = $("overlay"),
    pts = stroke().points,
    scale = (size().width / iw) * zoom,
    r = 5 / scale;
  view.setAttribute("viewBox", `0 0 ${iw} ${ih}`);
  const parts: string[] = [];
  if (!stroke().visible) {
    view.innerHTML = "";
    return;
  }
  if (guides) {
    if (
      !overlaySampleCache ||
      overlaySampleCache.revision !== queue.revision ||
      overlaySampleCache.strokeId !== stroke().id
    ) {
      overlaySampleCache = {
        revision: queue.revision,
        strokeId: stroke().id,
        samples: sampleCurve(stroke(), Math.max(2, iw / 500), state.kind),
      };
      overlaySampleComputations++;
    }
    const sampled = overlaySampleCache.samples;
    parts.push(
      `<polyline class="polygon" points="${pts.map((p) => `${p.x},${p.y}`).join(" ")}"/>`,
    );
    parts.push(
      `<polyline class="centerline" points="${sampled.map((p) => `${p.x},${p.y}`).join(" ")}"/>`,
    );
  }
  if (guides && pts.length > 0) {
    const sources =
      state.mode === "A"
        ? [{ ...stroke().source, label: "SOURCE 01", active: true }]
        : pts.map((p, i) => ({
            ...pointSource(stroke(), p),
            label: `SOURCE ${String(i + 1).padStart(2, "0")}`,
            active: p.id === selected,
          }));
    for (const s of sources) {
      const a = (s.angle * Math.PI) / 180,
        dx = (Math.cos(a) * s.length) / 2,
        dy = (Math.sin(a) * s.length) / 2;
      parts.push(
        `<g class="source-guide" opacity="${s.active ? 1 : 0.4}"><line class="source-line" x1="${s.x - dx}" y1="${s.y - dy}" x2="${s.x + dx}" y2="${s.y + dy}"/>`,
      );
      for (const sign of [-1, 1])
        parts.push(
          `<circle class="source-handle" cx="${s.x + dx * sign}" cy="${s.y + dy * sign}" r="${r * 0.8}"/>`,
        );
      if (s.active)
        parts.push(
          `<text class="source-text" x="${s.x + 8 / scale}" y="${s.y + 22 / scale}" font-size="${10 / scale}">${s.label}</text>`,
        );
      parts.push("</g>");
    }
  }
  for (const [i, p] of pts.entries()) {
    if (guides)
      parts.push(
        `<circle class="point ${p.id === selected ? "active" : ""}" cx="${p.x}" cy="${p.y}" r="${r * (p.id === selected ? 1.3 : 1)}"/>`,
      );
    if (guides)
      parts.push(
        `<text class="point-number" x="${p.x + 11 / scale}" y="${p.y - 11 / scale}" font-size="${11 / scale}">${String(i + 1).padStart(2, "0")}</text>`,
      );
  }
  view.innerHTML = parts.join("");
}
function layout() {
  const rect = $("stage").getBoundingClientRect(),
    s = size();
  if (fitted) {
    zoom = Math.min(
      (rect.width - 96) / s.width,
      (rect.height - 100) / s.height,
    );
    pan = { x: 0, y: 0 };
  }
  zoom = Math.max(0.01, zoom);
  const w = s.width * zoom,
    h = s.height * zoom;
  $("art").style.width = `${w}px`;
  $("art").style.height = `${h}px`;
  $("art").style.transform =
    `translate(${(rect.width - w) / 2 + pan.x}px,${(rect.height - h) / 2 + pan.y}px)`;
  $("zoom-label").textContent = `${Math.round(zoom * 100)}%`;
  renderer.present(
    Math.max(1, Math.min(s.width, Math.round(w * devicePixelRatio))),
    Math.max(1, Math.min(s.height, Math.round(h * devicePixelRatio))),
  );
  overlay();
}
function requestRender() {
  // A-mode sources follow each stroke's first point.
  for (const s of state.strokes) {
    const first = s.points[0];
    if (first) {
      s.source.x = first.x;
      s.source.y = first.y;
    }
  }
  queue.request();
  $<HTMLButtonElement>("export").disabled = true;
  $("recalculate").hidden = true;
  sync();
}
function edit(change: () => void) {
  if (exporting) return;
  // Any other edit ends the "double click cancels the just-added point" window.
  clickAddedPoint = null;
  history.push(state);
  change();
  requestRender();
}
function randomPoints() {
  stroke().points = Array.from(
    { length: 4 + Math.floor(Math.random() * 9) },
    () => ({
      id: crypto.randomUUID(),
      x: iw * (0.05 + Math.random() * 0.9),
      y: ih * (0.05 + Math.random() * 0.9),
      factor: 1,
      source: {
        angle: Math.round(Math.random() * 360 - 180),
        length: Math.max(
          1,
          Math.round(Math.min(iw, ih) * (0.05 + Math.random() * 0.45)),
        ),
      },
    }),
  );
  stroke().points = randomizeWidthsByCorner(stroke().points);
  selected = stroke().points[2].id;
  const first = stroke().points[0];
  stroke().source.x = first.x;
  stroke().source.y = first.y;
}
function demo() {
  const c = document.createElement("canvas");
  c.width = iw;
  c.height = ih;
  const x = c.getContext("2d")!;
  const gradient = x.createLinearGradient(0, 0, iw, ih);
  gradient.addColorStop(0, "#29394e");
  gradient.addColorStop(0.4, "#b67051");
  gradient.addColorStop(0.75, "#233e50");
  gradient.addColorStop(1, "#dfb579");
  x.fillStyle = gradient;
  x.fillRect(0, 0, iw, ih);
  const colors = [
    "#dfb579",
    "#e5cec0",
    "#111f30",
    "#4d8590",
    "#b4553e",
    "#262835",
    "#f3ab77",
  ];
  for (let y = 0; y < ih; y += 11) {
    x.globalAlpha = 0.25 + ((y * 13) % 10) / 20;
    x.fillStyle = colors[Math.floor(y / 11) % colors.length];
    x.fillRect(0, y, iw, 3 + (y % 17));
  }
  x.globalAlpha = 1;
  for (let i = 0; i < 22; i++) {
    const bx = i * 78 - 20,
      bh = 100 + ((i * 137) % 610);
    x.fillStyle = i % 2 ? "#172a34" : "#233540";
    x.fillRect(bx, ih - bh, 60, bh);
    for (let yy = ih - bh + 12; yy < ih; yy += 18)
      for (let xx = bx + 6; xx < bx + 55; xx += 12) {
        x.fillStyle = (xx + yy) % 3 ? "#cdac6b" : "#426779";
        x.fillRect(xx, yy, 4, 6);
      }
  }
  return c;
}
source = demo();
randomPoints();
$("image-name").textContent = "DEMO · 生成パターン";
$("image-size").textContent = `${iw} × ${ih}`;
for (const m of ["A", "B"] as const)
  $(`mode-${m.toLowerCase()}`).onclick = () => edit(() => (state.mode = m));
$("kind").onchange = () =>
  edit(() => (state.kind = $<HTMLSelectElement>("kind").value as Kind));
const changes: Record<string, (v: number) => void> = {
  width: (v) =>
    (stroke().width = Math.max(
      1,
      Math.min(Math.round(v), Math.max(1, Math.floor(Math.max(iw, ih) / 10))),
    )),
  factor: (v) => {
    if (point()) point()!.factor = v;
  },
  angle: (v) => updateSource("angle", v),
  "source-length": (v) => updateSource("length", v),
  tension: (v) => (stroke().tension = v),
  continuity: (v) => (stroke().continuity = v),
  bias: (v) => (stroke().bias = v),
  "displace-amount": (v) => (options().reaction.displaceAmount = v),
  "edge-amount": (v) => (options().reaction.edgeAmount = v),
  "shade-amount": (v) => (options().shade.amount = v),
  "mix-spin": (v) => (state.mix.turns = Math.round(v)),
};
const currentValues: Record<string, () => number> = {
  width: () => stroke().width,
  factor: () => point()?.factor ?? 1,
  angle: () => currentSource().angle,
  "source-length": () => currentSource().length,
  tension: () => stroke().tension,
  continuity: () => stroke().continuity,
  bias: () => stroke().bias,
  "displace-amount": () => options().reaction.displaceAmount,
  "edge-amount": () => options().reaction.edgeAmount,
  "shade-amount": () => options().shade.amount,
  "mix-spin": () => state.mix.turns,
};
for (const [id, apply] of Object.entries({
  reaction: (on: boolean) => (options().reaction.on = on),
  shade: (on: boolean) => (options().shade.on = on),
}))
  $<HTMLInputElement>(id).onchange = () =>
    edit(() => apply($<HTMLInputElement>(id).checked));
$("mix-mode").onchange = () =>
  edit(
    () =>
      (state.mix.mode = $<HTMLSelectElement>("mix-mode").value as MixMode),
  );
$("reaction-mode").onchange = () =>
  edit(
    () =>
      (options().reaction.mode = $<HTMLSelectElement>("reaction-mode")
        .value as ReactionMode),
  );
for (const [id, change] of Object.entries(changes)) {
  const input = $<HTMLInputElement>(id);
  let checkpoint = false;
  input.addEventListener("input", () => {
    const beforeValue = currentValues[id](),
      before = checkpoint ? null : structuredClone(state);
    change(Number(input.value));
    if (currentValues[id]() === beforeValue) return;
    if (!checkpoint) {
      history.push(before!);
      checkpoint = true;
    }
    requestRender();
  });
  input.addEventListener("change", () => {
    checkpoint = false;
  });
  input.addEventListener("blur", () => {
    checkpoint = false;
  });
}
$("resolution").onchange = () =>
  edit(() => {
    const v = $<HTMLSelectElement>("resolution").value;
    state.longEdge = v === "original" ? Math.max(iw, ih) : Number(v);
    fitted = true;
    layout();
  });
$("background").onchange = () =>
  edit(() => (state.background = $<HTMLInputElement>("background").value));
$("stroke-list").addEventListener("click", (event) => {
  if (exporting) return;
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
    "[data-select-stroke]",
  );
  if (!button) return;
  state.activeId = button.dataset.selectStroke!;
  selected = null;
  drag = null;
  sync();
});
$("stroke-list").addEventListener("change", (event) => {
  if (exporting) return;
  const input = event.target as HTMLInputElement;
  const target = state.strokes.find((s) => s.id === input.dataset.visibility);
  if (target)
    edit(() => {
      target.visible = input.checked;
    });
});
$("stroke-add").onclick = () =>
  edit(() => {
    addStroke(state);
    selected = null;
    drag = null;
  });
$("stroke-copy").onclick = () =>
  edit(() => {
    addStroke(state, true);
    selected = null;
    drag = null;
  });
$("stroke-delete").onclick = () =>
  edit(() => {
    deleteStroke(state);
    selected = null;
    drag = null;
  });
$("stroke-up").onclick = () => edit(() => moveStroke(state, 1));
$("stroke-down").onclick = () => edit(() => moveStroke(state, -1));
$("factor-reset").onclick = () => {
  if (point() && point()!.factor !== 1)
    edit(() => {
      point()!.factor = 1;
    });
};
$("sample").onclick = () => edit(randomPoints);
$("clear").onclick = () =>
  edit(() => {
    stroke().points = [];
    selected = null;
  });
$("undo").onclick = () => {
  if (exporting) return;
  state = history.undo(state);
  if (!point()) selected = null;
  requestRender();
  layout();
};
$("redo").onclick = () => {
  if (exporting) return;
  state = history.redo(state);
  if (!point()) selected = null;
  requestRender();
  layout();
};
$("guides").onchange = () => {
  guides = $<HTMLInputElement>("guides").checked;
  overlay();
};
$("fit").onclick = () => {
  fitted = true;
  layout();
};
$("one").onclick = () => {
  zoom = 1;
  pan = { x: 0, y: 0 };
  fitted = false;
  layout();
};
function zoomBy(factor: number, anchor?: { clientX: number; clientY: number }) {
  const stageRect = $("stage").getBoundingClientRect();
  const artRect = $("art").getBoundingClientRect();
  const relative = anchor
    ? {
        x: (anchor.clientX - artRect.left) / artRect.width,
        y: (anchor.clientY - artRect.top) / artRect.height,
      }
    : null;
  fitted = false;
  zoom = Math.max(0.02, Math.min(8, zoom * factor));
  if (anchor && relative) {
    const s = size(),
      width = s.width * zoom,
      height = s.height * zoom;
    pan = {
      x:
        anchor.clientX -
        stageRect.left -
        relative.x * width -
        (stageRect.width - width) / 2,
      y:
        anchor.clientY -
        stageRect.top -
        relative.y * height -
        (stageRect.height - height) / 2,
    };
  }
  layout();
}
$("plus").onclick = () => zoomBy(1.25);
$("minus").onclick = () => zoomBy(0.8);
let angleWheel = {
  key: "",
  time: 0,
  revision: -1,
  remainder: 0,
  checkpoint: false,
};
$("stage").addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    if (event.shiftKey) {
      if (
        exporting ||
        !point() ||
        !stroke().visible ||
        !inside(coordinate(event))
      )
        return;
      const now = performance.now(),
        key = `${state.activeId}:${selected}:${state.mode}`;
      if (
        key !== angleWheel.key ||
        now - angleWheel.time > 400 ||
        angleWheel.revision !== queue.revision
      )
        angleWheel = {
          key,
          time: now,
          revision: queue.revision,
          remainder: 0,
          checkpoint: false,
        };
      // Some browsers map Shift + a vertical wheel to deltaX.
      const delta =
        (event.deltaY || event.deltaX) *
        (event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? $("stage").clientHeight
            : 1);
      angleWheel.remainder -= delta / 12;
      const steps = Math.trunc(angleWheel.remainder);
      angleWheel.time = now;
      if (!steps) return;
      angleWheel.remainder -= steps;
      if (!angleWheel.checkpoint) {
        history.push(state);
        angleWheel.checkpoint = true;
      }
      updateSource(
        "angle",
        ((((Math.round(currentSource().angle) + steps + 180) % 360) + 360) %
          360) -
          180,
      );
      requestRender();
      angleWheel.revision = queue.revision;
      return;
    }
    angleWheel.checkpoint = false;
    angleWheel.revision = -1;
    zoomBy(Math.exp(-event.deltaY * 0.001), event);
  },
  { passive: false },
);
const coordinate = (event: PointerEvent | MouseEvent | WheelEvent) => {
  const rect = $("art").getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * iw,
    y: ((event.clientY - rect.top) / rect.height) * ih,
  };
};
const inside = (p: { x: number; y: number }) =>
  p.x >= 0 && p.y >= 0 && p.x <= iw && p.y <= ih;
const nearest = (p: { x: number; y: number }) => {
  // Closest hit inside an 11 CSS px radius; the earlier point wins exact ties.
  let bestDistance = 11 / ((size().width / iw) * zoom);
  let best: (typeof state.strokes)[number]["points"][number] | undefined;
  for (const q of stroke().points) {
    const distance = Math.hypot(q.x - p.x, q.y - p.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = q;
    }
  }
  return best;
};
let drag: null | {
  type: "point" | "pan";
  id?: string;
  checkpoint?: boolean;
  start: { x: number; y: number };
  pan: { x: number; y: number };
} = null;
let clickAddedPoint: {
  id: string;
  time: number;
  previousSelection: string | null;
} | null = null;
$("stage").addEventListener("pointerdown", (event) => {
  if (exporting || (event.button !== 0 && event.button !== 1)) return;
  $("stage").focus();
  const p = coordinate(event);
  if (space || event.button === 1) {
    drag = {
      type: "pan",
      start: { x: event.clientX, y: event.clientY },
      pan: { ...pan },
    };
  } else if (stroke().visible) {
    const existing = nearest(p);
    if (existing) {
      selected = existing.id;
      if (event.detail === 2) return;
      drag = {
        type: "point",
        id: existing.id,
        start: p,
        pan,
        checkpoint: false,
      };
      sync();
    } else if (inside(p) && event.detail < 2) {
      const previousSelection = selected;
      history.push(state);
      const added = {
        ...p,
        id: crypto.randomUUID(),
        factor: 1,
        source: {
          angle: stroke().source.angle,
          length: stroke().source.length,
        },
      };
      stroke().points.push(added);
      clickAddedPoint = {
        id: added.id,
        time: performance.now(),
        previousSelection,
      };
      selected = added.id;
      if (stroke().points.length === 1) {
        stroke().source.x = p.x;
        stroke().source.y = p.y;
      }
      requestRender();
    }
  }
  if (drag) $("stage").setPointerCapture(event.pointerId);
});
$("stage").addEventListener("pointermove", (event) => {
  if (!drag) return;
  const p = coordinate(event);
  if (drag.type === "pan") {
    fitted = false;
    pan = {
      x: drag.pan.x + event.clientX - drag.start.x,
      y: drag.pan.y + event.clientY - drag.start.y,
    };
    layout();
    return;
  }
  p.x = Math.max(0, Math.min(iw, p.x));
  p.y = Math.max(0, Math.min(ih, p.y));
  if (drag.type === "point") {
    const q = stroke().points.find((q) => q.id === drag!.id);
    if (q && (q.x !== p.x || q.y !== p.y)) {
      if (!drag.checkpoint) {
        // Moving a point is an edit too; it must not be discarded by a later
        // double click that still remembers a recently added point.
        clickAddedPoint = null;
        history.push(state);
        drag.checkpoint = true;
      }
      q.x = p.x;
      q.y = p.y;
    }
  }
  requestRender();
});
for (const event of ["pointerup", "pointercancel", "lostpointercapture"])
  $("stage").addEventListener(event, () => {
    drag = null;
  });
$("stage").addEventListener("dblclick", (event) => {
  if (exporting || !stroke().visible) return;
  const p = nearest(coordinate(event)),
    added = clickAddedPoint;
  if (p && added && p.id === added.id && performance.now() - added.time < 750) {
    state = history.discardLatestPush() ?? state;
    selected = added.previousSelection;
    clickAddedPoint = null;
    requestRender();
  } else if (p)
    edit(() => {
      stroke().points = stroke().points.filter((q) => q.id !== p.id);
      selected = null;
    });
});
window.addEventListener("keydown", (event) => {
  if (
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLSelectElement
  )
    return;
  if (event.code === "Space") {
    event.preventDefault();
    space = true;
    $("stage").classList.add("panning");
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    $(event.shiftKey ? "redo" : "undo").click();
  }
  if (event.key === "Escape") $("cancel").click();
});
window.addEventListener("keyup", (event) => {
  if (event.code === "Space") {
    space = false;
    $("stage").classList.remove("panning");
  }
});
window.addEventListener("blur", () => {
  space = false;
  drag = null;
  $("stage").classList.remove("panning");
});
$("cancel").onclick = () => {
  if (!queue.cancel()) return;
  setStatus("中断しました。再計算で続きを確認できます。");
  $("recalculate").hidden = false;
};
$("recalculate").onclick = requestRender;
$("load").onclick = () => $("file").click();
$<HTMLInputElement>("file").onchange = async () => {
  const file = $<HTMLInputElement>("file").files?.[0];
  if (!file) return;
  const id = ++loadId;
  setStatus("写真を読み込み中…");
  let bitmap: ImageBitmap | null = null;
  try {
    // Check signatures as well as browser MIME; don't accept a renamed TIFF or arbitrary SVG.
    const bytes = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    if (
      !(bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) &&
      ![137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)
    )
      throw new Error("JPGまたはPNGを選んでください。");
    bitmap = await createImageBitmap(file, {
      imageOrientation: "from-image",
      colorSpaceConversion: "default",
    });
    if (id !== loadId) {
      bitmap.close();
      return;
    }
    queue.invalidate();
    // Let the in-flight render exit before releasing its source bitmap.
    await queue.whenIdle();
    if (id !== loadId) {
      bitmap.close();
      return;
    }
    sourceBitmap?.close();
    sourceBitmap = bitmap;
    source = bitmap;
    originalFile = file;
    // Carry the whole composition over: one uniform fit scale, centered.
    // Only a successful decode reaches this point; failures keep everything.
    const fixedEdge = presetEdges.includes(state.longEdge);
    state = rescaleDocument(
      state,
      { width: iw, height: ih },
      { width: bitmap.width, height: bitmap.height },
    );
    iw = bitmap.width;
    ih = bitmap.height;
    // A preset long edge stays; "元画像と同じ" follows the new image.
    if (!fixedEdge) state.longEdge = Math.max(iw, ih);
    if (!point()) selected = null;
    // The swap itself is not undoable; editing history restarts on the new photo.
    history.clear();
    fitted = true;
    pan = { x: 0, y: 0 };
    $("image-name").textContent = file.name;
    $("image-size").textContent = `${iw} × ${ih}`;
    requestRender();
    layout();
  } catch (error) {
    bitmap?.close();
    setStatus(error instanceof Error ? error.message : String(error));
  } finally {
    $<HTMLInputElement>("file").value = "";
  }
};
$("export").onclick = async () => {
  if (exporting || queue.busy || !queue.complete) return;
  exporting = true;
  $<HTMLFieldSetElement>("controls").disabled = true;
  $<HTMLButtonElement>("export").disabled = true;
  $<HTMLButtonElement>("load").disabled = true;
  sync();
  setStatus("PNGを書き出し中…");
  try {
    const blob = await renderer.exportPNG();
    const url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    a.download = `${exportKind(state)}_${state.mode}_${timestamp}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    setStatus(
      `書き出しました · ${size().width} × ${size().height} px · sRGB / 8bit`,
    );
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  } finally {
    exporting = false;
    $<HTMLFieldSetElement>("controls").disabled = false;
    $<HTMLButtonElement>("load").disabled = false;
    $<HTMLButtonElement>("export").disabled = !renderer.ready;
    sync();
  }
};
$<HTMLCanvasElement>("image").addEventListener("webglcontextlost", (event) => {
  event.preventDefault();
  queue.invalidate();
  $<HTMLButtonElement>("export").disabled = true;
  setStatus("GPUへの接続が失われました。復旧を待っています。");
});
$<HTMLCanvasElement>("image").addEventListener("webglcontextrestored", () => {
  try {
    renderer = new Renderer($<HTMLCanvasElement>("image"));
    requestRender();
  } catch (error) {
    setStatus(String(error));
  }
});
new ResizeObserver(layout).observe($("stage"));
// Development-only diagnostics for reproducible browser validation. No source bytes leave the page.
if (import.meta.env.DEV)
  Object.defineProperty(window, "smudgeDebug", {
    value: {
      get state() {
        return structuredClone(state);
      },
      get original() {
        return originalFile?.name ?? null;
      },
      get ready() {
        return !queue.busy && queue.complete;
      },
      get limit() {
        return renderer.limit;
      },
      get gl() {
        return renderer.gl;
      },
      get dimensions() {
        return size();
      },
      get overlaySampleComputations() {
        return overlaySampleComputations;
      },
    },
  });
sync();
layout();
requestRender();
