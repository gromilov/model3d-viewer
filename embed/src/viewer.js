/**
 * A small WebGL viewer for one triangle soup. It owns nothing but GPU state:
 * the caller hands it a mesh, and it draws that mesh from an orbiting camera
 * whose up axis is +Z, which is what a 3D-printing file is authored in.
 *
 * The mesh is normalised once — centred on its bounds and scaled so its bounding
 * sphere has radius 1 — so the projection's near and far planes stay tight for
 * every model. The camera orbits; the model itself never rotates, which keeps the
 * fixed studio lighting reading as a turntable.
 */

// The bundle inlines every module into one scope, so this is a no-op there; it
// exists so the file can also be imported directly, which is how the checks run.
import { hexToRgb } from './paint.js';

const VERTEX_SHADER = `
attribute vec3 aPosition;
attribute vec3 aNormal;
attribute vec3 aColour;
uniform mat4 uProjection;
uniform mat4 uView;
uniform float uScale;
varying vec3 vNormal;
varying vec3 vColour;
varying vec3 vWorldPosition;
void main() {
  vNormal = aNormal;
  vColour = aColour;
  vWorldPosition = aPosition * uScale;
  gl_Position = uProjection * uView * vec4(aPosition * uScale, 1.0);
}
`;

/**
 * The plastic material, shared by the model and the sliced view.
 *
 * FDM plastic is a dielectric with a semi-gloss surface: a soft body colour, a
 * tight but not mirror-sharp highlight, a sheen that builds at the silhouette
 * where the surface turns away, and a little light bleeding through near the
 * terminator. The old shader had three fixed lambert lobes and multiplied the
 * base colour by their sum, which is why a dark filament went black and a light
 * one looked like flat paper.
 *
 * Written as GLSL ES 1.00 — no fwidth, no textureLod, no dynamic loops — because
 * that is what a browser compiles it as.
 */
const PLASTIC_COMMON = `
// GGX: the microsurface distribution behind a plastic highlight. Roughness is
// the width of the surface's microscopic slopes, so a small value gives the
// tight glint of polished plastic and a large one the broad sheen of matte.
float distributionGGX(float nDotH, float roughness) {
  float a = max(roughness, 0.03);
  a = a * a;
  float a2 = a * a;
  float d = nDotH * nDotH * (a2 - 1.0) + 1.0;
  return a2 / (3.14159265 * d * d);
}

// Smith-Schlick: how much of the microsurface shadows itself, so a highlight
// fades toward the grazing angles instead of running to infinity.
float visibilitySmith(float nDotV, float nDotL, float roughness) {
  float k = roughness * roughness * 0.5;
  float v = nDotV / (nDotV * (1.0 - k) + k);
  float l = nDotL / (nDotL * (1.0 - k) + k);
  return v * l;
}

// Schlick's fresnel for a dielectric. At normal incidence plastic reflects about
// 4% of the light; at grazing angles it approaches a mirror. That rise is what
// draws a bright line along a plastic edge.
float fresnelSchlick(float cosTheta, float f0) {
  return f0 + (1.0 - f0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

// Filmic tone mapping: an exposure curve rather than a hard clamp.
//
// Without it a white filament clips flat, because the lights sum past 1.0 and
// everything above it becomes the same paper white. ACES-style compression keeps
// the highlight from ever reaching pure white, so a white print keeps a gradient
// at its brightest point and reads as a lit object rather than as a silhouette.
vec3 toneMap(vec3 colour) {
  // Exposure first: the studio is brighter than the display, so bring it down
  // into range before the curve.
  // Exposure. A mid-grey print has to stay mid-grey rather than being pushed
  // into the shadows by the curve, so this is set where a lit top surface of a
  // mid-tone filament lands near the middle of the range.
  // Exposure. Bright filaments were clipping to flat paper: a white at 0.93
  // linear times a lit surface plus specular runs past 1.0, and everything above
  // it maps to the same white. Bringing the exposure down puts the top of the
  // range back inside the curve, so a white print keeps a gradient across its lit
  // face instead of becoming a silhouette.
  colour *= 0.80;
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  vec3 mapped = (colour * (a * colour + b)) / (colour * (c * colour + d) + e);
  return clamp(mapped, 0.0, 1.0);
}

// A photographic studio, seen in the surface: a vertical gradient floor to
// ceiling, one broad softbox up and to the left, and a cooler one behind. A
// single sharp light reads as a game preview; two large sources with different
// colour temperatures read as a product shot.
vec3 studioReflection(vec3 direction, float roughness) {
  // A dark room with bright lights in it, not a bright sky.
  //
  // The gradient was 0.045 to 0.40, which made the *ambience* of the room the
  // strongest thing a dark filament reflected: a black part picked up a constant
  // grey sheen over its whole surface and read as brushed metal. A real studio is
  // the other way round -- a dim room with a few very bright sources -- so the
  // gradient is low and the sources carry the light. That is also what makes a
  // highlight legible: it stands out against dark, not against pale grey.
  float up = clamp(direction.z * 0.5 + 0.5, 0.0, 1.0);
  vec3 sky = mix(vec3(0.011, 0.011, 0.012), vec3(0.078, 0.078, 0.082), up);

  // Three sources of deliberately different shapes, because a studio is not
  // three identical points: a tall softbox up and left, a round fill behind, and
  // a narrow strip on the right that draws a thin line down a curved surface.
  // Their sizes follow roughness, so a polished part shows each as a distinct
  // shape and a matte one blurs them into a single sheen.
  vec3 keyDir = normalize(vec3(-0.42, -0.55, 0.72));
  float warm = max(dot(direction, keyDir), 0.0);
  // A softbox is taller than it is wide: measuring the vertical axis separately
  // turns a round dot into a soft vertical bar.
  float vertical = abs(dot(direction, vec3(0.0, 0.0, 1.0)));
  // A source must be at least as wide as the highlight it produces, or the
  // glint sits inside a halo: a 150-wide lobe against a 3-degree GGX lobe leaves
  // the highlight sharp and a soft ring around it. These are matched instead.
  float warmTight = mix(38.0, 2.5, roughness);
  float bar = pow(warm, warmTight) * mix(1.4, 1.0, vertical);
  sky += vec3(1.0, 0.985, 0.96) * bar * 3.6;

  vec3 fillDir = normalize(vec3(0.62, 0.48, 0.30));
  float cool = max(dot(direction, fillDir), 0.0);
  float coolTight = mix(26.0, 2.0, roughness);
  sky += vec3(0.62, 0.74, 1.0) * pow(cool, coolTight) * 1.5;

  // A narrow strip light: a band rather than a spot, which is what puts a long
  // highlight along the edge of a cylinder.
  vec3 stripDir = normalize(vec3(0.85, -0.30, 0.15));
  float strip = max(dot(direction, stripDir), 0.0);
  float stripBand = smoothstep(0.72, 0.99, strip) * mix(1.0, 0.6, roughness);
  sky += vec3(0.95, 0.98, 1.0) * stripBand * 0.9;

  return sky;
}

// The studio's irradiance on a diffuse surface: a broad upward gradient, cheap
// to evaluate and enough to keep a matte side from going flat black.
vec3 studioAmbient(vec3 normal) {
  float up = clamp(normal.z * 0.5 + 0.5, 0.0, 1.0);
  // Kept low: an ambient that lifts the shadows also flattens a white print,
  // which needs its bright side and its shadow side to differ.
  // Neutral, not cool. A blue-shifted ambient against a warm key gave a black part
  // a warm top and a cool flank -- a visible colour split on a surface that should
  // read as one neutral dark, and the hue argued with the filament's own.
  // The studio, as a lit volume rather than a single ambient number.
  //
  // Three levels instead of a flat gradient: a dark floor the object sits on, a
  // mid band that does most of the work, and a ceiling. A single linear ramp
  // between two colours reads as a flat wash, and on a black filament it reads as
  // nothing at all -- the tinted term is multiplied by the body colour, so black
  // gets no light from it. The result is tuned so a black part still shows its
  // geometry (about 55 of 255 on a lit face) while a white one stays at 225
  // rather than clipping to paper.
  vec3 floorTint = vec3(0.030, 0.030, 0.033);
  vec3 midTint = vec3(0.115, 0.116, 0.122);
  vec3 ceilTint = vec3(0.155, 0.157, 0.164);
  return up < 0.5
    ? mix(floorTint, midTint, up * 2.0)
    : mix(midTint, ceilTint, (up - 0.5) * 2.0);
}

// The colourless part of the studio light, applied by addition rather than by
// multiplication: the tinted ambient is scaled by the body colour, and a black
// filament has no body colour to scale, so its geometry would flatten to a
// silhouette. This describes which way the surface faces, which is as true of
// black plastic as of white, and it is weighted toward the floor so a bright
// print is not greyed.
vec3 studioShape(vec3 normal) {
  float up = clamp(normal.z * 0.5 + 0.5, 0.0, 1.0);
  return vec3(0.052, 0.052, 0.055) * (0.35 + 0.65 * up);
}

// One light's contribution: wrapped diffuse, plus a specular lobe.
//
// The wrap is the piece that makes it read as plastic rather than as painted
// metal: plastic scatters under the surface, so its terminator is soft and its
// body colour survives into shadow instead of dropping to the ambient.
vec3 shadePlastic(
    vec3 normal, vec3 toEye, vec3 lightDir, vec3 lightColour,
    vec3 base, float roughness, float metalness, float wrap, float specularGain) {
  float nDotL = dot(normal, lightDir);
  float nDotV = max(dot(normal, toEye), 0.001);

  // Metalness is the input, not "reflection": it is a property of the material,
  // while how much it reflects is the consequence. A dielectric keeps its body
  // colour and reflects 4% of the light; a metal has no diffuse at all and tints
  // its reflection with its own colour. Mixing between the two is what a partially
  // metallic filament looks like, and it is what the two parameters describe.
  float metal = clamp(metalness, 0.0, 1.0);

  // Metals have no diffuse: all their light arrives as reflection.
  float wrapped = max((nDotL + wrap) / (1.0 + wrap), 0.0);
  vec3 diffuse = base * lightColour * wrapped * (1.0 - metal);

  // The specular colour: white for a dielectric, the body colour for a metal.
  vec3 specularTint = mix(vec3(1.0), base, metal);
  // Fresnel at normal incidence: 4% for plastic, the tinted body for metal.
  vec3 f0 = mix(vec3(0.04), base, metal);

  vec3 specular = vec3(0.0);
  if (nDotL > 0.0 && specularGain > 0.0) {
    vec3 halfway = normalize(lightDir + toEye);
    float nDotH = max(dot(normal, halfway), 0.0);
    float vDotH = max(dot(toEye, halfway), 0.0);
    float d = distributionGGX(nDotH, roughness);
    float vis = visibilitySmith(nDotV, nDotL, roughness);
    // The fresnel is a colour, not a number: for a metal f0 is the tinted body,
    // so taking a single channel would throw the tint away and leave a grey
    // highlight on a coloured metal. It multiplies per channel.
    vec3 f = f0 + (vec3(1.0) - f0) * pow(1.0 - vDotH, 5.0);
    specular = lightColour * specularTint * f * (d * vis) * nDotL * specularGain;
  }
  return diffuse + specular;
}
`;

/**
 * The model's surface: a plastic body under a studio.
 *
 * The body colour is applied once, as the diffuse albedo, and every light adds
 * to it rather than multiplying it. That ordering is what keeps a black filament
 * readable and a white one from blowing out, and it is why the highlight can sit
 * on top of a dark body instead of vanishing into it.
 */
