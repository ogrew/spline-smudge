/** Replace only these GLSL functions to add another color space or transition profile.
 * Current policy: interpolate encoded sRGB channels; ease the weight at each control point.
 * This is a crossfade of corresponding ribbon-width positions, not texture/feature morphing.
 */
export const colorInterpolationGLSL = `
float colorWeight(float t) { return smoothstep(0.0, 1.0, t); }
vec4 interpolateColor(vec4 a, vec4 b, float t) { return mix(a, b, colorWeight(t)); }
`;
