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
const fullVertex = `#version 300 es
precision highp float;
out vec2 uv;
void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2)); uv=p; gl_Position=vec4(p*2.0-1.0,0,1);}`;
const copyFragment = `#version 300 es
precision highp float;
in vec2 uv; uniform sampler2D image; uniform bool flip; out vec4 color;
void main(){color=texture(image,vec2(uv.x,flip?1.0-uv.y:uv.y));}`;
// Separable gaussian: 13 taps at a stride matched by the mip level read, so a
// large radius stays cheap and prefiltered. highPass turns the second pass
// into a visualized detail band: photo - low + 0.5.
const blurFragment = `#version 300 es
precision highp float;
in vec2 uv; uniform sampler2D image; uniform sampler2D original;
uniform vec2 step; uniform float lod; uniform bool highPass; out vec4 color;
void main(){
const float w[7]=float[](1.0,0.8825,0.6065,0.3247,0.1353,0.0439,0.0111);
vec3 sum=textureLod(image,uv,lod).rgb*w[0];
float total=w[0];
for(int i=1;i<7;i++){
sum+=textureLod(image,uv+step*float(i),lod).rgb*w[i];
sum+=textureLod(image,uv-step*float(i),lod).rgb*w[i];
total+=2.0*w[i];
}
vec3 low=sum/total;
color=vec4(highPass?texture(original,uv).rgb-low+0.5:low,1.0);
}`;
// Resolve the composited working image into the completed target. Mode 0 is a
// plain copy; 1 adds the detail band back on the smeared colors; 2 adds the
// color band back under the smeared detail. flow holds low (1) or photo-low+0.5 (2).
const separateFragment = `#version 300 es
precision highp float;
in vec2 uv; uniform sampler2D comp; uniform sampler2D photo; uniform sampler2D flow;
uniform int sepMode; uniform float sepStrength; out vec4 color;
void main(){
vec3 c=texture(comp,uv).rgb;
if(sepMode==1)c+=(texture(photo,uv).rgb-texture(flow,uv).rgb)*sepStrength;
else if(sepMode==2)c=c-0.5+(texture(photo,uv).rgb-texture(flow,uv).rgb+0.5)*sepStrength;
color=vec4(clamp(c,0.0,1.0),1.0);
}`;
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
float lum(vec2 p){vec3 c=texture(image,p/resolution).rgb;return dot(c,vec3(0.2126,0.7152,0.0722));}
void main(){
uv=strip;uvA=sourceA/resolution;uvB=sourceB/resolution;ribbonNormal=normal;
float widthScale=1.0;
if(edgeAmount!=0.0){
vec2 dx=vec2(edgeTexel,0.0),dy=vec2(0.0,edgeTexel);
float e=clamp(length(vec2(lum(center+dx)-lum(center-dx),lum(center+dy)-lum(center-dy)))*3.0,0.0,1.0);
widthScale=clamp(1.0+edgeAmount*(e*2.0-1.0),0.0,3.0);
}
vec2 pos=center+normal*(misc.x*widthScale);
if(displacePx!=0.0)pos+=normal*((lum(center)-0.5)*2.0*displacePx);
gl_Position=vec4(pos/resolution*2.0-1.0,0,1);}`;
const ribbonFragment = `#version 300 es
precision highp float;
in vec2 uvA; in vec2 uvB; in vec2 uv; in vec2 ribbonNormal;
uniform sampler2D image; uniform bool perPoint; uniform float shadeAmount; out vec4 color;
${colorInterpolationGLSL}
void main(){
vec4 a=texture(image,uvA);
color=perPoint?interpolateColor(a,texture(image,uvB),uv.y):a;
if(shadeAmount>0.0){
// Cylinder-profile pseudo normal across the band; light from the upper left in image space.
float t=uv.x*2.0-1.0;
vec3 N=normalize(vec3(normalize(ribbonNormal)*t*0.85,sqrt(max(0.02,1.0-0.7225*t*t))));
vec3 L=normalize(vec3(-0.45,-0.6,0.66));
float diffuse=max(dot(N,L),0.0);
float specular=pow(max(dot(reflect(-L,N),vec3(0.0,0.0,1.0)),0.0),24.0);
color.rgb=color.rgb*mix(1.0,0.35+0.85*diffuse,shadeAmount)+specular*0.5*shadeAmount;
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
  private blur: Program;
  private separate: Program;
  private vao: WebGLVertexArrayObject;
  private buffer: WebGLBuffer;
  private bufferCapacity = 0;
  private photo?: Target;
  private working?: Target;
  private complete?: Target;
  // Frequency separation: the band the ribbons sample (low, or photo-low+0.5),
  // rebuilt only when the mode or radius changes.
  private flow?: Target;
  private flowKey = "";
  private photoMipsReady = false;
  private mipSampler: WebGLSampler;
  private sourceKey = "";
  private sourceObject?: CanvasImageSource;
  // False whenever another pass (e.g. present() during an await) may have
  // changed framebuffer, viewport, program, VAO, blend or texture state.
  private ribbonReady = false;
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
    this.blur = this.program(fullVertex, blurFragment);
    this.separate = this.program(fullVertex, separateFragment);
    // Overrides a texture's own filter during blur passes so textureLod can
    // read prefiltered mip levels without changing normal sampling.
    this.mipSampler = gl.createSampler()!;
    gl.samplerParameteri(
      this.mipSampler,
      gl.TEXTURE_MIN_FILTER,
      gl.LINEAR_MIPMAP_LINEAR,
    );
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
  private target(w: number, h: number, mipmapped = false, filtered = mipmapped): Target {
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
      filtered ? g.LINEAR_MIPMAP_LINEAR : g.LINEAR,
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
    this.sourceKey = "";
    this.sourceObject = undefined;
    this.drop(this.photo);
    this.drop(this.working);
    this.drop(this.complete);
    this.drop(this.flow);
    this.photo = this.working = this.complete = this.flow = undefined;
    this.flowKey = "";
    this.photoMipsReady = false;
    this.width = w;
    this.height = h;
    const staging = document.createElement("canvas");
    staging.width = w;
    staging.height = h;
    const ctx = staging.getContext("2d", { colorSpace: "srgb" })!;
    ctx.fillStyle = state.background;
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(source, 0, 0, w, h);
    // Mip levels are allocated for the separation blur (filled lazily), but the
    // photo keeps a non-mip filter so normal sampling is unchanged.
    this.photo = this.target(w, h, true, false);
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
    // Frequency separation: ribbons sample one band of the photo (the flow
    // texture) and the resolve pass adds the other band back on top.
    const { reaction, shade, separation } = state.options;
    const sepOn = !!separation?.on;
    if (sepOn)
      this.ensureFlow(
        separation.mode,
        Math.max(1, ((Math.max(iw, ih) * separation.radius) / 100) * scale),
      );
    this.copyTo(sepOn ? this.flow! : this.photo!, this.working!);
    const strokes = state.strokes.filter((stroke) => stroke.visible);
    // Photo-reactive options: each coefficient is 0 while its option is off,
    // which makes the shader output identical to the plain ribbon.
    const setup = {
      image: (sepOn ? this.flow! : this.photo!).texture,
      displacePx:
        reaction.on && reaction.mode === "displace"
          ? ((Math.min(iw, ih) * reaction.displaceAmount) / 100) * scale
          : 0,
      edgeAmount:
        reaction.on && reaction.mode === "edgeWidth" ? reaction.edgeAmount : 0,
      edgeTexel: 3 * scale,
      shadeAmount: shade.on ? shade.amount : 0,
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
      };
      // Sample in source-image distance so zoom does not change the mesh.
      const samples = sampleCurve(scaled, Math.max(0.5, 2 * scale), state.kind);
      if (samples.length > 1) {
        // A present() during the await below leaves foreign GPU state behind;
        // rebind the ribbon pipeline lazily so each stroke draws into working.
        if (!this.ribbonReady) this.ribbonSetup(state.mode === "B", setup);
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
    // Resolve working into the completed target: a plain copy, or the
    // separation add-back. Until here a cancelled job never touches complete;
    // past this point the image written there is always fully drawn.
    this.resolve(
      sepOn ? (separation.mode === "color" ? 1 : 2) : 0,
      sepOn ? separation.restore / 100 : 0,
    );
    g.bindTexture(g.TEXTURE_2D, this.complete!.texture);
    g.generateMipmap(g.TEXTURE_2D);
    // Wait for GPU completion without blocking the UI.
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
    this.ready = true;
    progress(1);
    return true;
  }
  /** Build the band the ribbons sample: a prefiltered separable gaussian of the
   * photo (mode "color"), or its visualized detail band (mode "texture"). Uses
   * working as a scratch target before the base copy overwrites it. */
  private ensureFlow(mode: "color" | "texture", radiusPx: number) {
    const g = this.gl;
    this.flow ??= this.target(this.width, this.height);
    const key = `${mode}:${Math.round(radiusPx * 10)}`;
    if (key === this.flowKey) return;
    if (!this.photoMipsReady) {
      g.bindTexture(g.TEXTURE_2D, this.photo!.texture);
      g.generateMipmap(g.TEXTURE_2D);
      this.photoMipsReady = true;
    }
    const stride = Math.max(1, radiusPx / 4),
      lod = Math.max(0, Math.log2(stride));
    const p = this.blur;
    g.disable(g.BLEND);
    g.useProgram(p.program);
    g.bindVertexArray(null);
    g.bindSampler(0, this.mipSampler);
    g.uniform1f(this.location(p, "lod"), lod);
    // Horizontal: photo -> working.
    this.bind(this.working!);
    this.texture(p, "image", this.photo!.texture, 0);
    this.texture(p, "original", this.photo!.texture, 1);
    this.pair(p, "step", stride / this.width, 0);
    this.flag(p, "highPass", false);
    g.drawArrays(g.TRIANGLES, 0, 3);
    // Vertical (into the detail band for mode "texture"): working -> flow.
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, this.working!.texture);
    g.generateMipmap(g.TEXTURE_2D);
    this.bind(this.flow);
    this.texture(p, "image", this.working!.texture, 0);
    this.pair(p, "step", 0, stride / this.height);
    this.flag(p, "highPass", mode === "texture");
    g.drawArrays(g.TRIANGLES, 0, 3);
    g.bindSampler(0, null);
    this.flowKey = key;
    this.ribbonReady = false;
  }
  /** Write working into complete: sepMode 0 copies, 1 adds photo-flow (the
   * detail band) scaled by sepStrength, 2 rebuilds colors under smeared detail. */
  private resolve(sepMode: number, sepStrength: number) {
    const g = this.gl,
      p = this.separate;
    this.bind(this.complete!);
    g.disable(g.BLEND);
    g.useProgram(p.program);
    g.bindVertexArray(null);
    this.texture(p, "comp", this.working!.texture, 0);
    this.texture(p, "photo", this.photo!.texture, 1);
    this.texture(p, "flow", (this.flow ?? this.photo!).texture, 2);
    g.uniform1i(this.location(p, "sepMode"), sepMode);
    g.uniform1f(this.location(p, "sepStrength"), sepStrength);
    g.drawArrays(g.TRIANGLES, 0, 3);
    this.ribbonReady = false;
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
      image: WebGLTexture;
      displacePx: number;
      edgeAmount: number;
      edgeTexel: number;
      shadeAmount: number;
      mixMode: number;
      mixSpin: number;
    },
  ) {
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
    g.uniform1f(this.location(p, "displacePx"), options.displacePx);
    g.uniform1f(this.location(p, "edgeAmount"), options.edgeAmount);
    g.uniform1f(this.location(p, "edgeTexel"), options.edgeTexel);
    g.uniform1f(this.location(p, "shadeAmount"), options.shadeAmount);
    g.uniform1i(this.location(p, "mixMode"), options.mixMode);
    g.uniform1f(this.location(p, "mixSpin"), options.mixSpin);
    this.texture(p, "image", options.image, 0);
    this.ribbonReady = true;
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