const FRAGMENT_SHADER = `
precision mediump float;
varying vec3 vNormal;
varying vec3 vColour;
varying vec3 vWorldPosition;
uniform vec3 uColor;
uniform float uColourMix;
uniform vec3 uEye;
/** 0 = studio material, 1 = plain shading. */
uniform float uPlainLighting;
uniform float uRoughness;
/** How metallic the surface is: 0 is plastic, 1 is metal. */
uniform float uMetalness;
/** How much of the scene behind shows through, 0 = opaque. */
uniform float uTransparency;
/** Overall light level for the scene, 1 = the studio as designed. */
uniform float uLightLevel;
${PLASTIC_COMMON}
void main() {
  vec3 normal = normalize(vNormal);
  if (!gl_FrontFacing) normal = -normal;
  vec3 toEye = normalize(uEye - vWorldPosition);
  float roughness = clamp(uRoughness, 0.05, 1.0);

  // Painted models take the project's filament colour per face; an unpainted one
  // keeps the single material colour.
  vec3 base = mix(uColor, vColour, uColourMix);

  // A key softbox up and left, a cooler fill behind, and the studio's own
  // ambient. The wrap is wide because plastic scatters under its surface, so the
  // terminator is soft.
  vec3 keyDir = normalize(vec3(-0.42, -0.55, 0.72));
  vec3 fillDir = normalize(vec3(0.62, 0.48, 0.30));
  vec3 rimDir = normalize(vec3(0.10, 0.85, -0.25));
  // A fourth source from the opposite horizontal side, which the other three do
  // not cover: without it a layer's wall is bright on two faces and dark on the
  // other two, and a stack of them reads as alternating light and dark bands
  // rather than as a solid side.
  vec3 bounceDir = normalize(vec3(0.30, -0.86, 0.10));

  // Plain mode: what a slicer's preview looks like by default. One soft key over
  // a floor, no specular and no reflection -- a flat read of shape and colour,
  // which is what you want while checking a model rather than admiring it.
  //
  // The shading term is *added* to the body rather than multiplying it. A
  // multiply cannot describe a dark part: black in, black out, whatever the
  // light does, so every layer of a black plate became the same near-black and
  // the texture vanished. Scaling the light by a small fraction of the body and
  // adding the rest keeps the hue while giving the geometry a gradient --
  // body times a scaled light, plus a small form term that does not depend on
  // the filament at all.
  if (uPlainLighting > 0.5) {
    float up = clamp(normal.z * 0.5 + 0.5, 0.0, 1.0);
    float facing = clamp(dot(normal, keyDir), 0.0, 1.0);
    float light = 0.30 + 0.70 * (facing * 0.65 + up * 0.35);
    // A little colourless form, enough to separate a stroke's top from its flank
    // on a black print without greying a bright one.
    float form = 0.045 * (facing * 0.6 + up * 0.4);
    gl_FragColor = vec4(base * light + vec3(form), 1.0);
    return;
  }

  float metalness = clamp(uMetalness, 0.0, 1.0);
  float transparency = clamp(uTransparency, 0.0, 1.0);

  vec3 colour = studioAmbient(normal) * base + studioShape(normal);
  colour += shadePlastic(normal, toEye, keyDir, vec3(1.00, 0.99, 0.97) * 0.72, base, roughness, metalness, 0.55, 0.9);
  colour += shadePlastic(normal, toEye, fillDir, vec3(0.86, 0.92, 1.00) * 0.30, base, roughness, metalness, 0.40, 0.0);
  colour += shadePlastic(normal, toEye, rimDir, vec3(0.96, 0.98, 1.00) * 0.24, base, roughness, metalness, 0.70, 0.0);
  // A fourth source from the opposite horizontal side, so a wall is not bright
  // on two faces and dark on the other two.
  colour += shadePlastic(normal, toEye, bounceDir, vec3(0.92, 0.96, 1.00) * 0.28, base, roughness, metalness, 0.85, 0.0);

  // The reflection of the studio, seen in the surface. It is added, and its
  // strength follows the fresnel, so it gathers at the silhouette the way it does
  // on a real moulded part.
  // The studio, reflected. Its base reflectance is higher than a mirror's 4%
  // because moulded plastic scatters a little under the surface too, and without
  // that the reflection is invisible over the middle of a part and only appears
  // at its rim.
  vec3 reflected = reflect(-toEye, normal);
  float fresnel = fresnelSchlick(max(dot(normal, toEye), 0.0), 0.10);
  // A metal mirrors the studio strongly and tinted; a dielectric picks up a faint
  // sheen. Metalness drives both, so they cannot disagree.
  colour += studioReflection(reflected, roughness) * fresnel * mix(0.35, 3.2, metalness);

  // A faint sheen where the surface turns away from the eye: the last thing that
  // separates a dark print from a dark background.
  float edge = 1.0 - max(dot(normal, toEye), 0.0);
  colour += vec3(0.30, 0.44, 0.50) * pow(edge, 3.0) * 0.30;

  gl_FragColor = vec4(toneMap(colour), 1.0 - transparency * 0.85);
}
`;

/**
 * Expand one segment's quad in the vertex shader.
 *
 * Each extruded stroke arrives as its centre line plus the half-width and
 * half-height of its cross-section. The four corners of the quad are pushed out
 * along a *camera-facing* pair of axes inside that cross-section, each by the
 * support function of the extrusion rectangle — `halfWidth * |dot(a, right)| +
 * halfHeight * |dot(a, up)|` — so the quad always covers the silhouette of a
 * rounded tube no matter where the camera orbits. This is the same construction
 * OrcaSlicer's segment shader uses, and it is why two triangles per stroke are
 * enough for the whole plate.
 */
const SEGMENT_VERTEX_SHADER = `
attribute vec3 aRing;
attribute vec3 aPositionA;
attribute vec3 aPositionB;
attribute vec2 aHalfExtent;
attribute vec3 aColour;
attribute float aLayer;
uniform vec3 uPalette[8];
uniform mat4 uProjection;
uniform mat4 uView;
uniform vec3 uCenter;
uniform float uScale;
uniform vec2 uLayerRange;
uniform float uDimBelow;
varying vec3 vWorldPosition;
varying vec3 vStart;
varying vec3 vEnd;
varying vec3 vLineDir;
varying vec3 vRight;
varying vec2 vHalfExtent;
varying vec3 vColour;
varying float vDim;
varying float vSlot;

const vec3 UP = vec3(0.0, 0.0, 1.0);

void main() {
  // The layer slider sets a range; anything outside it is dropped here rather
  // than filtered on the CPU, so dragging costs one uniform write.
  if (aLayer < uLayerRange.x - 0.5 || aLayer > uLayerRange.y + 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  // With the top-layer-only mode the layers below the slider keep drawing, but
  // darkened, which is how OrcaSlicer shows what a layer sits on. uDimBelow
  // is -1 when that mode is off.
  vDim = (uDimBelow >= 0.0 && aLayer < uLayerRange.x - 0.5) ? 0.0 : 1.0;

  vec3 a = (aPositionA - uCenter) * uScale;
  vec3 b = (aPositionB - uCenter) * uScale;
  vec3 line = b - a;
  float lineLength = length(line);
  vec3 lineDir = lineLength < 1e-6 ? vec3(1.0, 0.0, 0.0) : line / lineLength;

  // The extrusion's cross-section lies in the plane normal to its centre line:
  // right runs across the stroke, up is the layer's vertical. Expanding along
  // these two keeps neighbouring strokes exactly one width apart, so a dense
  // plate stays opaque. A vertical stroke has no natural roll and borrows X.
  vec3 right = abs(dot(lineDir, UP)) > 0.9
    ? normalize(cross(vec3(1.0, 0.0, 0.0), lineDir))
    : normalize(cross(lineDir, UP));
  vec3 up = normalize(cross(right, lineDir));

  vec2 halfExtent = aHalfExtent * uScale;

  // aRing carries the corner of the diamond and which end it belongs to:
  //   .xz in {-1,0,1} pick right/left and bottom/top, .y picks start or end.
  vec3 ring = aRing;
  bool atEnd = ring.y > 0.5;

  // A quarter-width overhang at each end closes the wedge two strokes leave
  // where they turn a corner -- OrcaSlicer's Cap_Rounding_Factor, also 0.25.
  vec3 along = atEnd ? b + lineDir * halfExtent.x * 0.25
                     : a - lineDir * halfExtent.x * 0.25;

  vec3 position = along + ring.x * halfExtent.x * right + ring.z * halfExtent.y * up;

  vWorldPosition = position;
  vStart = a;
  vEnd = b;
  vLineDir = lineDir;
  vRight = right;
  vHalfExtent = halfExtent;

  // The instance carries a palette slot, not a colour, so a filament can be
  // recoloured by a uniform update instead of a buffer rebuild. The slot also
  // travels to the fragment stage: each filament has its own surface, so the
  // material parameters are indexed by it.
  int slot = int(aColour.r + 0.5);
  vSlot = slot < 8 ? float(slot) : 8.0;
  vColour = slot < 8
    ? uPalette[slot]
    : vec3(0.60, 0.64, 0.70);
  gl_Position = uProjection * uView * vec4(position, 1.0);
}
`;

/**
 * Shade a segment through an *elliptical* normal.
 *
 * The quad is a flat stand-in for a rounded extrusion, so taking its geometric
 * normal would light every stroke like a sheet. Instead the normal is the
 * gradient of the ellipse inscribed in the cross-section — `offset.right /
 * halfWidth²` and `offset.up / halfHeight²`, with the component along the stroke
 * removed. OrcaSlicer documents exactly this construction for its own extrusion
 * shading.
 *
 * The quad itself stays *rectangular* on purpose. Trimming it to the ellipse
 * would carve 21% out of every cross-section (1 − π/4), and adjacent strokes are
 * laid down touching, so that would open a gap between every pair of lines and
 * make a dense plate look like a pale mesh. OrcaSlicer only applies an ellipse
 * test in its section view, where a cut plane needs it; the ordinary pass draws
 * the full rectangle.
 */
