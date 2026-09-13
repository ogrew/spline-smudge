import { kinds, mixModes, reactionModes } from "./model.ts";

const range = (
  id: string,
  label: string,
  min: number,
  max: number,
  step: number,
) =>
  `<label class="range-label" for="${id}">${label}<output id="${id}-value"></output></label><input id="${id}" type="range" min="${min}" max="${max}" step="${step}">`;
const select = (id: string, entries: Record<string, string>) =>
  `<select id="${id}">${Object.entries(entries)
    .map(([key, label]) => `<option value="${key}">${label}</option>`)
    .join("")}</select>`;

/** The static editor markup. Everything dynamic is filled in by sync(). */
export const appTemplate = () => `
<header><div class="brand"><span class="mark">〰</span><h1>Spline Smudge<small>PHOTO / CURVE STUDY</small></h1><span class="badge">PROTOTYPE 01</span></div><div class="header-actions"><button id="load">画像を選択 <span>↗</span></button><input id="file" type="file" accept="image/jpeg,image/png,.jpg,.jpeg,.png" hidden><button id="export" class="primary" disabled>エクスポート ↓</button></div></header>
<main><aside><fieldset id="controls"><section><div class="section-title">01 <h2>カラーピック</h2></div><div class="modes"><button id="mode-a" aria-pressed="true"><b>A</b><span>色の帯</span></button><button id="mode-b" aria-pressed="false"><b>B</b><span>点ごとの色</span></button><button id="mode-c" aria-pressed="false"><b>C</b><span>採取経路</span></button></div><label class="range-label" for="mix-mode">Bの色補間</label>${select(
  "mix-mode",
  mixModes,
)}<div id="mix-spin-row" hidden>${range("mix-spin", "色相の回転数", -2, 2, 1)}</div></section>
<section><div class="section-title">02 <h2>スプライン</h2></div><label class="sr-only" for="kind">作品全体のスプライン</label>${select(
  "kind",
  kinds,
)}<div id="stroke-list" class="stroke-list" aria-label="ストローク一覧"></div><div class="stroke-actions"><button id="stroke-add">＋ 追加</button><button id="stroke-copy">複製</button><button id="stroke-delete">削除</button><button id="stroke-up" title="手前へ" aria-label="線を手前へ">↑</button><button id="stroke-down" title="奥へ" aria-label="線を奥へ">↓</button></div><div id="tcb">${range("tension", "Tension / 張り", -1, 1, 0.01)}${range("continuity", "Continuity / つながり", -1, 1, 0.01)}${range("bias", "Bias / 偏り", -1, 1, 0.01)}</div>${range("width", "基本の太さ", 1, 160, 1)}<div class="selected"><span id="selected-name">点を選択してください</span>${range("factor", "この点の太さ", 0, 10, 0.05)}<button id="factor-reset" class="factor-reset">1.00× に戻す</button></div><div class="button-row"><button id="sample">ランダムな曲線</button><button id="clear">点をクリア</button></div></section>
<section><div class="section-title">03 <h2>採取線</h2></div><div id="source-selected" class="source-selected"></div>${range("angle", "角度", -180, 180, 1)}${range("source-length", "採取する長さ", 1, 1600, 1)}<div id="path-presets" class="button-row" hidden><button id="preset-uniform">等速</button><button id="preset-hold">停止・早送り</button><button id="preset-reverse">逆走</button></div></section>
<section><div class="section-title">04 <h2>オプション</h2></div><label class="option-toggle"><input id="reaction" type="checkbox">写真で帯を変形</label><div id="reaction-settings" class="option-settings" hidden><label class="sr-only" for="reaction-mode">変形アルゴリズム</label>${select(
  "reaction-mode",
  reactionModes,
)}<div id="reaction-displace">${range("displace-amount", "変位量（短辺比）", -20, 20, 0.5)}</div><div id="reaction-edge">${range("edge-amount", "効き", -1, 1, 0.05)}</div></div><label class="option-toggle"><input id="shade" type="checkbox">フェイク3D</label><div id="shade-settings" class="option-settings" hidden>${range("shade-amount", "強さ", 0, 1, 0.05)}</div></section>
<section><div class="section-title">05 <h2>エクスポート設定</h2></div><label class="range-label" for="resolution">長辺の解像度</label><select id="resolution"><option value="2000">2000 px</option><option value="3508">3508 px</option><option value="5000">5000 px</option><option value="original">元画像と同じ</option></select><p id="dimensions" class="note"></p><label class="color-label" for="background">透明部分の背景色<input id="background" type="color"></label></section></fieldset></aside>
<div class="workspace"><div class="toolbar"><div class="button-row"><button id="undo" title="⌘/Ctrl + Z">↶ 戻る</button><button id="redo" title="⌘/Ctrl + Shift + Z">↷</button></div><div class="view-options"><label><input id="guides" type="checkbox" checked>ガイド</label><button id="fit">全体</button><button id="one">100%</button><button id="minus" aria-label="縮小">−</button><span id="zoom-label">100%</span><button id="plus" aria-label="拡大">＋</button></div></div><div id="stage" tabindex="0" aria-label="写真の上をクリックして点を追加。ドラッグで移動、点のダブルクリックで削除。スペースとドラッグで表示を移動。"><div id="art"><canvas id="image"></canvas><svg id="overlay" xmlns="http://www.w3.org/2000/svg"></svg></div><div class="canvas-tag"><span id="image-name"></span><span id="image-size"></span></div><div id="empty-hint">写真の上をクリックして、曲線をつくる</div></div><footer><div><span class="status-dot"></span><span id="status" role="status" aria-live="polite">準備中</span></div><div class="footer-actions"><progress id="progress" max="1" value="0" hidden></progress><button id="cancel" hidden>中断</button><button id="recalculate" hidden>再計算</button></div></footer><div class="gesture-hint">クリック：点を追加　 /　 ダブルクリック：点を削除　 /　 Space＋ドラッグ：移動　 /　 ホイール：拡大縮小</div></div></main>`;
