import type { MixMode } from "./model.ts";

/** Uniform value for each interpolation mode; keep in sync with the GLSL below. */
export const mixModeIndex: Record<MixMode, number> = {
  srgb: 0,
  oklab: 1,
  oklch: 2,
  oklchLong: 3,
  hueSpin: 4,
};

/** Replace only these GLSL functions to add another color space or transition profile.
 * The mode is a uniform, so switching never recompiles the shader. All modes ease the
 * weight at each control point and stay a crossfade of corresponding ribbon-width
 * positions, not texture/feature morphing.
 * - 0 sRGB: mix encoded channels (original behaviour).
 * - 1 OKLab: perceptual mix; midpoints keep brightness and avoid muddy hues.
 * - 2/3 OKLCH: lightness/chroma/hue mixed separately; hue takes the short (2) or
 *   long (3) way around. An achromatic side borrows the other side's hue.
 * - 4 hue spin: OKLCH short path plus extra WHOLE hue turns (uniform, radians —
 *   always a multiple of 2π so control-point colors and interval joins stay exact). */
export const colorInterpolationGLSL = `
uniform int mixMode;
uniform float mixSpin;
const float TAU = 6.28318530718;
float colorWeight(float t) { return smoothstep(0.0, 1.0, t); }
vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
vec3 linearToOklab(vec3 c) {
  vec3 lms = pow(max(mat3(
    0.4122214708, 0.2119034982, 0.0883024619,
    0.5363325363, 0.6806995451, 0.2817188376,
    0.0514459929, 0.1073969566, 0.6299787005) * c, 0.0), vec3(1.0 / 3.0));
  return mat3(
    0.2104542553, 1.9779984951, 0.0259040371,
    0.7936177850, -2.4285922050, 0.7827717662,
    -0.0040720468, 0.4505937099, -0.8086757660) * lms;
}
vec3 oklabToLinear(vec3 c) {
  vec3 lms = mat3(
    1.0, 1.0, 1.0,
    0.3963377774, -0.1055613458, -0.0894841775,
    0.2158037573, -0.0638541728, -1.2914855480) * c;
  lms = lms * lms * lms;
  return mat3(
    4.0767416621, -1.2684380046, -0.0041960863,
    -3.3077115913, 2.6097574011, -0.7034186147,
    0.2309699292, -0.3413193965, 1.7076147010) * lms;
}
vec4 interpolateColor(vec4 a, vec4 b, float t) {
  float w = colorWeight(t);
  if (mixMode == 0) return mix(a, b, w);
  vec3 la = linearToOklab(srgbToLinear(a.rgb));
  vec3 lb = linearToOklab(srgbToLinear(b.rgb));
  vec3 mixed;
  if (mixMode == 1) mixed = mix(la, lb, w);
  else {
    float ca = length(la.yz), cb = length(lb.yz);
    const float achroma = 1e-4;
    // atan(0,0) is undefined; an achromatic side borrows the other side's hue.
    float ha = ca > achroma ? atan(la.z, la.y) : 0.0;
    float hb = cb > achroma ? atan(lb.z, lb.y) : 0.0;
    if (ca <= achroma) ha = hb;
    if (cb <= achroma) hb = ha;
    float d = mod(hb - ha + 0.5 * TAU, TAU) - 0.5 * TAU;
    if (mixMode == 3) d += d > 0.0 ? -TAU : TAU;
    if (mixMode == 4) d += mixSpin;
    float h = ha + d * w, c = mix(ca, cb, w);
    mixed = vec3(mix(la.x, lb.x, w), c * cos(h), c * sin(h));
  }
  return vec4(clamp(linearToSrgb(oklabToLinear(mixed)), 0.0, 1.0), mix(a.a, b.a, w));
}
`;