const SEGMENT_FRAGMENT_SHADER = `
precision mediump float;
varying vec3 vWorldPosition;
varying vec3 vStart;
varying vec3 vEnd;
varying vec3 vLineDir;
varying vec3 vRight;
varying vec2 vHalfExtent;
varying vec3 vColour;
varying float vDim;
varying float vSlot;
uniform vec3 uEye;
/** 0 = studio material, 1 = plain shading. */
uniform float uPlainLighting;
uniform float uRoughness;
/** Per-filament surface: matte, metalness, transparency, packed in slots. */
uniform vec3 uSurfaceMatte;     // .x slot0, .y slot1, .z slot2
uniform vec3 uSurfaceMatte2;    // .x slot3, .y slot4, .z slot5
uniform vec3 uSurfaceMetal;
uniform vec3 uSurfaceMetal2;
uniform vec3 uSurfaceAlpha;
uniform vec3 uSurfaceAlpha2;
/** Overall light level for the scene, 1 = the studio as designed. */
uniform float uLightLevel;
${PLASTIC_COMMON}

void main() {
  vec3 line = vEnd - vStart;
  float lengthSq = dot(line, line);

  // Where this fragment sits inside the cross-section.
  vec3 radial = vWorldPosition - vStart;
  float t = lengthSq > 1e-12 ? clamp(dot(radial, line) / lengthSq, 0.0, 1.0) : 0.0;
  vec3 offset = vWorldPosition - vStart - t * line;

  vec3 crossAxis = cross(vRight, vLineDir);
  float horizontal = dot(offset, vRight);
  float vertical = dot(offset, crossAxis);
  float halfWidth = max(vHalfExtent.x, 1e-6);
  float halfHeight = max(vHalfExtent.y, 1e-6);

  // The shading normal, matched to the section that is actually drawn.
  //
  // The geometry is a rectangle now, but the normal was the gradient of an
  // *ellipse*, so the shading said "rounded tube" while the shape said "flat
  // wall": the normal swung through the full quarter turn across a 0.20 mm
  // height, which drew a hard white stripe along every layer's side and left its
  // top comparatively flat. On a real print the wall is near-vertical and the top
  // is near-horizontal, with the transition compressed into a small bevel where
  // they meet.
  //
  // A superellipse gradient gives exactly that: with an exponent of 4 the surface
  // reads as a rounded box -- flat over most of each face, turning quickly at the
  // edge -- so the walls are uniformly lit and only the bevel catches a highlight.
  const float SECTION = 4.0;
  float ax = clamp(abs(horizontal) / halfWidth, 0.0, 1.0);
  float az = clamp(abs(vertical) / halfHeight, 0.0, 1.0);
  vec3 normal =
      sign(horizontal) * pow(ax, SECTION - 1.0) / halfWidth * vRight
    + sign(vertical) * pow(az, SECTION - 1.0) / halfHeight * crossAxis;
  normal = normal - dot(normal, vLineDir) * vLineDir;
  float normalLength = length(normal);
  normal = normalLength > 1e-6 ? normal / normalLength : normalize(crossAxis);
  // The normal must point away from the stroke's own axis. Resolving it against
  // the offset is right for a synthetic normal; testing gl_FrontFacing ties it to
  // the winding of a quad that is only a proxy for the tube, so a whole face
  // flips at once and its lit side turns dark.
  if (dot(normal, offset) < 0.0) normal = -normal;

  // The same plastic body under the same studio as the model. The stroke's
  // elliptical normal means each filament shades as a rounded extrusion: the
  // highlight runs along it and the terminator wraps, which is what makes a
  // sliced plate read as printed plastic rather than as flat ribbons.
  vec3 toEye = normalize(uEye - vWorldPosition);

  vec3 keyDir = normalize(vec3(-0.42, -0.55, 0.72));
  vec3 fillDir = normalize(vec3(0.62, 0.48, 0.30));
  vec3 rimDir = normalize(vec3(0.10, 0.85, -0.25));
  vec3 bounceDir = normalize(vec3(0.30, -0.86, 0.10));

  // A layer the slider has left below the range keeps drawing but dimmed, so the
  // scrubbed layer reads as sitting on the print instead of floating.
  vec3 body = mix(vColour * 0.28, vColour, vDim);

  // No colourless lift here.
  //
  // It was added so a black filament would keep its form, but a lift is added
  // *after* the body colour, so it cannot be black: the display's gamma curve
  // turns a linear 0.018 into 31 of 255 and a linear 0.053 into 67, which is a
  // grey part pretending to be black. A dark print has to get its form from
  // shading that scales with its own colour, not from a constant.
  // Plain mode, as on the model: one soft key over a floor, no specular and no
  // reflection, with the form term added rather than multiplied so a black
  // plate still shows its layers. On a sliced plate this is the readable view --
  // material shading on 0.42 mm strokes mostly adds noise at a distance.
  if (uPlainLighting > 0.5) {
    float up = clamp(normal.z * 0.5 + 0.5, 0.0, 1.0);
    float facing = clamp(dot(normal, keyDir), 0.0, 1.0);
    float light = 0.30 + 0.70 * (facing * 0.65 + up * 0.35);
    float form = 0.045 * (facing * 0.6 + up * 0.4);
    gl_FragColor = vec4(body * light + vec3(form), 1.0);
    return;
  }

  // Each filament carries its own surface. The arrays hold six slots in two
  // vec3s, because a uniform array of floats is indexed dynamically on some
  // drivers only when it is a vector array -- and this has to work on a Mac.
  float slotIndex = vSlot;
  vec3 mattePack = slotIndex < 2.5
    ? uSurfaceMatte
    : (slotIndex < 5.5 ? uSurfaceMatte2 : vec3(0.5));
  float slotMatte = slotIndex < 0.5 ? mattePack.x
    : (slotIndex < 1.5 ? mattePack.y
    : (slotIndex < 2.5 ? mattePack.z
    : (slotIndex < 3.5 ? mattePack.x
    : (slotIndex < 4.5 ? mattePack.y : mattePack.z))));
  vec3 metalPack = slotIndex < 2.5
    ? uSurfaceMetal
    : (slotIndex < 5.5 ? uSurfaceMetal2 : vec3(0.0));
  float slotMetal = slotIndex < 0.5 ? metalPack.x
    : (slotIndex < 1.5 ? metalPack.y
    : (slotIndex < 2.5 ? metalPack.z
    : (slotIndex < 3.5 ? metalPack.x
    : (slotIndex < 4.5 ? metalPack.y : metalPack.z))));
  vec3 alphaPack = slotIndex < 2.5
    ? uSurfaceAlpha
    : (slotIndex < 5.5 ? uSurfaceAlpha2 : vec3(0.0));
  float slotAlpha = slotIndex < 0.5 ? alphaPack.x
    : (slotIndex < 1.5 ? alphaPack.y
    : (slotIndex < 2.5 ? alphaPack.z
    : (slotIndex < 3.5 ? alphaPack.x
    : (slotIndex < 4.5 ? alphaPack.y : alphaPack.z))));

  float roughness = clamp(slotMatte < 0.02 ? uRoughness : slotMatte, 0.04, 1.0);
  float metalness = clamp(slotMetal, 0.0, 1.0);
  float transparency = clamp(slotAlpha, 0.0, 1.0);

  vec3 colour = studioAmbient(normal) * body + studioShape(normal);
  colour *= uLightLevel;
  colour += shadePlastic(normal, toEye, keyDir, vec3(1.00, 0.99, 0.97) * 0.72, body, roughness, metalness, 0.55, 0.9);
  colour += shadePlastic(normal, toEye, fillDir, vec3(0.86, 0.92, 1.00) * 0.30, body, roughness, metalness, 0.40, 0.0);
  colour += shadePlastic(normal, toEye, rimDir, vec3(0.96, 0.98, 1.00) * 0.24, body, roughness, metalness, 0.70, 0.0);
  colour += shadePlastic(normal, toEye, bounceDir, vec3(0.92, 0.96, 1.00) * 0.28, body, roughness, metalness, 0.85, 0.0);

  // The studio, reflected. Its base reflectance is higher than a mirror's 4%
  // because moulded plastic scatters a little under the surface too, and without
  // that the reflection is invisible over the middle of a part and only appears
  // at its rim.
  // The reflection is weaker here than on a flat surface.
  //
  // A stroke's normal is the ellipse of its cross-section, so it turns through
  // the full quarter turn across a 0.42 mm width: the grazing part of that curve
  // is a large share of the pixels, where fresnel approaches one and the
  // studio's white reflection lands at full strength. On a flat face the same
  // maths applies only at the rim. Weighted alike, a sliced plate reads as
  // overexposed while a model looks right, so the weight is set for the stroke.
  vec3 reflected = reflect(-toEye, normal);
  // Fresnel at a dielectric's real 4%, not the 10% an earlier version used.
  //
  // That 10% was added because at 4% the reflection vanished over the middle of
  // a part — but a black filament has no diffuse at all, so the reflection is
  // *all* it has, and at 10% that reflection was bright enough to look like
  // polished metal: no body colour, a white sheen over the whole surface. That
  // is the definition of a metal. At 4% a black part reads as black plastic with
  // a faint sheen, which is what it is.
  float fresnel = fresnelSchlick(max(dot(normal, toEye), 0.0), 0.04);
  colour += studioReflection(reflected, roughness) * fresnel * 0.85;

  // No sheen term: on a stroke it is another full-width additive lift, and the
  // dark filaments already get their edge from the reflection above.
  gl_FragColor = vec4(toneMap(colour), 1.0 - transparency * 0.85);
}
`;

/**
 * Compile one shader stage, reporting the driver's log on failure.
 *
 * A lost or exhausted context makes \`createShader\` return null rather than
 * throw, so that case is reported by name instead of surfacing as a null
 * \`<shader>\` source assignment.
 */
function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (shader === null) {
    throw new Error('model3d: the WebGL context is lost or unavailable');
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`model3d: shader compile failed: ${log || 'no driver log'}`);
  }
  return shader;
}

/** Link the viewer's program and expose its attribute and uniform locations. */
function createProgram(gl) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`model3d: program link failed: ${log}`);
  }
  return {
    program,
    position: gl.getAttribLocation(program, 'aPosition'),
    normal: gl.getAttribLocation(program, 'aNormal'),
    colour: gl.getAttribLocation(program, 'aColour'),
    projection: gl.getUniformLocation(program, 'uProjection'),
    view: gl.getUniformLocation(program, 'uView'),
    scale: gl.getUniformLocation(program, 'uScale'),
    color: gl.getUniformLocation(program, 'uColor'),
    colourMix: gl.getUniformLocation(program, 'uColourMix'),
    eye: gl.getUniformLocation(program, 'uEye'),
    roughness: gl.getUniformLocation(program, 'uRoughness'),
    plainLighting: gl.getUniformLocation(program, 'uPlainLighting'),
    metalness: gl.getUniformLocation(program, 'uMetalness'),
    transparency: gl.getUniformLocation(program, 'uTransparency'),
  };
}

const BED_VERTEX_SHADER = `
attribute vec3 aPosition;
uniform mat4 uProjection;
uniform mat4 uView;
uniform vec3 uCenter;
uniform float uScale;
varying vec3 vWorld;

void main() {
  // Only the plate's own coordinates travel: the grid is a function of the bed's
  // X and Y in millimetres, so it stays the same size at every zoom.
  vWorld = aPosition;
  gl_Position = uProjection * uView * vec4((aPosition - uCenter) * uScale, 1.0);
}
`;

/**
 * The build plate as a grid and nothing else.
 *
 * A slicer's bed is drawn as a solid slab with walls, which reads as a physical
 * object and competes with the print sitting on it. What a print needs from its
 * bed is a sense of scale and position; a grid gives both without adding a
 * surface to look at, and the plate stays transparent so the scene's own
 * background shows straight through.
 *
 * Two spacings are drawn -- a fine 10 mm mesh and a coarser 50 mm one -- because
 * one spacing reads as noise zoomed out and as emptiness zoomed in. Lines fade
 * toward the plate's edge so the bed ends rather than being cut off.
 */
