import type { DocumentState, Stroke } from "./model.ts";
import { outputSize } from "./model.ts";
import { sampleCurve } from "./geometry.ts";
import { ribbonMesh, ribbonStride } from "./ribbon-mesh.ts";
import { colorInterpolationGLSL, mixModeIndex } from "./color-interpolation.ts";

type Target = {
  texture: WebGLTexture;
  fbo: WebGLFramebuffer;
  width: number;
  height: number;
  mipmapped: boolean;
};
type Program = {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
};
/** Yield to the browser after this much uninterrupted stroke compositing. */
const FRAME_BUDGET_MS = 8;
/** Luminance-difference offset for edge strength, in source-image px. */
const EDGE_SAMPLE_SOURCE_PX = 3;
const fullVertex = `#version 300 es
precision highp float;
out vec2 uv;
void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2)); uv=p; gl_Position=vec4(p*2.0-1.0,0,1);}`;
const copyFragment = `#version 300 es
precision highp float;
in vec2 uv; uniform sampler2D image; uniform bool flip; out vec4 color;
void main(){color=texture(image,vec2(uv.x,flip?1.0-uv.y:uv.y));}`;
const ribbonVertex = `#version 300 es
precision highp float;
layout(location=0) in vec2 center;
layout(location=1) in vec2 normal;
layout(location=2) in vec2 sourceA;
layout(location=3) in vec2 sourceB;
layout(location=4) in vec2 strip;
layout(location=5) in vec2 misc;
uniform vec2 resolution;
uniform sampler2D image;
uniform float displacePx;
uniform float edgeAmount;
uniform float edgeTexel;
out vec2 uvA; out vec2 uvB; out vec2 uv; out vec2 ribbonNormal;
out vec2 band;
const float EDGE_GAIN=3.0;      // luminance gradient to edge strength
const float WIDTH_SCALE_MAX=3.0;
float lum(vec2 p){vec3 c=texture(image,p/resolution).rgb;return dot(c,vec3(0.2126,0.7152,0.0722));}
void main(){
uv=strip;uvA=sourceA/resolution;uvB=sourceB/resolution;ribbonNormal=normal;
float widthScale=1.0;
if(edgeAmount!=0.0){
vec2 dx=vec2(edgeTexel,0.0),dy=vec2(0.0,edgeTexel);
float e=clamp(length(vec2(lum(center+dx)-lum(center-dx),lum(center+dy)-lum(center-dy)))*EDGE_GAIN,0.0,1.0);
widthScale=clamp(1.0+edgeAmount*(e*2.0-1.0),0.0,WIDTH_SCALE_MAX);
}
// Band coordinates for the kasure texture: arc length s and the signed
// cross offset v (after width modulation).
band=vec2(misc.y,misc.x*widthScale);
vec2 pos=center+normal*(misc.x*widthScale);
if(displacePx!=0.0)pos+=normal*((lum(center)-0.5)*2.0*displacePx);
gl_Position=vec4(pos/resolution*2.0-1.0,0,1);}`;
const ribbonFragment = `#version 300 es
precision highp float;
in vec2 uvA; in vec2 uvB; in vec2 uv; in vec2 ribbonNormal;
in vec2 band;
uniform sampler2D image; uniform bool perPoint; uniform float shadeAmount; out vec4 color;
uniform float brushAmount;  // kasure strength; 0 skips the effect entirely
uniform float brushGrain;   // streak spacing in source px
uniform float brushSeed;
uniform float sourceScale;  // output px per source px
${colorInterpolationGLSL}
// Dry-brush kasure: a bristle streak field in band space (s along the band,
// v across it, both source-image px). Streaks run long in s and fine in v,
// and wander sideways so they read as hairs rather than stripes.
const float STREAK_GRAINS=12.0; // streak length, in grains
float bhash(vec2 p){p=fract(p*vec2(127.1,311.7)+brushSeed);p+=dot(p,p+34.345);return fract(p.x*p.y);}
float bnoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
return mix(mix(bhash(i),bhash(i+vec2(1,0)),f.x),mix(bhash(i+vec2(0,1)),bhash(i+vec2(1,1)),f.x),f.y);}
float streaks(vec2 sv){
float v=sv.y+(bnoise(vec2(sv.x/(brushGrain*6.0),17.0))-0.5)*brushGrain*1.6;
vec2 q=vec2(sv.x/(brushGrain*STREAK_GRAINS),v/brushGrain);
return bnoise(q)*0.55+bnoise(q*vec2(2.3,2.1)+7.7)*0.3+bnoise(q*vec2(4.9,4.2)+3.1)*0.15;
}
// Fake-3D shading: cylinder-profile pseudo normal, fixed upper-left light.
const float ROUNDNESS=0.85;     // cross-section tilt of the pseudo normal
const float ROUNDNESS2=0.7225;  // ROUNDNESS squared, literal to keep pixels exact
const float SHADE_AMBIENT=0.35;
const float SHADE_DIFFUSE=0.85;
const float SHADE_GLOSS=24.0;
const float SHADE_SPECULAR=0.5;
void main(){
vec4 a=texture(image,uvA);
color=perPoint?interpolateColor(a,texture(image,uvB),uv.y):a;
if(brushAmount>0.0){
// Dry-brush coverage: hard gaps plus translucent scraping around them,
// with dropout growing toward the sides of the band.
float n=streaks(band/sourceScale);
float sideBias=smoothstep(0.3,1.0,abs(uv.x*2.0-1.0));
float threshold=brushAmount*(0.42+0.45*sideBias);
float gaps=smoothstep(threshold-0.08,threshold+0.08,n);
color.a*=gaps*mix(0.8,1.0,smoothstep(threshold,threshold+0.35,n));
}
if(shadeAmount>0.0){
float t=uv.x*2.0-1.0;
vec3 N=normalize(vec3(normalize(ribbonNormal)*t*ROUNDNESS,sqrt(max(0.02,1.0-ROUNDNESS2*t*t))));
vec3 L=normalize(vec3(-0.45,-0.6,0.66));
float diffuse=max(dot(N,L),0.0);
float specular=pow(max(dot(reflect(-L,N),vec3(0.0,0.0,1.0)),0.0),SHADE_GLOSS);
color.rgb=color.rgb*mix(1.0,SHADE_AMBIENT+SHADE_DIFFUSE*diffuse,shadeAmount)+specular*SHADE_SPECULAR*shadeAmount;
}
float edge=max(fwidth(uv.x),0.00001);
color.a*=smoothstep(0.0,edge,uv.x)*smoothstep(0.0,edge,1.0-uv.x);
}`;
const frame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
export class Renderer {
  readonly gl: WebGL2RenderingContext;
  readonly limit: number;
  private copy: Program;
  private ribbon: Program;
  private vao: WebGLVertexArrayObject;
  private buffer: WebGLBuffer;
  private bufferCapacity = 0;
  private photo?: Target;
  private working?: Target;
  private complete?: Target;
  // Transient interaction previews render into their own small pair of
  // targets and sample the shared full-resolution photo. Export and the
  // byte-identity guarantees only ever touch the full-resolution pair.
  private previewWorking?: Target;
  private previewComplete?: Target;
  private previewKey = "";
  private showPreview = false;
  private sourceKey = "";
  private sourceObject?: CanvasImageSource;
  // False whenever another pass (e.g. present() during an await) may have
  // changed framebuffer, viewport, program, VAO, blend or texture state.
  private ribbonReady = false;
  width = 1;
  height = 1;
  ready = false;
  // True once the full-resolution pair holds a finished image; previews never set it.
  private fullReady = false;
  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
    if (!gl)
      throw new Error(
        "WebGL2を起動できません。ブラウザのハードウェアアクセラレーションを確認してください。",
      );
    this.gl = gl;
    const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
    this.limit = Math.min(
      gl.getParameter(gl.MAX_TEXTURE_SIZE),
      viewport[0],
      viewport[1],
    );
    this.copy = this.program(fullVertex, copyFragment);
    this.ribbon = this.program(ribbonVertex, ribbonFragment);
    this.vao = gl.createVertexArray()!;
    this.buffer = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    for (let i = 0; i < ribbonStride / 2; i++) {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, 2, gl.FLOAT, false, ribbonStride * 4, i * 8);
    }
    gl.bindVertexArray(null);
  }
  private program(vertex: string, fragment: string): Program {
    const g = this.gl,
      program = g.createProgram()!;
    for (const [type, code] of [
      [g.VERTEX_SHADER, vertex],
      [g.FRAGMENT_SHADER, fragment],
    ] as const) {
      const shader = g.createShader(type)!;
      g.shaderSource(shader, code);
      g.compileShader(shader);
      g.attachShader(program, shader);
      g.deleteShader(shader);
    }
    g.linkProgram(program);
    if (!g.getProgramParameter(program, g.LINK_STATUS))
      throw new Error(g.getProgramInfoLog(program) ?? "Shader error");
    return { program, uniforms: new Map() };
  }
  private location(p: Program, key: string) {
    if (!p.uniforms.has(key))
      p.uniforms.set(key, this.gl.getUniformLocation(p.program, key));
    return p.uniforms.get(key)!;
  }
  private flag(p: Program, key: string, v: boolean) {
    this.gl.uniform1i(this.location(p, key), v ? 1 : 0);
  }
  private pair(p: Program, key: string, x: number, y: number) {
    this.gl.uniform2f(this.location(p, key), x, y);
  }
  private texture(p: Program, key: string, t: WebGLTexture, unit: number) {
    const g = this.gl;
    g.activeTexture(g.TEXTURE0 + unit);
    g.bindTexture(g.TEXTURE_2D, t);
    g.uniform1i(this.location(p, key), unit);
  }
  private target(w: number, h: number, mipmapped = false): Target {
    const g = this.gl;
    // WebGL errors are sticky. Only errors raised by this allocation should decide its result.
    while (g.getError() !== g.NO_ERROR) {}
    const texture = g.createTexture()!,
      fbo = g.createFramebuffer()!;
    g.bindTexture(g.TEXTURE_2D, texture);
    const levels = mipmapped ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1;
    g.texStorage2D(g.TEXTURE_2D, levels, g.RGBA8, w, h);
    g.texParameteri(
      g.TEXTURE_2D,
      g.TEXTURE_MIN_FILTER,
      mipmapped ? g.LINEAR_MIPMAP_LINEAR : g.LINEAR,
    );
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
    g.bindFramebuffer(g.FRAMEBUFFER, fbo);
    g.framebufferTexture2D(
      g.FRAMEBUFFER,
      g.COLOR_ATTACHMENT0,
      g.TEXTURE_2D,
      texture,
      0,
    );
    if (
      g.checkFramebufferStatus(g.FRAMEBUFFER) !== g.FRAMEBUFFER_COMPLETE ||
      g.getError() !== g.NO_ERROR
    ) {
      g.deleteFramebuffer(fbo);
      g.deleteTexture(texture);
      throw new Error(
        "この解像度の画像領域を確保できません。出力解像度を下げて再計算してください。",
      );
    }
    return { texture, fbo, width: w, height: h, mipmapped };
  }
  private drop(t?: Target) {
    if (t) {
      this.gl.deleteFramebuffer(t.fbo);
      this.gl.deleteTexture(t.texture);
    }
  }
  private bind(t: Target | null) {
    const g = this.gl;
    g.bindFramebuffer(g.FRAMEBUFFER, t?.fbo ?? null);
    g.viewport(
      0,
      0,
      t?.width ?? this.canvas.width,
      t?.height ?? this.canvas.height,
    );
  }
  private copyTo(source: Target, target: Target | null, flip = false) {
    const g = this.gl;
    this.ribbonReady = false;
    this.bind(target);
    g.disable(g.BLEND);
    g.useProgram(this.copy.program);
    g.bindVertexArray(null);
    this.texture(this.copy, "image", source.texture, 0);
    this.flag(this.copy, "flip", flip);
    g.drawArrays(g.TRIANGLES, 0, 3);
  }
  private prepare(
    source: CanvasImageSource,
    iw: number,
    ih: number,
    state: DocumentState,
  ) {
    const size = outputSize(iw, ih, state.longEdge),
      w = size.width,
      h = size.height;
    if (Math.max(w, h) > this.limit)
      throw new Error(
        `この端末の上限は長辺${this.limit}pxです。出力解像度を変更してください。`,
      );
    const key = `${w}:${h}:${state.background}`;
    if (key === this.sourceKey && source === this.sourceObject) return;
    this.ready = false;
    this.fullReady = false;
    this.sourceKey = "";
    this.sourceObject = undefined;
    this.drop(this.photo);
    this.drop(this.working);
    this.drop(this.complete);
    this.photo = this.working = this.complete = undefined;
    // Preview pixels sample the old photo; they die with it.
    this.drop(this.previewWorking);
    this.drop(this.previewComplete);
    this.previewWorking = this.previewComplete = undefined;
    this.previewKey = "";
    this.showPreview = false;
    this.width = w;
    this.height = h;
    const staging = document.createElement("canvas");
    staging.width = w;
    staging.height = h;
    const ctx = staging.getContext("2d", { colorSpace: "srgb" })!;
    ctx.fillStyle = state.background;
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(source, 0, 0, w, h);
    this.photo = this.target(w, h);
    // Both result targets alternate between working and complete roles.
    this.working = this.target(w, h, true);
    this.complete = this.target(w, h, true);
    const g = this.gl;
    g.bindTexture(g.TEXTURE_2D, this.photo.texture);
    // All offscreen targets use logical top at texture v=0. Only presentation flips Y.
    g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, false);
    g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    g.texSubImage2D(g.TEXTURE_2D, 0, 0, 0, g.RGBA, g.UNSIGNED_BYTE, staging);
    staging.width = staging.height = 1;
    this.sourceKey = key;
    this.sourceObject = source;
  }
  private preparePreview(w: number, h: number) {
    const key = `${w}:${h}`;
    if (key === this.previewKey) return;
    this.drop(this.previewWorking);
    this.drop(this.previewComplete);
    this.previewWorking = this.previewComplete = undefined;
    this.previewKey = "";
    this.previewWorking = this.target(w, h, true);
    this.previewComplete = this.target(w, h, true);
    this.previewKey = key;
  }
  async render(
    source: CanvasImageSource,
    iw: number,
    ih: number,
    state: DocumentState,
    cancelled: () => boolean,
    progress: (p: number) => void,
    previewEdge: number | null = null,
  ): Promise<boolean> {
    this.prepare(source, iw, ih, state);
    const dims =
      previewEdge === null
        ? { width: this.width, height: this.height }
        : outputSize(iw, ih, previewEdge);
    if (previewEdge !== null) this.preparePreview(dims.width, dims.height);
    const working =
      previewEdge === null ? this.working! : this.previewWorking!;
    const g = this.gl,
      scale = dims.width / iw;
    this.copyTo(this.photo!, working);
    const strokes = state.strokes.filter((stroke) => stroke.visible);
    // Photo-reactive options: each coefficient is 0 while its option is off,
    // which makes the shader output identical to the plain ribbon.
    const { reaction, shade, kasure } = state.options;
    const setup = {
      displacePx:
        reaction.on && reaction.mode === "displace"
          ? ((Math.min(iw, ih) * reaction.displaceAmount) / 100) * scale
          : 0,
      edgeAmount:
        reaction.on && reaction.mode === "edgeWidth" ? reaction.edgeAmount : 0,
      edgeTexel: EDGE_SAMPLE_SOURCE_PX * scale,
      shadeAmount: shade.on ? shade.amount : 0,
      brushAmount: kasure.on ? kasure.amount : 0,
      brushGrain: Math.max(1, kasure.grain),
      brushSeed: kasure.seed,
      sourceScale: scale,
      mixMode: mixModeIndex[state.mix.mode],
      // Whole turns only: the endpoints of every interval keep their sampled color.
      mixSpin:
        state.mix.mode === "hueSpin"
          ? Math.round(state.mix.turns) * 2 * Math.PI
          : 0,
    };
    let chunk = performance.now();
    for (const [index, stroke] of strokes.entries()) {
      if (cancelled() || g.isContextLost()) return false;
      const scaled: Stroke = {
        ...stroke,
        width: stroke.width * scale,
        points: stroke.points.map((p) => ({
          ...p,
          x: p.x * scale,
          y: p.y * scale,
          source: {
            angle: p.source?.angle ?? stroke.source.angle,
            length: (p.source?.length ?? stroke.source.length) * scale,
          },
        })),
        source: {
          ...stroke.source,
          x: stroke.source.x * scale,
          y: stroke.source.y * scale,
          length: stroke.source.length * scale,
        },
        path: {
          ...stroke.path,
          start: {
            x: stroke.path.start.x * scale,
            y: stroke.path.start.y * scale,
          },
          end: { x: stroke.path.end.x * scale, y: stroke.path.end.y * scale },
          length: stroke.path.length * scale,
        },
      };
      // Sample in source-image distance so zoom does not change the mesh.
      const samples = sampleCurve(scaled, Math.max(0.5, 2 * scale), state.kind);
      if (samples.length > 1) {
        // A present() during the await below leaves foreign GPU state behind;
        // rebind the ribbon pipeline lazily so each stroke draws into working.
        if (!this.ribbonReady)
          this.ribbonSetup(state.mode === "B", setup, working, dims);
        const verts = ribbonMesh(samples, scaled, state.mode);
        this.uploadRibbon(verts);
        g.drawArrays(g.TRIANGLES, 0, verts.length / ribbonStride);
      }
      progress((index + 1) / Math.max(1, strokes.length));
      if (performance.now() - chunk > FRAME_BUDGET_MS) {
        await frame();
        chunk = performance.now();
      }
    }
    if (cancelled() || g.isContextLost()) return false;
    g.bindTexture(g.TEXTURE_2D, working.texture);
    g.generateMipmap(g.TEXTURE_2D);
    // Wait for GPU completion without blocking the UI; cancelled jobs never replace the completed image.
    const fence = g.fenceSync(g.SYNC_GPU_COMMANDS_COMPLETE, 0)!;
    g.flush();
    try {
      for (;;) {
        if (cancelled() || g.isContextLost()) return false;
        const status = g.clientWaitSync(fence, 0, 0);
        if (status === g.ALREADY_SIGNALED || status === g.CONDITION_SATISFIED)
          break;
        if (status === g.WAIT_FAILED)
          throw new Error(
            "GPU描画を完了できませんでした。再計算してください。",
          );
        await frame();
      }
    } finally {
      g.deleteSync(fence);
    }
    if (previewEdge === null) {
      [this.working, this.complete] = [this.complete, this.working];
      this.showPreview = false;
      this.fullReady = true;
    } else {
      [this.previewWorking, this.previewComplete] = [
        this.previewComplete,
        this.previewWorking,
      ];
      this.showPreview = true;
    }
    this.ready = true;
    progress(1);
    return true;
  }
  private uploadRibbon(vertices: Float32Array) {
    const g = this.gl;
    g.bindBuffer(g.ARRAY_BUFFER, this.buffer);
    if (vertices.byteLength > this.bufferCapacity) {
      let capacity = Math.max(1024, this.bufferCapacity);
      while (capacity < vertices.byteLength) capacity *= 2;
      g.bufferData(g.ARRAY_BUFFER, capacity, g.DYNAMIC_DRAW);
      this.bufferCapacity = capacity;
    }
    g.bufferSubData(g.ARRAY_BUFFER, 0, vertices);
  }
  private ribbonSetup(
    perPoint: boolean,
    options: {
      displacePx: number;
      edgeAmount: number;
      edgeTexel: number;
      shadeAmount: number;
      brushAmount: number;
      brushGrain: number;
      brushSeed: number;
      sourceScale: number;
      mixMode: number;
      mixSpin: number;
    },
    target: Target,
    dims: { width: number; height: number },
  ) {
    const g = this.gl,
      p = this.ribbon;
    this.bind(target);
    g.useProgram(p.program);
    g.bindVertexArray(this.vao);
    g.enable(g.BLEND);
    g.blendFuncSeparate(
      g.SRC_ALPHA,
      g.ONE_MINUS_SRC_ALPHA,
      g.ONE,
      g.ONE_MINUS_SRC_ALPHA,
    );
    this.pair(p, "resolution", dims.width, dims.height);
    this.flag(p, "perPoint", perPoint);
    g.uniform1f(this.location(p, "displacePx"), options.displacePx);
    g.uniform1f(this.location(p, "edgeAmount"), options.edgeAmount);
    g.uniform1f(this.location(p, "edgeTexel"), options.edgeTexel);
    g.uniform1f(this.location(p, "shadeAmount"), options.shadeAmount);
    g.uniform1f(this.location(p, "brushAmount"), options.brushAmount);
    g.uniform1f(this.location(p, "brushGrain"), options.brushGrain);
    g.uniform1f(this.location(p, "brushSeed"), options.brushSeed);
    g.uniform1f(this.location(p, "sourceScale"), options.sourceScale);
    g.uniform1i(this.location(p, "mixMode"), options.mixMode);
    g.uniform1f(this.location(p, "mixSpin"), options.mixSpin);
    this.texture(p, "image", this.photo!.texture, 0);
    this.ribbonReady = true;
  }
  present(width: number, height: number) {
    const image =
      this.showPreview && this.previewComplete
        ? this.previewComplete
        : this.complete;
    if (!this.ready || !image) return;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.copyTo(image, null, true);
  }
  async exportPNG(): Promise<Blob> {
    if (!this.fullReady || !this.complete)
      throw new Error("描画の完了後に書き出してください。");
    const g = this.gl,
      w = this.width,
      h = this.height;
    const buffer = g.createBuffer()!;
    g.bindBuffer(g.PIXEL_PACK_BUFFER, buffer);
    g.bufferData(g.PIXEL_PACK_BUFFER, w * h * 4, g.STREAM_READ);
    this.bind(this.complete);
    g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, 0);
    g.bindBuffer(g.PIXEL_PACK_BUFFER, null);
    const fence = g.fenceSync(g.SYNC_GPU_COMMANDS_COMPLETE, 0)!;
    g.flush();
    try {
      while (true) {
        const status = g.clientWaitSync(fence, 0, 0);
        if (status === g.WAIT_FAILED || g.isContextLost())
          throw new Error("書き出し中にGPUへの接続が失われました。");
        if (status !== g.TIMEOUT_EXPIRED) break;
        await frame();
      }
      const bytes = new Uint8ClampedArray(w * h * 4);
      g.bindBuffer(g.PIXEL_PACK_BUFFER, buffer);
      g.getBufferSubData(g.PIXEL_PACK_BUFFER, 0, bytes);
      g.bindBuffer(g.PIXEL_PACK_BUFFER, null);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas
        .getContext("2d", { colorSpace: "srgb" })!
        .putImageData(new ImageData(bytes, w, h, { colorSpace: "srgb" }), 0, 0);
      return await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => {
          canvas.width = canvas.height = 1;
          b ? resolve(b) : reject(new Error("PNGを作成できませんでした。"));
        }, "image/png"),
      );
    } finally {
      g.deleteSync(fence);
      g.deleteBuffer(buffer);
    }
  }
}
