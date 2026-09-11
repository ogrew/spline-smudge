import type { DocumentState, Stroke } from "./model.ts";
import { outputSize } from "./model.ts";
import { sampleCurve } from "./geometry.ts";
import { ribbonMesh, ribbonStride } from "./ribbon-mesh.ts";
import { colorInterpolationGLSL } from "./color-interpolation.ts";

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
layout(location=0) in vec2 position;
layout(location=1) in vec2 sourceA;
layout(location=2) in vec2 sourceB;
layout(location=3) in vec2 strip;
uniform vec2 resolution;
out vec2 uvA; out vec2 uvB; out vec2 uv;
void main(){uv=strip;uvA=sourceA/resolution;uvB=sourceB/resolution;gl_Position=vec4(position/resolution*2.0-1.0,0,1);}`;
const ribbonFragment = `#version 300 es
precision highp float;
in vec2 uvA; in vec2 uvB; in vec2 uv;
uniform sampler2D image; uniform bool perPoint; out vec4 color;
${colorInterpolationGLSL}
void main(){
vec4 a=texture(image,uvA);
color=perPoint?interpolateColor(a,texture(image,uvB),uv.y):a;
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
  private sourceKey = "";
  private sourceObject?: CanvasImageSource;
  width = 1;
  height = 1;
  ready = false;
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
    for (let i = 0; i < 4; i++) {
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
    this.sourceKey = "";
    this.sourceObject = undefined;
    this.drop(this.photo);
    this.drop(this.working);
    this.drop(this.complete);
    this.photo = this.working = this.complete = undefined;
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
  async render(
    source: CanvasImageSource,
    iw: number,
    ih: number,
    state: DocumentState,
    cancelled: () => boolean,
    progress: (p: number) => void,
  ): Promise<boolean> {
    this.prepare(source, iw, ih, state);
    const g = this.gl,
      scale = this.width / iw;
    this.copyTo(this.photo!, this.working!);
    const strokes = state.strokes.filter((stroke) => stroke.visible);
    if (strokes.length) this.ribbonSetup(state.mode === "B");
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
      };
      // Sample in source-image distance so zoom does not change the mesh.
      const samples = sampleCurve(scaled, Math.max(0.5, 2 * scale), state.kind);
      if (samples.length > 1) {
        const verts = ribbonMesh(samples, scaled, state.mode);
        this.uploadRibbon(verts);
        g.drawArrays(g.TRIANGLES, 0, verts.length / ribbonStride);
      }
      progress((index + 1) / Math.max(1, strokes.length));
      if (performance.now() - chunk > 8) {
        await frame();
        chunk = performance.now();
      }
    }
    if (cancelled() || g.isContextLost()) return false;
    g.bindTexture(g.TEXTURE_2D, this.working!.texture);
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
    [this.working, this.complete] = [this.complete, this.working];
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
  private ribbonSetup(perPoint: boolean) {
    const g = this.gl,
      p = this.ribbon;
    this.bind(this.working!);
    g.useProgram(p.program);
    g.bindVertexArray(this.vao);
    g.enable(g.BLEND);
    g.blendFuncSeparate(
      g.SRC_ALPHA,
      g.ONE_MINUS_SRC_ALPHA,
      g.ONE,
      g.ONE_MINUS_SRC_ALPHA,
    );
    this.pair(p, "resolution", this.width, this.height);
    this.flag(p, "perPoint", perPoint);
    this.texture(p, "image", this.photo!.texture, 0);
  }
  present(width: number, height: number) {
    if (!this.ready || !this.complete) return;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.copyTo(this.complete, null, true);
  }
  async exportPNG(): Promise<Blob> {
    if (!this.ready || !this.complete)
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