const BED_FRAGMENT_SHADER = `
precision mediump float;
varying vec3 vWorld;
uniform vec3 uGridColour;
uniform vec3 uAxisColour;
uniform float uOpacity;
uniform vec2 uBedCentre;
uniform float uBedExtent;

// One ruling on a repeating coordinate.
//
// GLSL ES 1.00 has no fwidth without an extension pragma, and a shader that
// fails to compile takes the whole view down, so the line width is a fixed
// fraction of the spacing instead: thin enough to read as a hairline at the
// framing the plate is usually seen at, without being invisible when zoomed out.
float ruler(vec2 world, float spacing, float width) {
  vec2 cell = abs(fract(world / spacing - 0.5) - 0.5) * spacing;
  vec2 line = vec2(1.0) - smoothstep(vec2(0.0), vec2(spacing * 0.02 * width), cell);
  return max(line.x, line.y);
}

void main() {
  vec2 world = vWorld.xy;

  float fine = ruler(world, 10.0, 1.0) * 0.30;
  float coarse = ruler(world, 50.0, 1.5);
  // The plate's own axes, brighter than its rulings.
  float axis = max(1.0 - smoothstep(0.0, 0.5, abs(world.x)),
                   1.0 - smoothstep(0.0, 0.5, abs(world.y)));

  vec3 colour = mix(uGridColour, uAxisColour, axis);

  // End the bed at its edge instead of cutting it off square. Measured from the
  // bed's own centre: measuring from the origin, which is a corner of an
  // ordinary build plate, fades one corner and leaves the opposite one bright.
  float fade = 1.0 - smoothstep(0.55, 1.0, length(world - uBedCentre) / uBedExtent);

  float strength = max(fine, coarse) * fade;
  if (strength < 0.01) discard;
  gl_FragColor = vec4(colour, strength * uOpacity);
}
`;


/**
 * Link the program that draws sliced strokes as rounded tubes.
 *
 * This is a second program rather than a branch in the first: a model is a
 * closed surface drawn from triangle attributes, while a sliced plate is a heap
 * of strokes whose quads are expanded against the camera. Keeping them apart
 * avoids paying for unused attributes on either path.
 */
function createSegmentProgram(gl) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, SEGMENT_VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, SEGMENT_FRAGMENT_SHADER);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`model3d: segment program link failed: ${log}`);
  }
  return {
    program,
    positionA: gl.getAttribLocation(program, 'aPositionA'),
    positionB: gl.getAttribLocation(program, 'aPositionB'),
    halfExtent: gl.getAttribLocation(program, 'aHalfExtent'),
    colour: gl.getAttribLocation(program, 'aColour'),
    ring: gl.getAttribLocation(program, 'aRing'),
    layer: gl.getAttribLocation(program, 'aLayer'),
    projection: gl.getUniformLocation(program, 'uProjection'),
    view: gl.getUniformLocation(program, 'uView'),
    center: gl.getUniformLocation(program, 'uCenter'),
    scale: gl.getUniformLocation(program, 'uScale'),
    eye: gl.getUniformLocation(program, 'uEye'),
    roughness: gl.getUniformLocation(program, 'uRoughness'),
    plainLighting: gl.getUniformLocation(program, 'uPlainLighting'),
    metalness: gl.getUniformLocation(program, 'uMetalness'),
    transparency: gl.getUniformLocation(program, 'uTransparency'),
    surfaceMatte: gl.getUniformLocation(program, 'uSurfaceMatte'),
    surfaceMatte2: gl.getUniformLocation(program, 'uSurfaceMatte2'),
    surfaceMetal: gl.getUniformLocation(program, 'uSurfaceMetal'),
    surfaceMetal2: gl.getUniformLocation(program, 'uSurfaceMetal2'),
    surfaceAlpha: gl.getUniformLocation(program, 'uSurfaceAlpha'),
    surfaceAlpha2: gl.getUniformLocation(program, 'uSurfaceAlpha2'),
    lightLevel: gl.getUniformLocation(program, 'uLightLevel'),
    layerRange: gl.getUniformLocation(program, 'uLayerRange'),
    palette: gl.getUniformLocation(program, 'uPalette'),
    dimBelow: gl.getUniformLocation(program, 'uDimBelow'),
  };
}

/** Link the bed program and expose its locations. */
function createBedProgram(gl) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, BED_VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, BED_FRAGMENT_SHADER);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`model3d: bed program link failed: ${log}`);
  }
  return {
    program,
    position: gl.getAttribLocation(program, 'aPosition'),
    projection: gl.getUniformLocation(program, 'uProjection'),
    view: gl.getUniformLocation(program, 'uView'),
    center: gl.getUniformLocation(program, 'uCenter'),
    scale: gl.getUniformLocation(program, 'uScale'),
    gridColour: gl.getUniformLocation(program, 'uGridColour'),
    axisColour: gl.getUniformLocation(program, 'uAxisColour'),
    bedCentre: gl.getUniformLocation(program, 'uBedCentre'),
    bedExtent: gl.getUniformLocation(program, 'uBedExtent'),
    opacity: gl.getUniformLocation(program, 'uOpacity'),
  };
}

/** A column-major perspective projection matrix. */
export function perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2);
  const range = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (near + far) * range, -1,
    0, 0, 2 * near * far * range, 0,
  ]);
}

/** A column-major look-at view matrix. */
export function lookAt(eye, target, up) {
  const zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
  const zLength = Math.hypot(zx, zy, zz) || 1;
  const zv = [zx / zLength, zy / zLength, zz / zLength];
  let xv = [up[1] * zv[2] - up[2] * zv[1], up[2] * zv[0] - up[0] * zv[2], up[0] * zv[1] - up[1] * zv[0]];
  let xLength = Math.hypot(xv[0], xv[1], xv[2]);
  if (xLength < 1e-6) {
    // The camera sits on the up axis; borrow any perpendicular basis.
    xv = [1, 0, 0];
    xLength = 1;
  }
  xv = [xv[0] / xLength, xv[1] / xLength, xv[2] / xLength];
  const yv = [
    zv[1] * xv[2] - zv[2] * xv[1],
    zv[2] * xv[0] - zv[0] * xv[2],
    zv[0] * xv[1] - zv[1] * xv[0],
  ];
  return new Float32Array([
    xv[0], yv[0], zv[0], 0,
    xv[1], yv[1], zv[1], 0,
    xv[2], yv[2], zv[2], 0,
    -(xv[0] * eye[0] + xv[1] * eye[1] + xv[2] * eye[2]),
    -(yv[0] * eye[0] + yv[1] * eye[1] + yv[2] * eye[2]),
    -(zv[0] * eye[0] + zv[1] * eye[1] + zv[2] * eye[2]),
    1,
  ]);
}

export const FIELD_OF_VIEW = Math.PI / 4;
/** Camera distance in normalised units: the sphere of radius 1 with a margin. */
/**
 * How far the camera sits, in units where the model's half-diagonal is 1.
 *
 * The margin is what decides how much of the frame the print fills. At 1.28 the
 * longest side of a flat plate reached about 61% of the frame, which reads as a
 * small object floating in a large void; 1.02 puts it near 78% with the corners
 * still inside. A plate is also far wider than it is tall, so the vertical fill
 * is what the eye judges and it is worth pushing.
 */
export const BASE_DISTANCE = 1.02 / Math.sin(FIELD_OF_VIEW / 2);

/**
 * The nearest and farthest distances the camera will draw.
 *
 * Both follow the camera distance instead of being fixed. A fixed pair has to
 * trade two errors against each other: close enough for the overview means deep
 * zoom clips the model against the near plane, and far enough for deep zoom
 * wastes so much depth precision at overview scale that a 0.2 mm layer z-fights
 * with the one below it. Scaling the pair with the distance keeps the ratio
 * small — and the depth buffer precise — at every zoom level.
 *
 * @param distance - how far the eye sits from the model's centre.
 * @returns the near and far plane distances.
 */
function clipPlanes(distance) {
  return [Math.max(1e-5, distance * 0.02), distance + 2];
}

/**
 * How far the orbit camera may travel from its framing distance.
 *
 * The lower bound is what lets the viewer read individual toolpaths: at the
 * framing distance a whole 130 mm plate is in view, and a 0.2 mm layer is a
 * couple of pixels tall, so inspecting a stroke means getting tens of times
 * closer. The upper bound is a modest pull-back for seeing the plate in context.
 */
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 6;

/**
 * Create a viewer bound to one canvas.
 * @param canvas - the drawing surface; its CSS size drives the backing store.
 * @returns the viewer handle.
 */
export function createViewer(canvas) {
  // `powerPreference: 'high-performance'` asks the browser for the discrete GPU on
  // a machine that has both, which is what a MacBook with an integrated and a
  // discrete chip would otherwise leave to the browser's own choice. `antialias`
  // is asked for but not required: some drivers ignore it on a high-performance
  // context, and a jagged edge is better than a context that fails to start.
  const options = {
    antialias: true,
    alpha: true,
    premultipliedAlpha: false,
    powerPreference: 'high-performance',
    failIfMajorPerformanceCaveat: false,
    // The drawing buffer is normally cleared once the frame is presented, which
    // makes a screenshot taken after the fact come back empty. Keeping it costs a
    // little memory and is the difference between an export that works and one
    // that silently produces a blank image.
    preserveDrawingBuffer: true,
  };
  const gl = canvas.getContext('webgl2', options)
    ?? canvas.getContext('webgl', options);
  if (gl === null) throw new Error('model3d: WebGL is unavailable in this browser');

  // Which renderer is actually in use. WebGL always runs on the GPU when there is
  // one, but a browser can still fall back to its software rasteriser -- and a
  // plate with 400k strokes is then unusably slow. Reporting it makes that
  // visible instead of merely slow, and tells a user why.
  const rendererInfo = (() => {
    // The extension is absent on a locked-down or very old context, and asking
    // for it is not guaranteed to answer with a value at all -- both are treated
    // as "unknown" rather than as a failure, since the viewer works either way.
    const debug = typeof gl.getExtension === 'function'
      ? gl.getExtension('WEBGL_debug_renderer_info')
      : null;
    if (debug === null || debug === undefined || debug.UNMASKED_RENDERER_WEBGL === undefined) {
      return { renderer: 'unknown', vendor: 'unknown', software: false };
    }
    const renderer = gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) ?? 'unknown';
    const vendor = gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) ?? 'unknown';
    // SwiftShader, llvmpipe, Software Rasterizer and Apple's own software path all
    // name themselves here.
    const software = /swiftshader|llvmpipe|software|basic render/i.test(String(renderer));
    return { renderer: String(renderer), vendor: String(vendor), software };
  })();

  const program = createProgram(gl);
  const segmentProgram = createSegmentProgram(gl);
  const bedProgram = createBedProgram(gl);
  const bedBuffer = gl.createBuffer();
  const positionBuffer = gl.createBuffer();
  const normalBuffer = gl.createBuffer();
  const colourBuffer = gl.createBuffer();
  const edgeBuffer = gl.createBuffer();
  const segmentBuffer = gl.createBuffer();
  const segmentRingBuffer = gl.createBuffer();
  const segmentIndexBuffer = gl.createBuffer();

  let mode = 'shaded';
  let triangleCount = 0;
  let hasColours = false;
  let twoSided = false;
  let yaw = -0.65;
  let pitch = 0.42;
  let zoom = 1;
  // The scene can be dragged, not only orbited: `pan` slides the camera's target
  // across the screen plane, in the same normalised units the model is scaled
  // into. It is a camera offset rather than a model transform so the lighting,
  // which is fixed to model space, keeps reading as a turntable.
  // Three components: the drag builds a full 3-vector, and lookAt needs one.
  let pan = [0, 0, 0];
  let disposed = false;

  // The printer's bed: its own small mesh, and whether it is drawn at all. A
  // sliced file states its bed outline, so the slab is built from it.
  let bedVisible = false;
  let bedTriangles = 0;
  let bedBounds = null;
  // The mesh as handed in, kept for the tracer: the GPU buffers hold normalised
  // coordinates, and a BVH has to be built from the same normalisation the shader
  // applies, so both are needed together.
  let currentMesh = null;

  // Called whenever the orbit changes, so the navigation cube can turn to match
  // and the panel can remember where the camera was left.
  //
  // A set rather than one slot: the cube and the settings store are separate
  // interested parties, and a single slot silently handed the cube's subscription
  // to whichever caller registered last. That is the kind of failure that is
  // invisible until two features are used together -- which is exactly when a
  // viewer is used.
  const orbitListeners = new Set();

  // A sliced plate takes the segment pipeline: one quad per stroke, expanded
  // against the camera in the vertex shader. `meshScale`/`meshCenter` normalise
  // both pipelines identically, so framing, orbit and zoom stay shared.
  let segmentMode = false;
  let segmentCount = 0;
  // The layer slider's position: an inclusive range over the plate's layers, and
  // whether the layers under it are dimmed instead of hidden.
  let layerCount = 0;
  let layerRange = [0, 0];
  /**
   * First instance index of each layer, and how many strokes there are in total.
   *
   * A slicer writes layer by layer, so the strokes for one layer are one
   * contiguous run of the instance buffer. That means the visible range can be
   * drawn by offsetting into it and shortening the instance count, instead of
   * submitting every stroke and letting the vertex shader discard the hidden
   * ones. On a 153k-stroke plate the difference is most of the frame.
   */
  let layerFirst = null;
  let strokeTotal = 0;
  let dimBelow = false;
  let indexCount = 0;
  let meshScale = 1;
  let meshCenter = [0, 0, 0];

  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);
  // The scene's background. Transparent by default, so the sidebar's own surface
  // shows through; a chosen colour replaces it.
  let background = null;
  // Whether the scene is shaded as a material or plainly; see setPlainLighting.
  let plainLighting = false;
  // Surface character, per filament. Each entry is the slot's own material, so a
  // plate with a glossy black and a matte white is expressible.
  const DEFAULT_SURFACE = { matte: 0.5, metalness: 0.0, transparency: 0.0 };
  let surfaces = [DEFAULT_SURFACE];
  /**
   * The colour of an unpainted model, in linear RGB.
   *
   * An STL carries no colour at all, and a file without per-face colours leaves
   * `uColourMix` at zero, so this uniform is what the body is drawn with. It was
   * never set anywhere -- only the wireframe branch assigned it, for its line
   * colour -- so every STL rendered pure black: the uniform kept its default of
   * zero and multiplying any light by black is black.
   *
   * A warm neutral rather than white: white blows out under the studio's key, and
   * this reads as the grey plastic an unpainted print actually is.
   */
  const UNPAINTED_COLOUR = [0.58, 0.57, 0.55];
  // The studio's overall level, 1 being the way it was built.
  let lightLevel = 1.0;
  // The filament palette, in linear RGB, as the shader wants it. Kept flat for
  // the uniform call and padded to the array's fixed length of eight.
  let paletteLinear = new Float32Array(24);
  let paletteSlots = 0;
  gl.clearColor(0, 0, 0, 0);

  // Set while an export is rendering, so the export's own size is not overwritten
  // by the on-screen size.
  let renderingExport = false;

  /** Resize the backing store to the canvas's device-pixel size. */
  const resize = () => {
    if (renderingExport) return;
    const ratio = Math.min(globalThis.devicePixelRatio ?? 1, 2.5);
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  };

  /**
   * Build the bed slab from the outline the file states.
   *
   * The outline is a flat list of corners in millimetres, so the slab is the
   * outline carried down a few millimetres: a top face plus a wall per edge.
   * A bed stated by a file with no usable outline leaves the buffer empty, and
   * the toggle then has nothing to show.
   *
   * @param bed - the outline and bounds, or undefined for a file that has none.
   */
  const uploadBed = (bed) => {
    bedBounds = bed ?? null;
    if (bed === undefined || bed.outline === undefined || bed.outline.length < 3) {
      bedTriangles = 0;
      bedVisible = false;
      return;
    }
    // A flat sheet at Z=0 and nothing else: no walls, no thickness. The plate is
    // a reference plane, so it only needs a surface for the grid to lie on, and
    // any solid geometry would put a box into the scene the print sits in.
    const outline = bed.outline;
    const positions = [];
    const push = (x, y) => positions.push(x, y, 0);

    // Triangulated as a fan from the first corner, which covers a rectangle and
    // any convex outline a slicer might state.
    for (let i = 1; i + 1 < outline.length; i += 1) {
      push(outline[0][0], outline[0][1]);
      push(outline[i][0], outline[i][1]);
      push(outline[i + 1][0], outline[i + 1][1]);
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, bedBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, Float32Array.from(positions), gl.STATIC_DRAW);
    bedTriangles = positions.length / 9;
    bedVisible = false;
  };

  /**
   * Upload a stroke mesh and frame the camera on it.
   *
   * The vertices stay in model space: the vertex shader subtracts the centre and
   * applies the scale, which keeps the expansion's half-extents in the same unit
   * as the positions around them. The bounding sphere is measured from the box
   * the mesh already computed, so no second pass over the buffer is needed.
   */
  const uploadSegments = (mesh) => {
    segmentMode = true;
    segmentCount = mesh.segments;
    twoSided = true;
    triangleCount = mesh.triangles;
    // The file's own palette, in slot order. `setPalette` converts sRGB to linear
    // and uploads it; called here so a freshly loaded plate is correctly coloured
    // without the caller having to know about it.
    if (Array.isArray(mesh.palette) && mesh.palette.length > 0) {
      const next = new Float32Array(24);
      const count = Math.min(mesh.palette.length, 8);
      for (let index = 0; index < count; index += 1) {
        const [r, g, b] = hexToRgb(mesh.palette[index]);
        next[index * 3] = r;
        next[index * 3 + 1] = g;
        next[index * 3 + 2] = b;
      }
      paletteLinear = next;
      paletteSlots = count;
    }
    layerCount = mesh.layerCount ?? 0;
    layerRange = [0, Math.max(0, layerCount - 1)];
    dimBelow = false;
    layerFirst = mesh.layerFirst ?? null;
    strokeTotal = mesh.segments ?? 0;

    meshCenter = [mesh.center[0], mesh.center[1], mesh.center[2]];
    const half = [
      mesh.size[0] / 2,
      mesh.size[1] / 2,
      mesh.size[2] / 2,
    ];
    const radius = Math.hypot(half[0], half[1], half[2]);
    meshScale = radius > 1e-6 ? 1 / radius : 1;

    // The ring is shared by every stroke; only the per-stroke payload is
    // repeated, which is what keeps a 400k-stroke plate inside GPU memory.
    gl.bindBuffer(gl.ARRAY_BUFFER, segmentBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.instances, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, segmentRingBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.ring, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, segmentIndexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    indexCount = mesh.indices.length;

    uploadBed(mesh.bed);

    zoom = 1;
    draw();
  };

  /** Upload a mesh, centring and normalising it, and frame the camera on it. */
  const setMesh = (mesh) => {
    if (disposed) return;
    currentMesh = mesh;
    triangleCount = mesh.triangles;
    // A sliced plate is flat ribbons: culling its back faces would hollow it.
    twoSided = mesh.twoSided === true;

    // A sliced plate carries strokes, not triangles: it takes the segment
    // pipeline, whose quads are expanded against the camera at draw time.
    if (mesh.kind === 'segments') {
      uploadSegments(mesh);
      return;
    }
    segmentMode = false;
    segmentCount = 0;
    layerFirst = null;
    strokeTotal = 0;
    // A plain model carries no bed, so one left over from a sliced file must not
    // stay behind and be offered as if it belonged to this file.
    uploadBed(undefined);

    // Normalise: centre on the bounding box, then scale the bounding sphere to 1.
    const centre = mesh.center;
    let maximumRadiusSquared = 0;
    for (let index = 0; index < triangleCount * 9; index += 3) {
      const x = mesh.positions[index] - centre[0];
      const y = mesh.positions[index + 1] - centre[1];
      const z = mesh.positions[index + 2] - centre[2];
      const squared = x * x + y * y + z * z;
      if (squared > maximumRadiusSquared) maximumRadiusSquared = squared;
    }
    const radius = Math.sqrt(maximumRadiusSquared);
    const scale = radius > 1e-6 ? 1 / radius : 1;
    meshScale = scale;
    meshCenter = [centre[0], centre[1], centre[2]];

    const positions = new Float32Array(triangleCount * 9);
    for (let index = 0; index < triangleCount * 9; index += 3) {
      positions[index] = (mesh.positions[index] - centre[0]) * scale;
      positions[index + 1] = (mesh.positions[index + 1] - centre[1]) * scale;
      positions[index + 2] = (mesh.positions[index + 2] - centre[2]) * scale;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);

    // Painted projects carry one colour per triangle corner; an unpainted mesh
    // gets a constant buffer so the attribute stays bound in both cases.
    hasColours = mesh.colours !== undefined && mesh.colours.length === positions.length;
    const colours = hasColours ? mesh.colours : new Float32Array(positions.length).fill(1);
    gl.bindBuffer(gl.ARRAY_BUFFER, colourBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, colours, gl.STATIC_DRAW);

    // Wireframe draws the triangle edges as line segments over the same vertices.
    const edges = new Uint32Array(triangleCount * 6);
    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
      const vertex = triangle * 3;
      const offset = triangle * 6;
      edges[offset] = vertex;
      edges[offset + 1] = vertex + 1;
      edges[offset + 2] = vertex + 1;
      edges[offset + 3] = vertex + 2;
      edges[offset + 4] = vertex + 2;
      edges[offset + 5] = vertex;
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, edgeBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, edges, gl.STATIC_DRAW);

    zoom = 1;
    draw();
  };

  /**
   * Draw on the next animation frame, coalescing repeated requests.
   *
   * A drag delivers pointer moves faster than the display refreshes -- a trackpad
   * can report several per frame -- and each one called `draw()` synchronously. On
   * a big plate a frame costs about twenty milliseconds, so the moves queued up
   * faster than they could be drawn: every redundant frame was work thrown away,
   * and the backlog is what a drag felt like. State still updates on every move;
   * only the painting is coalesced.
   */
  let frameRequest = 0;
  const requestDraw = () => {
    if (frameRequest !== 0) return;
    const run = () => {
      frameRequest = 0;
      draw();
    };
    if (typeof globalThis.requestAnimationFrame === 'function') {
      frameRequest = globalThis.requestAnimationFrame(run);
    } else {
      frameRequest = globalThis.setTimeout(run, 16);
    }
  };

  /**
   * The slice of the instance buffer the current layer range needs.
   *
   * Returns `{ first, count }` in strokes. With `dimBelow` the hidden layers still
   * draw, so the whole buffer is used; otherwise only the visible run is submitted,
   * which is what keeps a slider drag from re-walking every layer.
   *
   * A mesh built before `layerFirst` existed has no offsets, and falls back to the
   * whole buffer -- correct, just slower, which is the right way for a fallback to
   * fail.
   */
  const visibleStrokes = () => {
    if (layerFirst === null || layerFirst.length === 0) {
      return { first: 0, count: segmentCount };
    }
    // `dimBelow` used to force the whole buffer, since the dimmed layers still
    // draw. They are the layers *below* the range, which in a slicer's order means
    // the run starts at the buffer's first stroke either way -- so the slice is
    // still contiguous and the saving survives. Only the visible top changes it.
    const low = Math.max(0, Math.min(layerFirst.length - 1, layerRange[0]));
    const high = Math.max(low, Math.min(layerFirst.length - 1, layerRange[1]));
    const first = dimBelow ? 0 : layerFirst[low];
    // The layer after the last visible one starts the next run, so its offset is
    // where this range ends; the final layer runs to the end of the buffer.
    const end = high + 1 < layerFirst.length ? layerFirst[high + 1] : strokeTotal;
    return { first, count: Math.max(0, end - first) };
  };

  const draw = () => {
    if (disposed) return;
    resize();
    gl.viewport(0, 0, canvas.width, canvas.height);
    // Blending is only needed when something is translucent; leaving it off for an
    // opaque plate keeps the depth buffer meaningful and the strokes in front of
    // each other in the right order.
    // Blending is needed when any filament is translucent.
    const anyTranslucent = surfaces.some((entry) => entry.transparency > 0.001);
    if (anyTranslucent) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    } else {
      gl.disable(gl.BLEND);
    }
    // One clear for both buffers, in the chosen background; transparent when none
    // is set, which is what lets the sidebar's surface show through.
    if (background === null) gl.clearColor(0, 0, 0, 0);
    else gl.clearColor(background[0], background[1], background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (triangleCount === 0) return;

    const aspect = canvas.width / Math.max(1, canvas.height);
    const distance = BASE_DISTANCE * zoom;
    const cosPitch = Math.cos(pitch);
    // The orbit places the eye on a sphere round the target, and a scene drag
    // slides both together. Moving the target alone would keep the eye where it
    // is and so *turn* the camera towards the shift — the model would pivot
    // rather than slide, which is the difference between panning and orbiting.
    const eye = [
      cosPitch * Math.cos(yaw) * distance + pan[0],
      cosPitch * Math.sin(yaw) * distance + pan[1],
      Math.sin(pitch) * distance + pan[2],
    ];
    const target = pan;

    // The bed is drawn first and without depth writes: it is a reference surface
    // under the print, so it must not occlude the plate sprouting from it.
    if (bedVisible && bedTriangles > 0) {
      drawBed(target, aspect, eye, distance);
    }

    // A sliced plate draws through its own program: each stroke's quad is
    // expanded in the vertex shader, so the camera position and the model's
    // centre and scale travel in as uniforms instead of being baked in.
    if (segmentMode) {
      gl.useProgram(segmentProgram.program);
      const [nearPlane, farPlane] = clipPlanes(distance);
      gl.uniformMatrix4fv(segmentProgram.projection, false, perspective(FIELD_OF_VIEW, aspect, nearPlane, farPlane));
      gl.uniformMatrix4fv(segmentProgram.view, false, lookAt(eye, target, [0, 0, 1]));
      gl.uniform3f(segmentProgram.center, meshCenter[0], meshCenter[1], meshCenter[2]);
      gl.uniform1f(segmentProgram.scale, meshScale);
      gl.uniform3f(segmentProgram.eye, eye[0], eye[1], eye[2]);
      // Semi-gloss, and deliberately not glossier than this. A stroke is 0.42 mm
      // wide and its shading normal runs across that width, so a tight highlight
      // covers one or two pixels of each stroke and the plate sparkles like
      // glitter instead of reading as a surface. At 0.5 the highlight spans the
      // stroke and the sheen is continuous from one line to the next.
      gl.uniform1f(segmentProgram.plainLighting, plainLighting ? 1 : 0);
      uploadSurfaces(segmentProgram);
      if (segmentProgram.palette !== null) {
        gl.uniform3fv(segmentProgram.palette, paletteLinear);
      }
      gl.uniform2f(segmentProgram.layerRange, layerRange[0], layerRange[1]);
      gl.uniform1f(segmentProgram.dimBelow, dimBelow ? 0 : -1);

      // Both faces of a stroke can turn toward the eye as it orbits, so culling
      // is off: the fragment shader trims each quad back to its ellipse anyway.
      gl.disable(gl.CULL_FACE);

      // Per-vertex: the ring corner, shared by every stroke.
      gl.bindBuffer(gl.ARRAY_BUFFER, segmentRingBuffer);
      gl.enableVertexAttribArray(segmentProgram.ring);
      gl.vertexAttribPointer(segmentProgram.ring, 3, gl.FLOAT, false, 3 * 4, 0);

      // Per-instance: one stroke's payload, advanced once per stroke.
      const stride = 12 * 4;
      gl.bindBuffer(gl.ARRAY_BUFFER, segmentBuffer);
      gl.enableVertexAttribArray(segmentProgram.positionA);
      gl.vertexAttribPointer(segmentProgram.positionA, 3, gl.FLOAT, false, stride, 0);
      gl.vertexAttribDivisor(segmentProgram.positionA, 1);
      gl.enableVertexAttribArray(segmentProgram.positionB);
      gl.vertexAttribPointer(segmentProgram.positionB, 3, gl.FLOAT, false, stride, 3 * 4);
      gl.vertexAttribDivisor(segmentProgram.positionB, 1);
      gl.enableVertexAttribArray(segmentProgram.halfExtent);
      gl.vertexAttribPointer(segmentProgram.halfExtent, 2, gl.FLOAT, false, stride, 6 * 4);
      gl.vertexAttribDivisor(segmentProgram.halfExtent, 1);
      gl.enableVertexAttribArray(segmentProgram.colour);
      gl.vertexAttribPointer(segmentProgram.colour, 3, gl.FLOAT, false, stride, 8 * 4);
      gl.vertexAttribDivisor(segmentProgram.colour, 1);
      gl.enableVertexAttribArray(segmentProgram.layer);
      gl.vertexAttribPointer(segmentProgram.layer, 1, gl.FLOAT, false, stride, 11 * 4);
      gl.vertexAttribDivisor(segmentProgram.layer, 1);

      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, segmentIndexBuffer);
      // Only the visible run of strokes is submitted. Instancing reads per-instance
      // attributes from the start of the buffer, so the slice is expressed as a
      // vertex-attribute offset on each one rather than as a draw offset -- a
      // draw cannot skip instances, only whole draws.
      const slice = visibleStrokes();
      const byteOffset = slice.first * 12 * 4;
      if (byteOffset > 0) {
        gl.vertexAttribPointer(segmentProgram.positionA, 3, gl.FLOAT, false, stride, byteOffset);
        gl.vertexAttribPointer(segmentProgram.positionB, 3, gl.FLOAT, false, stride, byteOffset + 3 * 4);
        gl.vertexAttribPointer(segmentProgram.halfExtent, 2, gl.FLOAT, false, stride, byteOffset + 6 * 4);
        gl.vertexAttribPointer(segmentProgram.colour, 3, gl.FLOAT, false, stride, byteOffset + 8 * 4);
        gl.vertexAttribPointer(segmentProgram.layer, 1, gl.FLOAT, false, stride, byteOffset + 11 * 4);
      }
      gl.drawElementsInstanced(gl.TRIANGLES, indexCount, gl.UNSIGNED_SHORT, 0, slice.count);
      return;
    }

    gl.useProgram(program.program);
    const [nearPlane, farPlane] = clipPlanes(distance);
    gl.uniformMatrix4fv(program.projection, false, perspective(FIELD_OF_VIEW, aspect, nearPlane, farPlane));
    gl.uniformMatrix4fv(program.view, false, lookAt(eye, target, [0, 0, 1]));
    gl.uniform1f(program.scale, 1);
    gl.uniform3f(program.eye, eye[0], eye[1], eye[2]);
    // An unpainted model reads as the same material, slightly softer.
    gl.uniform1f(program.plainLighting, plainLighting ? 1 : 0);
    // The body colour for a mesh with no per-face colours. Set on every draw, not
    // only for unpainted meshes: the uniform otherwise keeps whatever the last
    // wireframe pass left in it.
    gl.uniform3f(program.color, UNPAINTED_COLOUR[0], UNPAINTED_COLOUR[1], UNPAINTED_COLOUR[2]);
    uploadSurfaces(program);

    // Per-vertex, unlike the stroke pipeline. The divisor is *not* part of a vertex
    // array object's per-program state in the way it looks: it lives on the
    // attribute index, and the two pipelines happen to share indices by layout. The
    // stroke path sets it to 1 for its instanced attributes and leaving it there
    // meant a model drawn after a plate read one colour per *triangle* instead of
    // per vertex -- every face taking the colour of an unrelated corner, so the lid
    // came back flat and wrong after a trip through the sliced view. Reset
    // explicitly on every draw: cheap, and it cannot drift again.
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.enableVertexAttribArray(program.position);
    gl.vertexAttribPointer(program.position, 3, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(program.position, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
    gl.enableVertexAttribArray(program.normal);
    gl.vertexAttribPointer(program.normal, 3, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(program.normal, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, colourBuffer);
    gl.enableVertexAttribArray(program.colour);
    gl.vertexAttribPointer(program.colour, 3, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(program.colour, 0);
    gl.uniform1f(program.colourMix, hasColours ? 1 : 0);

    if (twoSided || mode === 'wireframe') gl.disable(gl.CULL_FACE);
    else gl.enable(gl.CULL_FACE);

    if (mode === 'wireframe') {
      // Wireframe has its own line colour, so it overrides the body colour here
      // and the next solid draw sets it again above.
      gl.uniform3f(program.color, 0.42, 0.50, 0.68);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, edgeBuffer);
      gl.drawElements(gl.LINES, triangleCount * 6, gl.UNSIGNED_INT, 0);
    } else {
      gl.drawArrays(gl.TRIANGLES, 0, triangleCount * 3);
    }

  };

  /** Draw the bed slab under whatever the current view shows. */
  const drawBed = (target, aspect, eye, distance) => {
    const [nearPlane, farPlane] = clipPlanes(distance);
    gl.useProgram(bedProgram.program);
    gl.uniformMatrix4fv(bedProgram.projection, false, perspective(FIELD_OF_VIEW, aspect, nearPlane, farPlane));
    gl.uniformMatrix4fv(bedProgram.view, false, lookAt(eye, target, [0, 0, 1]));
    gl.uniform3f(bedProgram.center, meshCenter[0], meshCenter[1], meshCenter[2]);
    gl.uniform1f(bedProgram.scale, meshScale);
    // A cool cyan grid over nothing: the plate is a reference, so it is drawn
    // only as rulings, and they fade out at the edge on their own.
    gl.uniform3f(bedProgram.gridColour, 0.36, 0.62, 0.72);
    gl.uniform3f(bedProgram.axisColour, 0.44, 0.88, 1.0);
    gl.uniform1f(bedProgram.opacity, 0.55);
    // The fade is measured from the plate's own centre, which the outline states.
    const bed = bedBounds;
    if (bed !== null && bed.minimum !== undefined && bed.maximum !== undefined) {
      gl.uniform2f(
        bedProgram.bedCentre,
        (bed.minimum[0] + bed.maximum[0]) / 2,
        (bed.minimum[1] + bed.maximum[1]) / 2,
      );
      gl.uniform1f(
        bedProgram.bedExtent,
        Math.hypot(bed.maximum[0] - bed.minimum[0], bed.maximum[1] - bed.minimum[1]) / 2,
      );
    } else {
      gl.uniform2f(bedProgram.bedCentre, 0, 0);
      gl.uniform1f(bedProgram.bedExtent, 1);
    }

    // Transparent, and not writing depth, so the print always wins the test.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);

    gl.bindBuffer(gl.ARRAY_BUFFER, bedBuffer);
    gl.enableVertexAttribArray(bedProgram.position);
    gl.vertexAttribPointer(bedProgram.position, 3, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, bedTriangles * 3);

    gl.depthMask(true);
    gl.disable(gl.BLEND);
  };



  /* ------------------------------------------------------------- gestures -- */

  let dragging = null;

  const onPointerDown = (event) => {
    // OrcaSlicer's pairing: the primary button orbits, the right button (and the
    // middle one, and the primary with Shift) slides the scene. Right-drag is
    // the one most hands reach for, so it leads the comment.
    const wantsPan = event.button === 2 || event.button === 1 || event.shiftKey;
    if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
    event.preventDefault();
    dragging = { x: event.clientX, y: event.clientY, pan: wantsPan, button: event.button };
    canvas.setPointerCapture?.(event.pointerId);
    canvas.style.cursor = wantsPan ? 'move' : 'grabbing';
  };

  /**
   * Keep the browser's own menu off the canvas.
   *
   * A right-drag pans, so the menu that a right-click would otherwise open on
   * release would appear in the middle of the gesture and steal the pointer.
   */
  const onContextMenu = (event) => {
    event.preventDefault();
  };

  const onPointerMove = (event) => {
    if (dragging === null) return;
    const deltaX = event.clientX - dragging.x;
    const deltaY = event.clientY - dragging.y;
    dragging = { x: event.clientX, y: event.clientY, pan: dragging.pan };

    if (dragging.pan) {
      // A drag of one pixel covers this much of the viewport at the current
      // distance, so the scene follows the pointer at every zoom level.
      const viewHeight = 2 * Math.tan(FIELD_OF_VIEW / 2) * BASE_DISTANCE * zoom;
      const perPixel = viewHeight / Math.max(1, canvas.clientHeight);
      // The camera's screen-right and screen-up axes for this orbit.
      const right = [-Math.sin(yaw), Math.cos(yaw), 0];
      const up = [
        -Math.sin(pitch) * Math.cos(yaw),
        -Math.sin(pitch) * Math.sin(yaw),
        Math.cos(pitch),
      ];
      // Screen Y grows downwards while the camera's up axis grows upwards, so
      // the vertical delta is negated here; without it the scene slides against
      // the pointer.
      const dx = deltaX * perPixel;
      const dy = -deltaY * perPixel;
      pan = [
        pan[0] - dx * right[0] - dy * up[0],
        pan[1] - dx * right[1] - dy * up[1],
        pan[2] - dx * right[2] - dy * up[2],
      ];
    } else {
      yaw -= deltaX * 0.008;
      // Stop just shy of the poles so the up vector never degenerates.
      pitch = Math.max(-Math.PI / 2 + 0.02, Math.min(Math.PI / 2 - 0.02, pitch + deltaY * 0.008));
      // The cube reads the same orbit, so it turns while the pointer drags.
      notifyOrbit();
    }
    // Coalesced, not immediate: a drag reports moves faster than frames.
    requestDraw();
  };

  /**
   * End the current gesture.
   *
   * Three things can end a drag on a Mac trackpad, and only the first is a
   * plain release:
   *
   *   - `pointerup` for the button that started it;
   *   - `pointercancel`, when the system takes the gesture over (a three-finger
   *     swipe, a Mission Control gesture) — its `button` is often −1;
   *   - `lostpointercapture`, when the element stops being the capture target
   *     without a release reaching it at all.
   *
   * Missing the last two left `dragging` set, so the next pointer move kept
   * orbiting with no button held — the view span on its own until a click
   * landed. `button` is only compared when the release actually names one that
   * matches a real button, so a cancel still ends the gesture.
   */
  const endDrag = (event) => {
    if (dragging === null) return;
    const released = event.button;
    const isRealButton = typeof released === 'number' && released >= 0;
    if (isRealButton && released !== dragging.button) return;
    dragging = null;
    if (event.pointerId !== undefined) canvas.releasePointerCapture?.(event.pointerId);
    canvas.style.cursor = 'grab';
  };

  /** End the gesture when the pointer leaves without a release. */
  const onPointerCancel = (event) => endDrag(event);

  /** End the gesture when this element stops being the capture target. */
  const onLostCapture = () => {
    if (dragging === null) return;
    dragging = null;
    canvas.style.cursor = 'grab';
  };

  const onWheel = (event) => {
    event.preventDefault();
    // Zoom runs from 50x closer than the framing distance to 6x farther, which
    // is deep enough to read the wall of a single 0.2 mm layer.
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * Math.exp(event.deltaY * 0.0015)));
    draw();
  };

  /** Return the camera to the framing set when the mesh was uploaded. */
  const reset = () => {
    yaw = -0.65;
    pitch = 0.42;
    zoom = 1;
    pan = [0, 0, 0];
    notifyOrbit();
    draw();
  };

  /** Whether the current mesh draws with the project's own colours. */
  const usesColours = () => hasColours;

  /**
   * Set which layers the sliced plate shows.
   *
   * The range is inclusive and clamps to the plate's own layer count. `dim`
   * keeps the layers below the range drawn but darkened, which is how a layer
   * reads as sitting on the print rather than floating in space.
   *
   * @param from - first visible layer, zero-based.
   * @param to - last visible layer, inclusive.
   * @param options - `dim` to darken rather than hide what lies below.
   */
  const setLayerRange = (from, to, options = {}) => {
    if (layerCount === 0) return;
    const low = Math.max(0, Math.min(layerCount - 1, Math.round(from)));
    const high = Math.max(low, Math.min(layerCount - 1, Math.round(to)));
    layerRange = [low, high];
    dimBelow = options.dim === true;
    draw();
  };

  /**
   * Show or hide the printer's bed.
   *
   * A file that states no bed outline has nothing to show, so the call reports
   * whether the bed can be drawn at all and the toolbar can disable its button
   * instead of offering a switch that does nothing.
   *
   * @param visible - whether the bed should be drawn.
   * @returns whether a bed is available in the current file.
   */
  const setBedVisible = (visible) => {
    const available = bedTriangles > 0;
    bedVisible = available && visible === true;
    draw();
    return available;
  };

  /**
   * Point the camera at a named view, as the navigation cube's faces do.
   *
   * The names match the cube's faces rather than the axes: a 3D-printing file
   * is authored Z-up, so "top" looks down the Z axis and "front" looks along −Y.
   *
   * @param view - one of front, back, left, right, top, bottom.
   */
  const setView = (view) => {
    // The camera sits at `eye` and looks back at the origin, so a named view is
    // the orbit that puts the eye on the opposite side of the direction it names.
    const half = Math.PI / 2;
    const views = {
      // Looking down +Z at the build plate: the eye sits above it.
      top: [-half, half - 0.02],
      bottom: [-half, -half + 0.02],
      // A 3D-printing file is authored Y-front: the eye sits at −Y to look +Y.
      front: [-half, 0],
      back: [half, 0],
      left: [Math.PI, 0],
      right: [0, 0],
    };
    const angles = views[view];
    if (angles === undefined) return;
    yaw = angles[0];
    pitch = angles[1];
    notifyOrbit();
    draw();
  };

  
  
  
  /**
   * Set the camera's orbit outright.
   *
   * A drag on the navigation cube turns the cube, and the plate has to follow:
   * the cube is the camera, so this is what makes dragging it turn the model.
   *
   * @param nextYaw - rotation about the vertical axis, in radians.
   * @param nextPitch - elevation, in radians; clamped shy of the poles.
   */
  const setOrbit = (nextYaw, nextPitch) => {
    if (!Number.isFinite(nextYaw) || !Number.isFinite(nextPitch)) return;
    yaw = nextYaw;
    pitch = Math.max(-Math.PI / 2 + 0.02, Math.min(Math.PI / 2 - 0.02, nextPitch));
    notifyOrbit();
    draw();
  };


  /**
   * Pack the per-filament surface into the shader's uniform arrays.
   *
   * Six slots in two `vec3`s each, because a dynamically indexed array of floats
   * is not supported everywhere and a `vec3` array indexed by a computed slot is
   * no better. The shader unpacks with comparisons; this only lays the numbers
   * out in that order.
   */
  const uploadSurfaces = (target) => {
    const pack = (pick) => {
      const values = [];
      for (let index = 0; index < 6; index += 1) {
        const entry = surfaces[index] ?? DEFAULT_SURFACE;
        values.push(pick(entry));
      }
      return values;
    };
    const matte = pack((entry) => entry.matte);
    const metal = pack((entry) => entry.metalness);
    const alpha = pack((entry) => entry.transparency);

    if (target.surfaceMatte !== undefined && target.surfaceMatte !== null) {
      gl.uniform3f(target.surfaceMatte, matte[0], matte[1], matte[2]);
      gl.uniform3f(target.surfaceMatte2, matte[3], matte[4], matte[5]);
    }
    if (target.surfaceMetal !== undefined && target.surfaceMetal !== null) {
      gl.uniform3f(target.surfaceMetal, metal[0], metal[1], metal[2]);
      gl.uniform3f(target.surfaceMetal2, metal[3], metal[4], metal[5]);
    }
    if (target.surfaceAlpha !== undefined && target.surfaceAlpha !== null) {
      gl.uniform3f(target.surfaceAlpha, alpha[0], alpha[1], alpha[2]);
      gl.uniform3f(target.surfaceAlpha2, alpha[3], alpha[4], alpha[5]);
    }
    if (target.lightLevel !== undefined && target.lightLevel !== null) {
      gl.uniform1f(target.lightLevel, lightLevel);
    }
    // The model path has no slots: it takes the first filament's material, which
    // is the one its single colour corresponds to.
    if (target.roughness !== undefined && target.roughness !== null) {
      gl.uniform1f(target.roughness, matte[0]);
      gl.uniform1f(target.metalness, metal[0]);
      gl.uniform1f(target.transparency, alpha[0]);
    }
  };

  /**
   * Render the current view to an image at a chosen size.
   *
   * The ordinary canvas is sized to its box on screen, which is the right size to
   * look at and the wrong size to keep: an export needs more pixels than the
   * sidebar has, and it should not be limited by the display's device pixel ratio
   * either. So the same scene is drawn again with the backing store enlarged,
   * read back, and the canvas restored.
   *
   * Supersampling is the antialiasing here rather than the context's MSAA, because
   * MSAA is requested at context creation and cannot be raised afterwards. Drawing
   * at `size` and letting the browser's own downsample do the work is what makes
   * the edges settle.
   *
   * @param options - `width` in pixels (height follows the canvas's aspect, so the
   *   picture matches what is on screen), and `background` to override the scene's
   *   own for this image only -- a transparent PNG is rarely what a product shot
   *   wants, so an opaque colour is the useful default.
   * @returns a `data:` URL, or null if the canvas could not be read.
   */
  const renderToImage = ({ width = 2048, background: override } = {}) => {
    if (disposed) return null;
    const targetWidth = Math.max(256, Math.min(8192, Math.round(width)));
    // The same aspect as the on-screen canvas, so the export matches the framing
    // the user has been looking at.
    const aspect = canvas.clientHeight > 0 ? canvas.clientWidth / canvas.clientHeight : 1;
    const targetHeight = Math.max(1, Math.round(targetWidth / Math.max(aspect, 0.01)));

    const previousWidth = canvas.width;
    const previousHeight = canvas.height;

    // A transparent scene becomes an opaque one for the image: a PNG with nothing
    // behind the print is not useful in a document, and alpha is the scene's
    // business while it is on screen.
    const previousBackground = background;
    if (override !== undefined) {
      // Through `parseColour`, not assigned raw: this is where the string used to
      // leak into the renderer and turn every export's backdrop green.
      const parsed = parseColour(override);
      if (parsed !== undefined) background = parsed;
    }

    let url = null;
    renderingExport = true;
    try {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      draw();
      url = canvas.toDataURL('image/png');
    } catch (error) {
      url = null;
    } finally {
      // Restore both the size and the scene, then repaint: the canvas is the one
      // that is on screen and must not be left at export size.
      renderingExport = false;
      canvas.width = previousWidth;
      canvas.height = previousHeight;
      background = previousBackground;
      draw();
    }
    return url;
  };

  /**
   * Set one filament's surface.
   *
   * Each slot has its own matte, metalness and transparency: a plate can have a
   * glossy black body and a matte white label in the same file, and the studio
   * lighting is judged per filament rather than for the plate as a whole.
   *
   * @param slot - palette slot to change.
   * @param next - any of `matte` (0.04..1), `metalness` (0..1), `transparency`
   *   (0..1); omitted keys are left alone.
   */
  const setSurface = (slot, next) => {
    if (!Number.isInteger(slot) || slot < 0 || slot > 7) return;
    const current = surfaces[slot] ?? DEFAULT_SURFACE;
    const merged = { ...current };
    if (next.matte !== undefined) merged.matte = Math.min(1, Math.max(0.04, next.matte));
    if (next.metalness !== undefined) merged.metalness = Math.min(1, Math.max(0, next.metalness));
    if (next.transparency !== undefined) merged.transparency = Math.min(1, Math.max(0, next.transparency));
    const copy = surfaces.slice();
    copy[slot] = merged;
    surfaces = copy;
    draw();
  };

  /**
   * Set the studio's overall level.
   *
   * One number for the whole scene, separate from the per-filament surface: this
   * is how bright the light is, not how a filament responds to it.
   *
   * @param level - 0..2, where 1 is the studio as designed.
   */
  const setLightLevel = (level) => {
    lightLevel = Math.min(2, Math.max(0.1, level));
    draw();
  };

  /** The surface character in use, by slot. */
  const surfaceInfo = () => ({
    surfaces: surfaces.map((entry) => ({ ...entry })),
    lightLevel,
  });

  /**
   * Replace the filament palette.
   *
   * Colours arrive as `#rrggbb` strings in sRGB, the way a slicer states them, and
   * are converted here because the shader lights in linear space. Only the
   * uniform changes: the strokes store which slot they belong to, so recolouring
   * a plate costs one upload rather than a rebuild of every instance.
   *
   * @param palette - hex strings in slot order; at most eight are used.
   */
  const setPalette = (palette) => {
    if (!Array.isArray(palette) || palette.length === 0) return;
    const next = new Float32Array(24);
    const count = Math.min(palette.length, 8);
    for (let index = 0; index < count; index += 1) {
      const [r, g, b] = hexToRgb(palette[index]);
      next[index * 3] = r;
      next[index * 3 + 1] = g;
      next[index * 3 + 2] = b;
    }
    paletteLinear = next;
    paletteSlots = count;
    draw();
  };

  /** The palette currently in use, as hex strings. */
  const paletteInfo = () => {
    const hex = (channel) => Math.round(Math.min(1, Math.max(0, channel)) * 255)
      .toString(16).padStart(2, '0');
    const out = [];
    for (let index = 0; index < paletteSlots; index += 1) {
      // Back to sRGB, so the value round-trips through the picker unchanged.
      const toSrgb = (channel) => (channel <= 0.0031308
        ? channel * 12.92
        : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055);
      out.push(`#${hex(toSrgb(paletteLinear[index * 3]))}${hex(toSrgb(paletteLinear[index * 3 + 1]))}${hex(toSrgb(paletteLinear[index * 3 + 2]))}`);
    }
    return out;
  };

  /**
   * Switch between the studio material and a plain shaded view.
   *
   * Plain is the slicer's default preview: one soft light and a floor, no
   * highlight and no reflection. It reads a shape and a colour faster than the
   * material does, which is what a plate is usually being checked for, so the
   * material is the one that should be asked for rather than assumed.
   *
   * @param plain - true for plain shading, false for the studio material.
   */
  const setPlainLighting = (plain) => {
    plainLighting = plain === true;
    draw();
  };

  /** Whether the scene is drawn with plain shading. */
  const plainLightingInfo = () => plainLighting;

  /**
   * Set the scene's background colour.
   *
   * @param colour - `#rrggbb`, or null for the transparent default that lets the
   *   sidebar's own surface show through.
   */
  /**
   * A scene colour as unit RGB, or `null` when there is nothing behind the model.
   *
   * Accepts the two forms a caller actually has: a `#rrggbb` string, which is what
   * a colour input and the settings store carry, and an `[r, g, b]` triple, which
   * is what the renderer wants. Returning `null` for anything else is deliberate:
   * a caller that passes an unparseable colour should get the previous background
   * rather than a silently wrong one.
   *
   * @param colour - `null`, a hex string, or three channel values.
   * @returns `[r, g, b]` in 0..1, or `null` for no background.
   */
  const parseColour = (colour) => {
    if (colour === null || colour === undefined) return null;
    if (Array.isArray(colour) && colour.length >= 3) {
      const channels = colour.slice(0, 3).map((v) => Number(v));
      if (channels.every((v) => Number.isFinite(v))) {
        return channels.map((v) => Math.min(1, Math.max(0, v)));
      }
      return undefined;
    }
    const match = /^#?([0-9a-f]{6})$/i.exec(String(colour));
    if (match === null) return undefined;
    const value = match[1];
    return [
      parseInt(value.slice(0, 2), 16) / 255,
      parseInt(value.slice(2, 4), 16) / 255,
      parseInt(value.slice(4, 6), 16) / 255,
    ];
  };

  const setBackground = (colour) => {
    const parsed = parseColour(colour);
    // `undefined` means "not a colour": leave the current background alone. This
    // is the difference between a rejected value and the absence of a background,
    // and conflating them would clear the scene on a typo.
    if (parsed === undefined) return;
    background = parsed;
    draw();
  };

  /** The current background colour, or null for transparent. */
  const backgroundInfo = () => (background === null
    ? null
    : `#${background.map((channel) => Math.round(channel * 255).toString(16).padStart(2, '0')).join('')}`);

  /** The camera's current orbit, in radians, so a cube can turn to match. */
  const orientation = () => ({ yaw, pitch });

  /**
   * Everything needed to reproduce this frame elsewhere.
   *
   * The path tracer renders the same scene, so it must not re-derive the camera,
   * the palette or the surface parameters: a second implementation of the framing
   * would drift from this one and a traced image would not line up with the view
   * the user was looking at. Copied out rather than handed by reference, because a
   * caller may hold it while the panel changes underneath.
   */
  const sceneState = () => {
    const distance = BASE_DISTANCE * zoom;
    const cosPitch = Math.cos(pitch);
    return {
      eye: [
        cosPitch * Math.cos(yaw) * distance + pan[0],
        cosPitch * Math.sin(yaw) * distance + pan[1],
        Math.sin(pitch) * distance + pan[2],
      ],
      target: [pan[0], pan[1], pan[2]],
      up: [0, 0, 1],
      tanHalfFov: Math.tan(FIELD_OF_VIEW / 2),
      palette: (() => {
        const out = new Float32Array(24);
        for (let index = 0; index < Math.min(paletteSlots, 8); index += 1) {
          out[index * 3] = paletteLinear[index * 3];
          out[index * 3 + 1] = paletteLinear[index * 3 + 1];
          out[index * 3 + 2] = paletteLinear[index * 3 + 2];
        }
        return out;
      })(),
      surfaces: (() => {
        // (matte, metalness, transparency, unused) per slot, flattened for a vec4
        // array: the shader indexes one vec4 per filament.
        const out = new Float32Array(32);
        for (let index = 0; index < 8; index += 1) {
          const entry = surfaces[index] ?? DEFAULT_SURFACE;
          out[index * 4] = Math.max(0.04, Math.min(1, entry.matte));
          out[index * 4 + 1] = Math.max(0, Math.min(1, entry.metalness ?? 0));
          out[index * 4 + 2] = Math.max(0, Math.min(1, entry.transparency ?? 0));
          out[index * 4 + 3] = 0;
        }
        return out;
      })(),
      paletteCount: Math.min(paletteSlots, 8),
      lightLevel,
      plainLighting,
      background: background === null ? null : [background[0], background[1], background[2]],
      // The mesh the tracer should build its tree from, and the normalisation it
      // must apply -- the raw mesh, not the already-normalised buffers.
      mesh: currentMesh,
      meshScale,
      meshCenter,
    };
  };

  /** Tell every listener where the camera now points. */
  const notifyOrbit = () => {
    if (orbitListeners.size === 0) return;
    const angles = { yaw, pitch };
    // Copied first: a listener that unsubscribes while being notified would
    // otherwise mutate the set mid-iteration.
    for (const listener of [...orbitListeners]) listener(angles);
  };

  /**
   * Follow the camera's orbit.
   *
   * Any number of callers may watch: the navigation cube and the per-file
   * settings both do, and neither should be able to displace the other.
   *
   * @param callback - called with `{ yaw, pitch }` whenever the orbit changes.
   * @returns an unsubscribe function.
   */
  const watchOrbit = (callback) => {
    orbitListeners.add(callback);
    return () => {
      orbitListeners.delete(callback);
    };
  };

  /** Whether the current file carries a bed outline. */
  const bedInfo = () => ({
    available: bedTriangles > 0,
    visible: bedVisible,
    bounds: bedBounds === null ? null : bedBounds,
  });

  /** How many layers the current plate has, or 0 for a model. */
  const layerInfo = () => ({ count: layerCount, range: [layerRange[0], layerRange[1]], dim: dimBelow });

  /** Switch between shaded and wireframe drawing. */
  const setMode = (next) => {
    mode = next;
    draw();
  };

  const onResize = () => draw();
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null;
  resizeObserver?.observe(canvas);
  globalThis.addEventListener?.('resize', onResize);

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('contextmenu', onContextMenu);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('lostpointercapture', onLostCapture);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.style.cursor = 'grab';

  /**
   * Release everything this viewer owns.
   *
   * The WebGL context is deliberately *kept*: a canvas hands out exactly one
   * context for its lifetime, so destroying it would leave the element unable to
   * create shaders ever again. Switching views reuses the same canvas, so the
   * buffers and program are deleted and the context stays usable.
   */
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    resizeObserver?.disconnect();
    globalThis.removeEventListener?.('resize', onResize);
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('contextmenu', onContextMenu);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', endDrag);
    canvas.removeEventListener('pointercancel', onPointerCancel);
    canvas.removeEventListener('lostpointercapture', onLostCapture);
    canvas.removeEventListener('wheel', onWheel);
    gl.deleteBuffer(positionBuffer);
    gl.deleteBuffer(normalBuffer);
    gl.deleteBuffer(colourBuffer);
    gl.deleteBuffer(edgeBuffer);
    gl.deleteBuffer(segmentBuffer);
    gl.deleteBuffer(segmentRingBuffer);
    gl.deleteBuffer(bedBuffer);
    gl.deleteBuffer(segmentIndexBuffer);
    gl.deleteProgram(program.program);
    gl.deleteProgram(segmentProgram.program);
    gl.deleteProgram(bedProgram.program);
  };

  return { setMesh, setMode, setLayerRange, layerInfo, setBedVisible, bedInfo, setView, setOrbit, orientation, sceneState, setBackground, backgroundInfo, setPlainLighting, plainLightingInfo, renderer: () => rendererInfo, setSurface, surfaceInfo, setLightLevel, renderToImage, setPalette, paletteInfo, watchOrbit, reset, dispose, redraw: draw, usesColours };
}
