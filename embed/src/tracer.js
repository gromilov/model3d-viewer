/**
 * A progressive path tracer for the same scene the rasteriser draws.
 *
 * The rasteriser shades a surface by asking "what light reaches this point from
 * these four directions" -- a good approximation, and the reason a soft shadow,
 * an ambient contact darkening or a reflection of the model in itself are all
 * absent from it. Tracing asks "what does this pixel actually see", so those
 * three fall out of the sampling rather than being faked: a shadow is a ray that
 * hits something, contact darkening is a ray that hits something nearby, and a
 * reflection is a ray that bounces.
 *
 * Deliberately not a general renderer:
 *
 *   - two bounces. Every extra bounce multiplies the ray count, and on this GPU
 *     the difference between one and two bounces is a visible reflection in the
 *     plastic and one between four and six is a slightly warmer crevice.
 *   - one sample per pass, accumulated. The camera is frozen while tracing, so the
 *     image converges in place instead of being re-traced from scratch, which is
 *     what makes a soft shadow affordable: it is the average of many hard ones.
 *   - analytic capsules for strokes. A sliced plate is 154 000 round tubes, and
 *     tracing them as tubes rather than as expanded triangles keeps the BVH small
 *     enough to build on open.
 *
 * The studio lighting is shared with the rasteriser on purpose. A traced image
 * that lights differently reads as a different material, and the point of the
 * button is to show the same part more truthfully, not a different part.
 */

/**
 * The tracer's shaders, as one pair.
 *
 * Written against `bvh-layout.md`: two float textures, a two-texel node and a
 * three-texel primitive. The traversal is an explicit stack loop rather than
 * recursion, because GLSL ES 3.00 has no recursion at all.
 */
const TRACE_VERTEX_SHADER = `#version 300 es
// A full-screen triangle: three vertices, no attributes, no buffers. Cheaper than
// a quad and avoids a stray diagonal seam.
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`;

const TRACE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

out vec4 fragColour;

// The geometry pass shares this shader: it traces the primary ray and stops, so
// the denoiser gets an unblended normal and distance without a second copy of the
// traversal. It runs once per presented frame, not once per sample.
uniform bool uGeometryOnly;

uniform sampler2D uNodes;
uniform sampler2D uPrims;
uniform ivec2 uNodeSize;
uniform ivec2 uPrimSize;

uniform vec3 uEye;
uniform vec3 uTarget;
uniform vec3 uUp;
uniform float uTanHalfFov;
uniform vec2 uResolution;

uniform vec3 uPalette[8];
uniform vec4 uSurface[8];      // matte, metalness, transparency, unused
uniform int uPaletteCount;
uniform float uLightLevel;
uniform int uPlainLighting;

// One sample per pass. The accumulation buffer adds each pass; the presentation
// pass divides by this count, so the shader itself always traces exactly one.
uniform float uFrameSeed;
uniform int uMaxBounces;
// The studio sources are large: the angular radius of a softbox as seen from the
// part, in the same normalised units as the scene. Bigger gives softer, noisier
// shadows that need more samples to settle.
uniform float uLightRadius;

// ---------------------------------------------------------------- lighting --
// The same studio the rasteriser uses, so a traced frame is the same material
// seen more truthfully rather than a different look.
vec3 studioReflection(vec3 direction, float roughness) {
  float up = clamp(direction.z * 0.5 + 0.5, 0.0, 1.0);
  vec3 sky = mix(vec3(0.011, 0.011, 0.012), vec3(0.078, 0.078, 0.082), up);

  vec3 keyDir = normalize(vec3(-0.42, -0.55, 0.72));
  float warm = max(dot(direction, keyDir), 0.0);
  float vertical = abs(dot(direction, vec3(0.0, 0.0, 1.0)));
  float warmTight = mix(38.0, 2.5, roughness);
  sky += vec3(1.0, 0.985, 0.96) * pow(warm, warmTight) * mix(1.4, 1.0, vertical) * 3.6;

  vec3 fillDir = normalize(vec3(0.62, 0.48, 0.30));
  float cool = max(dot(direction, fillDir), 0.0);
  sky += vec3(0.62, 0.74, 1.0) * pow(cool, mix(26.0, 2.0, roughness)) * 1.5;

  vec3 stripDir = normalize(vec3(0.85, -0.30, 0.15));
  float strip = max(dot(direction, stripDir), 0.0);
  sky += vec3(0.95, 0.98, 1.0) * smoothstep(0.72, 0.99, strip) * mix(1.0, 0.6, roughness) * 0.9;
  return sky;
}

vec3 studioAmbient(vec3 normal) {
  float up = clamp(normal.z * 0.5 + 0.5, 0.0, 1.0);
  vec3 floorTint = vec3(0.030, 0.030, 0.033);
  vec3 midTint = vec3(0.115, 0.116, 0.122);
  vec3 ceilTint = vec3(0.155, 0.157, 0.164);
  return up < 0.5
    ? mix(floorTint, midTint, up * 2.0)
    : mix(midTint, ceilTint, (up - 0.5) * 2.0);
}

vec3 studioShape(vec3 normal) {
  float up = clamp(normal.z * 0.5 + 0.5, 0.0, 1.0);
  return vec3(0.052, 0.052, 0.055) * (0.35 + 0.65 * up);
}

// ------------------------------------------------------------- accumulate --
vec3 aces(vec3 x) {
  const float a = 2.51; const float b = 0.03; const float c = 2.43;
  const float d = 0.59; const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

// ------------------------------------------------------------------- BVH ---
// Texel fetches by linear index; texelFetch needs integer coordinates.
vec4 nodeTexel(int index) {
  return texelFetch(uNodes, ivec2(index % uNodeSize.x, index / uNodeSize.x), 0);
}
vec4 primTexel(int index) {
  return texelFetch(uPrims, ivec2(index % uPrimSize.x, index / uPrimSize.x), 0);
}

// Slab test. Tan and Tfar travel by reference; a miss returns false and leaves
// them alone, so the caller's nearest-so-far is not clobbered.
bool slabTest(vec3 boxMin, vec3 boxMax, vec3 origin, vec3 inverseDirection, float currentFar, out float near) {
  vec3 t0 = (boxMin - origin) * inverseDirection;
  vec3 t1 = (boxMax - origin) * inverseDirection;
  vec3 smaller = min(t0, t1);
  vec3 larger = max(t0, t1);
  near = max(max(smaller.x, smaller.y), max(smaller.z, 0.0));
  float far = min(min(larger.x, larger.y), min(larger.z, currentFar));
  return far >= near;
}

// A capsule: the segment a-b swept by a sphere of the given radius. This is the
// form Inigo Quilez derives; the degenerate cases (ray parallel to the axis, a
// zero-length segment) are handled explicitly because they are what produce
// black speckles along a stroke when left alone.
bool hitCapsule(vec3 origin, vec3 direction, vec3 a, vec3 b, float radius, float maxDistance, out float distance, out vec3 normal) {
  vec3 ba = b - a;
  vec3 oa = origin - a;
  float baba = dot(ba, ba);
  float bard = dot(ba, direction);
  float baoa = dot(ba, oa);
  float rdoa = dot(direction, oa);
  float oaoa = dot(oa, oa);

  // A zero-length segment is a sphere, and the quadratic below divides by zero.
  if (baba < 1e-12) {
    float b = rdoa;
    float c = oaoa - radius * radius;
    float disc = b * b - c;
    if (disc < 0.0) return false;
    float t = -b - sqrt(disc);
    if (t < 0.0 || t > maxDistance) return false;
    distance = t;
    normal = normalize(origin + direction * t - a);
    return true;
  }

  float a2 = baba - bard * bard;
  float b2 = baba * rdoa - baoa * bard;
  float c2 = baba * oaoa - baoa * baoa - radius * radius * baba;

  // a2 is the denominator of the closest-approach parameter. When it is ~0 the
  // ray runs along the capsule's axis and the cylinder provides no root; only the
  // caps can be hit, which the sphere tests below cover.
  if (abs(a2) > 1e-9) {
    float h = b2 * b2 - a2 * c2;
    if (h >= 0.0) {
      float t = (-b2 - sqrt(h)) / a2;
      float y = baoa + t * bard;
      // Inside the cylinder's length: the hit is on the side wall.
      if (y > 0.0 && y < baba && t > 0.0 && t < maxDistance) {
        distance = t;
        normal = normalize((oa + direction * t) - (ba * (y / baba)));
        return true;
      }
      // Beyond an end: test the two caps as spheres and keep the nearer hit.
      vec3 oc = (y <= 0.0) ? oa : origin - b;
      float b3 = dot(direction, oc);
      float c3 = dot(oc, oc) - radius * radius;
      float h3 = b3 * b3 - c3;
      if (h3 > 0.0) {
        float t2 = -b3 - sqrt(h3);
        if (t2 > 0.0 && t2 < maxDistance) {
          distance = t2;
          normal = normalize(origin + direction * t2 - ((y <= 0.0) ? a : b));
          return true;
        }
      }
    }
    return false;
  }

  // Parallel to the axis: both caps, nearest first.
  vec3 ocA = oa;
  vec3 ocB = origin - b;
  float bA = dot(direction, ocA);
  float cA = dot(ocA, ocA) - radius * radius;
  float hA = bA * bA - cA;
  float best = -1.0;
  if (hA > 0.0) {
    float t = -bA - sqrt(hA);
    if (t > 0.0 && t < maxDistance) best = t;
  }
  float bB = dot(direction, ocB);
  float cB = dot(ocB, ocB) - radius * radius;
  float hB = bB * bB - cB;
  if (hB > 0.0) {
    float t = -bB - sqrt(hB);
    if (t > 0.0 && t < maxDistance && (best < 0.0 || t < best)) best = t;
  }
  if (best < 0.0) return false;
  distance = best;
  vec3 point = origin + direction * best;
  // Which cap was hit decides the normal's origin.
  bool nearerA = dot(point - a, ba) < dot(point - b, ba);
  normal = normalize(point - (nearerA ? a : b));
  return true;
}

// Moller-Trumbore, two-sided: a sliced plate is flat ribbons and a model can be
// open, so culling by facing would punch holes in it.
bool hitTriangle(vec3 origin, vec3 direction, vec3 v0, vec3 v1, vec3 v2, float maxDistance, out float distance, out vec3 normal) {
  vec3 edge1 = v1 - v0;
  vec3 edge2 = v2 - v0;
  vec3 p = cross(direction, edge2);
  float determinant = dot(edge1, p);
  if (abs(determinant) < 1e-12) return false;
  float inverse = 1.0 / determinant;
  vec3 toOrigin = origin - v0;
  float u = dot(toOrigin, p) * inverse;
  if (u < 0.0 || u > 1.0) return false;
  vec3 q = cross(toOrigin, edge1);
  float v = dot(direction, q) * inverse;
  if (v < 0.0 || u + v > 1.0) return false;
  float t = dot(edge2, q) * inverse;
  if (t <= 1e-5 || t >= maxDistance) return false;
  distance = t;
  normal = normalize(cross(edge1, edge2));
  return true;
}

struct Hit {
  float distance;
  vec3 normal;
  vec3 base;
  float roughness;
  float metalness;
  bool hit;
};

// The traversal itself. An explicit stack, because GLSL has no recursion.
//
// The stack is walked in push order and both children are pushed when a node is
// entered; testing the nearer child first would need the nodes' distances kept
// alongside, which costs more than it saves at this tree depth.
Hit traceScene(vec3 origin, vec3 direction, float maxDistance, bool anyHit) {
  Hit result;
  result.distance = maxDistance;
  result.normal = vec3(0.0, 0.0, 1.0);
  result.base = vec3(0.0);
  result.roughness = 0.6;
  result.metalness = 0.0;
  result.hit = false;

  int stack[32];
  int stackSize = 0;
  stack[stackSize++] = 0;
  vec3 inverseDirection = 1.0 / direction;

  int guard = 0;
  while (stackSize > 0) {
    int node = stack[--stackSize];
    // A bounded loop: a malformed tree must not hang the GPU, which on a web page
    // means a frozen tab rather than an error.
    if (guard++ > 4096) break;

    vec4 boxMin = nodeTexel(node * 2);
    vec4 boxMax = nodeTexel(node * 2 + 1);
    float boxNear;
    if (!slabTest(boxMin.xyz, boxMax.xyz, origin, inverseDirection, result.distance, boxNear)) continue;

    int first = int(boxMin.w + 0.5);
    int count = int(boxMax.w + 0.5);

    // A zero-primitive scene pads its single texel with zeros, which reads as an
    // internal node whose first child is itself. Skipping exactly that case keeps
    // the traversal from spinning on it without rejecting a legitimate node whose
    // child index happens to be numerically adjacent.
    if (count == 0 && first == node) continue;

    if (count > 0) {
      for (int i = 0; i < count; i++) {
        int prim = first + i;
        vec4 t0 = primTexel(prim * 3);
        vec4 t1 = primTexel(prim * 3 + 1);
        vec4 t2 = primTexel(prim * 3 + 2);
        int type = int(t0.w + 0.5);
        int slot = int(t2.w + 0.5);
        float distance;
        vec3 normal;
        bool hit = false;
        if (type == 1) {
          hit = hitCapsule(origin, direction, t0.xyz, t1.xyz, t1.w, result.distance, distance, normal);
        } else {
          hit = hitTriangle(origin, direction, t0.xyz, t1.xyz, t2.xyz, result.distance, distance, normal);
        }
        if (!hit) continue;
        if (anyHit) {
          result.hit = true;
          return result;
        }
        result.hit = true;
        result.distance = distance;
        result.normal = normal;
        int clamped = clamp(slot, 0, 7);
        result.base = uPalette[clamped];
        result.roughness = uSurface[clamped].x;
        result.metalness = uSurface[clamped].y;
      }
    } else {
      // Two children, contiguous: the second is the first's neighbour.
      if (stackSize + 2 < 32) {
        stack[stackSize++] = first;
        stack[stackSize++] = first + 1;
      }
    }
  }
  return result;
}

// Whether anything at all is between a point and the light. This is the whole
// shadow mechanism: one ray, no shading.
bool inShadow(vec3 position, vec3 lightDirection, float distanceToLight) {
  Hit blocker = traceScene(position + lightDirection * 0.002, lightDirection, distanceToLight, true);
  return blocker.hit;
}

// A cheap hash for the sample jitter. Deterministic in the pixel and the pass, so
// the sequence is reproducible and the accumulation is stable.
float hash(vec2 value) {
  return fract(sin(dot(value, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec2 pixel = gl_FragCoord.xy;
  vec2 uv = pixel / uResolution;

  // Jitter within the pixel, and rotate the sample pattern per pass so successive
  // passes cover the pixel instead of repeating the same point. Without this the
  // edges stay hard and the noise does not average away.
  float jitterX = hash(pixel + vec2(uFrameSeed * 11.0, 0.0)) - 0.5;
  float jitterY = hash(pixel + vec2(0.0, uFrameSeed * 17.0)) - 0.5;
  uv += vec2(jitterX, jitterY) / uResolution;

  vec3 forward = normalize(uTarget - uEye);
  vec3 right = normalize(cross(forward, uUp));
  vec3 up = cross(right, forward);
  float aspect = uResolution.x / uResolution.y;
  vec3 direction = normalize(
    forward
    + right * ((uv.x * 2.0 - 1.0) * uTanHalfFov * aspect)
    + up * ((uv.y * 2.0 - 1.0) * uTanHalfFov)
  );

  Hit primary = traceScene(uEye, direction, 1e6, false);

  if (uGeometryOnly) {
    // The normal encoded into 0..1 and the distance from the eye. Zero for a miss,
    // which the denoiser reads as "not a surface".
    fragColour = primary.hit
      ? vec4(normalize(primary.normal) * 0.5 + 0.5, primary.distance)
      : vec4(0.0);
    return;
  }

  if (!primary.hit) {
    // Nothing behind the model. The transparent default is kept, so the host's
    // surface shows through exactly as it does in the rasterised view.
    fragColour = vec4(0.0);
    return;
  }

  vec3 point = uEye + direction * primary.distance;
  vec3 normal = primary.normal;
  // Face the normal towards the camera: a plate is two-sided and its winding is
  // not a reliable statement about which side the light is on.
  if (dot(normal, direction) > 0.0) normal = -normal;

  vec3 toEye = -direction;
  vec3 colour;

  if (uPlainLighting > 0) {
    // The plain view has no shading terms to occlude, so a traced plain frame
    // differs only in its silhouette and its contact shadow. Kept in the same
    // form as the rasteriser so switching modes does not jump.
    vec3 keyDir = normalize(vec3(-0.42, -0.55, 0.72));
    float facing = clamp(dot(normal, keyDir), 0.0, 1.0);
    float up2 = clamp(normal.z * 0.5 + 0.5, 0.0, 1.0);
    float light = 0.30 + 0.70 * (facing * 0.65 + up2 * 0.35);
    float form = 0.045 * (facing * 0.6 + up2 * 0.4);
    colour = primary.base * light + vec3(form);
    // One shadow ray even here: a plain frame with a contact shadow is what makes
    // the traced image worth looking at on a sliced plate.
    vec3 keyDir2 = normalize(vec3(-0.42, -0.55, 0.72));
    if (inShadow(point, keyDir2, 1000.0)) colour *= 0.55;
  } else {
    float roughness = clamp(primary.roughness, 0.04, 1.0);
    colour = studioAmbient(normal) * primary.base + studioShape(normal);

    // Three sources, each shadowed. The rasteriser sums them unshadowed; the
    // difference between the two images is very largely this loop.
    vec3 keyDir = normalize(vec3(-0.42, -0.55, 0.72));
    vec3 fillDir = normalize(vec3(0.62, 0.48, 0.30));
    vec3 rimDir = normalize(vec3(0.85, -0.30, 0.15));

    vec3 lights[3];
    lights[0] = keyDir;
    lights[1] = fillDir;
    lights[2] = rimDir;
    vec3 lightColours[3];
    lightColours[0] = vec3(1.00, 0.99, 0.97) * 0.72;
    lightColours[1] = vec3(0.86, 0.92, 1.00) * 0.30;
    lightColours[2] = vec3(0.96, 0.98, 1.00) * 0.24;
    float wraps[3];
    wraps[0] = 0.55; wraps[1] = 0.40; wraps[2] = 0.70;
    float gains[3];
    gains[0] = 0.9; gains[1] = 0.0; gains[2] = 0.0;

    for (int i = 0; i < 3; i++) {
      vec3 lightDirection = lights[i];
      float nDotL = dot(normal, lightDirection);
      float wrapped = max((nDotL + wraps[i]) / (1.0 + wraps[i]), 0.0);
      if (wrapped <= 0.0) continue;
      // Shadowed, but with the light given an angular size: a point light casts a
      // hard edge, and a studio softbox does not. Jittering the direction inside a
      // small cone per pass means the accumulation averages many hard shadows into
      // a soft one, which is exactly what sampling buys over the rasteriser's
      // four fixed unshadowed directions.
      vec3 jittered = normalize(lightDirection + (vec3(
        hash(pixel + vec2(uFrameSeed * 3.0, 1.0)) - 0.5,
        hash(pixel + vec2(1.0, uFrameSeed * 5.0)) - 0.5,
        hash(pixel + vec2(uFrameSeed * 7.0, uFrameSeed * 2.0)) - 0.5
      )) * uLightRadius);
      float occlusion = inShadow(point, jittered, 1000.0) ? 0.0 : 1.0;
      // No 1/pi here: the rasteriser's own plastic lobe is not normalised either,
      // and matching it is what makes the two images read as the same surface
      // rather than one being a stop darker.
      colour += primary.base * lightColours[i] * wrapped * occlusion * 1.15;
    }

    // The studio, seen in the surface. Metal tints the reflection, a dielectric
    // does not; both gather at the silhouette through the fresnel.
    if (uMaxBounces > 0) {
      vec3 reflected = reflect(direction, normal);
      float fresnel = 0.10 + 0.90 * pow(1.0 - max(dot(normal, toEye), 0.0), 5.0);
      // A ray rather than a lookup: it finds the model in itself and the plate in
      // its own strokes, which is the visible difference from the rasteriser.
      Hit bounce = traceScene(point + normal * 0.002, reflected, 1e6, false);
      vec3 reflection;
      if (bounce.hit) {
        // What the reflected surface itself shows. A flat ambient term here would
        // make the second surface read as a cut-out; a shadowed light makes it read
        // as a lit part seen in another.
        vec3 bounceToEye = -reflected;
        reflection = studioAmbient(bounce.normal) * bounce.base + studioShape(bounce.normal);
        float nDotL = max(dot(bounce.normal, keyDir), 0.0);
        if (nDotL > 0.0) {
          // One shadow ray from the bounce point: this is what puts a shadow
          // *inside* the reflection, which is the difference between one bounce
          // and two that is actually visible.
          vec3 lightDirection = normalize(vec3(-0.42, -0.55, 0.72));
          float occluded = inShadow(point + reflected * bounce.distance, lightDirection, 1000.0) ? 0.0 : 1.0;
          reflection += bounce.base * vec3(1.00, 0.99, 0.97) * 0.72 * nDotL * occluded * 1.15;
        }
        // And a faint specular so a plastic reflection is not matte.
        float specular = pow(max(dot(bounce.normal, normalize(bounceToEye + keyDir)), 0.0), 24.0);
        reflection += vec3(1.0) * specular * 0.20;
      } else {
        reflection = studioReflection(reflected, roughness);
      }
      colour += reflection * fresnel * mix(0.35, 3.2, primary.metalness) * 0.35;
    }

    // Ambient occlusion: how much of the sky this point can see. A crevice between
    // two layers, or the gap under a plate, is a place where most of the hemisphere
    // is blocked, and the rasteriser has no way to know that -- it shades every
    // surface by its normal alone, so a crevice is as bright as a plateau.
    float ao = 0.0;
    vec3 tangent = normalize(abs(normal.z) < 0.9 ? cross(normal, vec3(0.0, 0.0, 1.0)) : cross(normal, vec3(1.0, 0.0, 0.0)));
    vec3 bitangent = cross(normal, tangent);
    for (int a = 0; a < 4; a++) {
      // A fixed spiral of four directions, rotated per pass by the frame seed, so
      // the four rays cover the hemisphere over the accumulation.
      float angle = (float(a) / 4.0) * 6.28318 + uFrameSeed * 1.618;
      vec3 directionAround = tangent * cos(angle) + bitangent * sin(angle);
      vec3 sampleDirection = normalize(normal + directionAround * 0.9);
      if (!inShadow(point, sampleDirection, 1000.0)) ao += 1.0;
    }
    ao *= 0.25;
    colour *= mix(1.0, ao, 0.55);

    // A shadowed crevice darkens by what the studio cannot reach there, which is
    // what makes stacked layers read as stacked.
    float edge = 1.0 - max(dot(normal, toEye), 0.0);
    colour += vec3(0.30, 0.44, 0.50) * pow(edge, 3.0) * 0.30;
  }

  colour *= uLightLevel;
  fragColour = vec4(aces(colour), 1.0);
}
`;

/**
 * Presented pixels: the accumulated sum divided by the sample count.
 *
 * A separate pass rather than doing it in the tracer, because the division must
 * happen on the sum of *all* passes, and the tracer only knows its own sample.
 */
const RESOLVE_VERTEX_SHADER = `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`;

/**
 * The denoiser.
 *
 * A path tracer's noise is not random: it is the variance of a handful of samples
 * per pixel, and neighbouring pixels see almost the same geometry. Blurring
 * across that neighbourhood removes most of the grain without touching edges --
 * but only if the blur knows where the edges are, which is why the trace pass
 * also writes each pixel's normal and depth.
 *
 * A joint-bilateral filter: each neighbour is weighted by how similar its colour,
 * normal and depth are to the centre. Three passes with a growing radius, because
 * one wide pass costs more and blurs detail while three narrow ones approximate
 * the same footprint with better locality. The weights come from the geometry, so
 * a silhouette stays sharp: two pixels either side of an edge differ in normal or
 * depth, and the filter refuses to average them.
 *
 * This is a spatial filter, not a learned one. It cannot invent detail that was
 * never sampled; it removes the speckle that makes a converged image look
 * unfinished. At 16 samples it makes a frame look like 64; at 96 it is nearly a
 * no-op, which is the correct behaviour for a filter that only removes noise.
 */
const DENOISE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
out vec4 fragColour;

uniform sampler2D uColour;      // the resolved colour
uniform sampler2D uNormal;      // world normal, encoded
uniform sampler2D uDepth;       // linear distance from the eye
uniform vec2 uResolution;
uniform vec2 uStep;             // pixel step for this pass
uniform float uNormalSigma;     // how far a normal may differ and still be averaged
uniform float uDepthSigma;      // the same for depth, relative to the centre
uniform float uColourSigma;     // and for colour

/**
 * A 3x3 cross with the corners weighted less: nine taps, and the shape follows
 * the image rather than a square, which keeps a vertical edge crisper for the
 * same number of samples.
 */
const float KERNEL[9] = float[9](
  0.0625, 0.125, 0.0625,
  0.125,  0.25,  0.125,
  0.0625, 0.125, 0.0625
);
const vec2 OFFSETS[9] = vec2[9](
  vec2(-1.0, -1.0), vec2(0.0, -1.0), vec2(1.0, -1.0),
  vec2(-1.0,  0.0), vec2(0.0,  0.0), vec2(1.0,  0.0),
  vec2(-1.0,  1.0), vec2(0.0,  1.0), vec2(1.0,  1.0)
);

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec2 texel = uStep / uResolution;

  vec4 centreColour = texture(uColour, uv);
  // A pixel the tracer never covered has nothing to denoise, and averaging the
  // background into it would put a halo around every silhouette.
  if (centreColour.a < 0.5) {
    fragColour = centreColour;
    return;
  }

  vec3 centreNormal = texture(uNormal, uv).xyz * 2.0 - 1.0;
  float centreDepth = texture(uDepth, uv).r;

  vec3 sum = centreColour.rgb * KERNEL[4];
  float weightSum = KERNEL[4];

  for (int i = 0; i < 9; i++) {
    if (i == 4) continue;
    vec2 sampleUv = uv + OFFSETS[i] * texel;
    vec4 sampleColour = texture(uColour, sampleUv);
    if (sampleColour.a < 0.5) continue;

    vec3 sampleNormal = texture(uNormal, sampleUv).xyz * 2.0 - 1.0;
    float sampleDepth = texture(uDepth, sampleUv).r;

    // Three independent tests, multiplied: a neighbour must be the same surface
    // (normal), at the same distance (depth) and the same colour (so a painted
    // stripe is not smeared into the plate behind it).
    float normalAgreement = pow(max(dot(centreNormal, sampleNormal), 0.0), uNormalSigma);
    float depthDifference = abs(centreDepth - sampleDepth) / max(centreDepth, 1e-4);
    float depthAgreement = exp(-depthDifference / uDepthSigma);
    float colourDifference = dot(abs(centreColour.rgb - sampleColour.rgb), vec3(0.3333));
    float colourAgreement = exp(-colourDifference / uColourSigma);

    float weight = KERNEL[i] * normalAgreement * depthAgreement * colourAgreement;
    sum += sampleColour.rgb * weight;
    weightSum += weight;
  }

  fragColour = vec4(sum / max(weightSum, 1e-4), centreColour.a);
}
`;

const RESOLVE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
out vec4 fragColour;
uniform sampler2D uAccumulation;
uniform float uSamples;
uniform vec3 uBackground;
uniform float uOpaque;
void main() {
  vec2 uv = gl_FragCoord.xy / vec2(textureSize(uAccumulation, 0));
  vec4 sum = texture(uAccumulation, uv);
  vec3 colour = sum.rgb / max(uSamples, 1.0);
  float coverage = sum.a / max(uSamples, 1.0);
  if (uOpaque > 0.5) {
    // An export wants a backdrop, so a transparent pixel shows the scene colour
    // rather than nothing.
    fragColour = vec4(mix(uBackground, colour, coverage), 1.0);
  } else {
    fragColour = vec4(colour, coverage);
  }
}
`;

/**
 * Pack the denoised colour for presentation.
 *
 * One more pass because the denoiser works in linear space and on premultiplied
 * coverage, while the canvas wants an opaque sRGB-ish image with a background
 * mixed in -- and doing that conversion inside the filter would make its colour
 * comparisons meaningless.
 */
const PRESENT_FRAGMENT_SHADER = `#version 300 es
precision highp float;
out vec4 fragColour;
uniform sampler2D uColour;
uniform vec3 uBackground;
uniform float uOpaque;
void main() {
  vec2 uv = gl_FragCoord.xy / vec2(textureSize(uColour, 0));
  vec4 colour = texture(uColour, uv);
  if (uOpaque > 0.5) {
    fragColour = vec4(mix(uBackground, colour.rgb, colour.a), 1.0);
  } else {
    fragColour = colour;
  }
}
`;

/* ============================================================== GPU driver */

/**
 * Load one float texture from a flat array.
 *
 * `RGBA32F` with `NEAREST` filtering: the tracer fetches exact texels by index,
 * so interpolating between a node's bounds and its neighbour's would be a bug
 * rather than a nicety. The size is returned because the shader needs it to turn
 * a linear index back into a coordinate.
 *
 * @param gl - the context.
 * @param data - tightly packed floats.
 * @param texels - how many RGBA texels the array holds.
 * @returns `{ texture, size: [width, height] }`.
 */
function createDataTexture(gl, data, texels) {
  // Square-ish: the shader divides by the width, so a very wide texture wastes
  // precision on the division's integer math.
  const width = Math.max(1, Math.ceil(Math.sqrt(texels)));
  const height = Math.max(1, Math.ceil(texels / width));
  // The array may be shorter than width*height*4 because of the rounding above;
  // padding with zeros keeps the upload rectangular.
  const padded = new Float32Array(width * height * 4);
  padded.set(data.subarray(0, Math.min(data.length, padded.length)));

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, padded);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return { texture, size: [width, height] };
}

/** One colour texture, allocated but not yet attached to a framebuffer. */
function createColourTexture(gl, width, height, { float = true } = {}) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(
    gl.TEXTURE_2D, 0,
    float ? gl.RGBA16F : gl.RGBA8,
    width, height, 0,
    gl.RGBA,
    float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE,
    null,
  );
  // NEAREST everywhere: the denoiser samples exact neighbours and the resolve
  // divides by an exact count, so interpolation would only soften what was just
  // computed.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

/** A framebuffer over one or more colour textures. */
function createFramebuffer(gl, textures) {
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  textures.forEach((texture, index) => {
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + index, gl.TEXTURE_2D, texture, 0);
  });
  if (textures.length > 1) {
    gl.drawBuffers(textures.map((_, index) => gl.COLOR_ATTACHMENT0 + index));
  }
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { framebuffer, complete: status === gl.FRAMEBUFFER_COMPLETE };
}

/** Compile one shader, reporting the driver's log. */
function tracerCompileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (shader === null) throw new Error('model3d: the tracer\'s WebGL context is unavailable');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`model3d: tracer shader compile failed: ${log || 'no driver log'}`);
  }
  return shader;
}

/** Link one program from a vertex/fragment pair. */
function tracerLink(gl, vertexSource, fragmentSource) {
  const vertex = tracerCompileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = tracerCompileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`model3d: tracer link failed: ${log}`);
  }
  return program;
}

/**
 * A progressive path tracer over one BVH, with a joint-bilateral denoiser.
 *
 * The pipeline, per frame:
 *
 *   1. **trace** -- one sample per pixel, added to an `RGBA16F` accumulation, and
 *      the surface normal and distance written to their own targets;
 *   2. **resolve** -- divide the accumulation by the sample count;
 *   3. **denoise** -- three narrow joint-bilateral passes, guided by the normal
 *      and depth buffers, which is what removes the grain without eating edges;
 *   4. **present** -- mix in a background if the caller wants an opaque image.
 *
 * Steps 2-4 run on every presented frame rather than once at the end, because the
 * image is meant to be watched converging: a frame that only denoised when it had
 * finished would look like noise for a second and then snap.
 *
 * @param canvas - a canvas whose context is already a WebGL2 context, or `null` to
 *   create one. The tracer needs WebGL2; the rasteriser works on WebGL1, so a
 *   caller that wants tracing must have opted in.
 * @returns the tracer, or `null` when WebGL2, float targets or multiple render
 *   targets are unavailable.
 */
/**
 * Begin a still render on its own canvas and its own tracer.
 *
 * A separate canvas rather than the live one: resizing the live targets destroys
 * their accumulated buffer, and a buffer cannot be restored from its sample count,
 * so sharing them left the interactive view dividing an empty accumulation -- which
 * is how the export once produced a blank PNG.
 *
 * Returned as a handle with `step` rather than as one call, because the work has to
 * be interruptible. A converged still at export size is seconds of tracing, and a
 * single blocking loop freezes the tab for all of it with no progress and no way to
 * cancel. `renderStillToDataUrl` is a thin loop over this same handle, so the
 * chunked and the blocking path cannot drift apart.
 *
 * @param options - `bvh` (required), `width`, `camera`, `background`, `opaque`,
 *   `denoise`.
 * @returns a handle -- `step(count)`, `finish()`, `cancel()`, `sampleCount()`,
 *   `closed` -- or `null` when tracing is unavailable.
 */
export function createStillRender({
  bvh, width = 2048, camera,
  background = [0, 0, 0], opaque = true, denoise = 1,
}) {
  if (bvh === undefined || bvh === null || bvh.primCount === 0) return null;
  if (typeof document === 'undefined') return null;

  // The aspect comes from the camera rather than from any canvas: a still is framed
  // by what is being looked at, and with no live canvas there is nothing else to ask.
  const safeWidth = Math.max(64, Math.min(8192, Math.round(width)));
  const safeHeight = Math.max(64, Math.round(safeWidth * (camera.aspect ?? 0.75)));

  const canvas = document.createElement('canvas');
  canvas.width = safeWidth;
  canvas.height = safeHeight;
  // Not displayed, but attached: a canvas that is not in the document is not given a
  // compositing surface by every browser, and without one its drawing buffer can be
  // discarded between the trace and the read-back.
  canvas.style.cssText = 'position:fixed;left:-100000px;top:0;pointer-events:none';
  document.body.append(canvas);

  let tracer = null;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    tracer?.dispose();
    tracer = null;
    // Dropping the size and the element is what lets the browser reclaim both the
    // context and the memory behind it.
    canvas.width = 0;
    canvas.height = 0;
    canvas.remove();
  };

  try {
    tracer = createTracer(canvas);
    if (tracer === null) {
      close();
      return null;
    }
    // `ensureTargets` reports failure when the float targets are incomplete, which
    // happens on a canvas whose drawing buffer the browser has not committed yet.
    if (!tracer.ensureTargets(safeWidth, safeHeight)) {
      close();
      return null;
    }
    tracer.setScene(bvh);
  } catch {
    close();
    return null;
  }

  return {
    width: safeWidth,
    height: safeHeight,
    get closed() {
      return closed;
    },
    sampleCount: () => (closed || tracer === null ? 0 : tracer.sampleCount()),
    /**
     * Trace `count` more samples over the whole image and return the total so far.
     *
     * Ends with a synchronisation, so the slice has actually been paid for by the
     * time it returns. Without one the caller's "bounded work" is a fiction: the
     * commands are queued and the whole cost lands on whichever later call first
     * needs the result, which is what turned a sliced export into a single
     * four-and-a-half-second freeze.
     *
     * Synchronous by design: the caller decides how much work fits in one slice,
     * and a handle that yielded on its own would need a scheduler it cannot know.
     */
    step(count = 1) {
      if (closed || tracer === null) return 0;
      const wanted = Math.max(1, Math.round(count));
      for (let index = 0; index < wanted; index += 1) tracer.traceSample(camera);
      tracer.sync?.();
      return tracer.sampleCount();
    },
    /**
     * Present through the denoiser, read the PNG and release everything.
     *
     * A handle is single-use: the accumulation is consumed and the context is gone
     * afterwards, so there is nothing left to step or to finish twice.
     */
    finish() {
      if (closed || tracer === null) return null;
      try {
        if (tracer.sampleCount() === 0) return null;
        // The camera goes with the present call: the filter's geometry guide is
        // traced from it, and without one the guide is empty and the image comes
        // out blank.
        tracer.present({ background, opaque, denoise, camera });
        return tracer.toDataUrl();
      } catch {
        return null;
      } finally {
        close();
      }
    },
    cancel: close,
  };
}

/**
 * Render one converged, denoised still, without touching any live viewer.
 *
 * Blocking: it steps the handle in a loop. Use `createStillRender` instead when the
 * caller has a page to keep alive -- this is for scripts, tests and hosts that are
 * not showing anything.
 *
 * @param options - `bvh` (required), `width`, `samples`, `camera`, `background`,
 *   `opaque`, `denoise`, `onProgress`.
 * @returns a PNG data URL, or `null` when tracing is unavailable or produced
 *   nothing.
 */
export function renderStillToDataUrl({
  bvh, width = 2048, samples = 160, camera,
  background = [0, 0, 0], opaque = true, denoise = 1, onProgress,
}) {
  const still = createStillRender({ bvh, width, camera, background, opaque, denoise });
  if (still === null) return null;
  const total = Math.max(1, Math.round(samples));
  try {
    for (let index = 0; index < total; index += 1) {
      still.step(1);
      onProgress?.(index + 1, total);
    }
  } catch {
    still.cancel();
    return null;
  }
  return still.finish();
}

export function createTracer(canvas) {
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    depth: false,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  });
  if (gl === null || gl === undefined) return null;
  // Without this the RGBA16F accumulation target is incomplete and every draw
  // fails with GL_INVALID_FRAMEBUFFER_OPERATION -- silently, which is a hard way
  // to learn that a whole render pipeline is doing nothing.
  const floatTargets = gl.getExtension('EXT_color_buffer_float');
  const floatBlend = gl.getExtension('EXT_float_blend');
  if (floatTargets === null && floatBlend === null) return null;
  if (typeof gl.getError === 'function') gl.getError();

  const traceProgram = tracerLink(gl, TRACE_VERTEX_SHADER, TRACE_FRAGMENT_SHADER);
  const resolveProgram = tracerLink(gl, RESOLVE_VERTEX_SHADER, RESOLVE_FRAGMENT_SHADER);
  const denoiseProgram = tracerLink(gl, RESOLVE_VERTEX_SHADER, DENOISE_FRAGMENT_SHADER);
  const presentProgram = tracerLink(gl, RESOLVE_VERTEX_SHADER, PRESENT_FRAGMENT_SHADER);

  const uniforms = (program, names) => {
    const locations = {};
    for (const name of names) locations[name] = gl.getUniformLocation(program, name);
    return locations;
  };

  const traceUniforms = uniforms(traceProgram, [
    'uNodes', 'uPrims', 'uNodeSize', 'uPrimSize',
    'uEye', 'uTarget', 'uUp', 'uTanHalfFov', 'uResolution',
    'uPalette', 'uSurface', 'uPaletteCount', 'uLightLevel', 'uPlainLighting',
    'uFrameSeed', 'uMaxBounces', 'uLightRadius', 'uGeometryOnly',
  ]);
  const resolveUniforms = uniforms(resolveProgram, ['uAccumulation', 'uSamples', 'uBackground', 'uOpaque']);
  const denoiseUniforms = uniforms(denoiseProgram, [
    'uColour', 'uNormal', 'uDepth', 'uResolution', 'uStep',
    'uNormalSigma', 'uDepthSigma', 'uColourSigma',
  ]);
  const presentUniforms = uniforms(presentProgram, ['uColour', 'uBackground', 'uOpaque']);

  // A single empty VAO: the full-screen triangle is generated from gl_VertexID, so
  // there is nothing to bind, but WebGL2 still requires a bound VAO to draw.
  const vertexArray = gl.createVertexArray();

  let nodes = null;
  let prims = null;
  /** colour+coverage accumulation, surface normal, distance from the eye. */
  let traceTargets = null;
  /** the divided colour, and the two ping-pong buffers the denoiser writes. */
  let resolveTarget = null;
  let denoiseA = null;
  let denoiseB = null;
  /** a plain copy of the geometry, so the denoiser reads unblended values. */
  let geometryTarget = null;
  let presentTarget = null;
  /**
   * The camera the geometry guide was last traced from, or `null`.
   *
   * The guide depends on the camera and the scene, and on nothing else -- not on
   * the sample count. Tracing it again on every presented frame was a full primary
   * ray through the BVH, thrown away, ninety-six times over. Comparing the camera
   * costs six numbers and is enough to know the guide is still valid.
   */
  let geometryKey = null;
  let samples = 0;
  /**
   * How many passes have ever been traced.
   *
   * Separate from `samples` because the jitter must not repeat: `samples` resets
   * when the image restarts, and a jitter seeded from it would replay the same
   * pattern and produce an identical frame.
   */
  let frameSeed = 0;
  let width = 0;
  let height = 0;
  let disposed = false;

  /** Delete every render target and forget their textures. */
  const releaseTargets = () => {
    for (const target of [traceTargets, resolveTarget, denoiseA, denoiseB, geometryTarget, presentTarget]) {
      if (target === null || target === undefined) continue;
      for (const texture of target.textures) gl.deleteTexture(texture);
      gl.deleteFramebuffer(target.framebuffer);
    }
    traceTargets = null;
    resolveTarget = null;
    denoiseA = null;
    denoiseB = null;
    geometryTarget = null;
    presentTarget = null;
  };

  /** Allocate every target at the given size; a no-op when they already match. */
  const ensureTargets = (targetWidth, targetHeight) => {
    if (traceTargets !== null && width === targetWidth && height === targetHeight) return true;
    releaseTargets();
    width = targetWidth;
    height = targetHeight;

    // The trace pass writes colour only; the geometry pass writes normal+depth. Two
    // separate targets rather than one MRT FBO, because this build advertises
    // indexed blending and provides none, so a shared blend state would sum the
    // normals along with the colour.
    const traceColour = createColourTexture(gl, width, height);
    traceTargets = { textures: [traceColour], ...createFramebuffer(gl, [traceColour]) };

    const resolveTexture = createColourTexture(gl, width, height);
    resolveTarget = { textures: [resolveTexture], ...createFramebuffer(gl, [resolveTexture]) };

    const denoiseTextureA = createColourTexture(gl, width, height);
    denoiseA = { textures: [denoiseTextureA], ...createFramebuffer(gl, [denoiseTextureA]) };
    const denoiseTextureB = createColourTexture(gl, width, height);
    denoiseB = { textures: [denoiseTextureB], ...createFramebuffer(gl, [denoiseTextureB]) };

    // `RGBA32F` for the geometry: a normal at 16-bit precision is fine to shade
    // with but loses the sub-degree differences the edge test depends on.
    const geometryTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, geometryTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    geometryTarget = { textures: [geometryTexture], ...createFramebuffer(gl, [geometryTexture]) };

    const presentTexture = createColourTexture(gl, width, height, { float: false });
    presentTarget = { textures: [presentTexture], ...createFramebuffer(gl, [presentTexture]) };

    const complete = traceTargets.complete && resolveTarget.complete
      && denoiseA.complete && denoiseB.complete && geometryTarget.complete && presentTarget.complete;
    if (!complete) {
      releaseTargets();
      return false;
    }

    // Clear every target once, so a run that traces nothing presents black rather
    // than whatever the driver left behind.
    for (const target of [traceTargets, resolveTarget, denoiseA, denoiseB, geometryTarget, presentTarget]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.viewport(0, 0, width, height);
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    samples = 0;
    geometryKey = null;
    return true;
  };

  /**
   * Upload a built tree.
   *
   * @param bvh - the object `buildBvh` returns.
   */
  const setScene = (bvh) => {
    if (disposed) return;
    if (nodes !== null) gl.deleteTexture(nodes.texture);
    if (prims !== null) gl.deleteTexture(prims.texture);
    nodes = createDataTexture(gl, bvh.nodes, bvh.nodeCount * 2);
    prims = createDataTexture(gl, bvh.prims, bvh.primCount * 3);
    samples = 0;
    geometryKey = null;
  };

  /** Bind a texture to a unit and point a sampler uniform at it. */
  const bindTexture = (unit, texture, location) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(location, unit);
  };

  /** Draw the full-screen triangle; the vertex shader needs no inputs. */
  const drawFullscreen = () => {
    gl.bindVertexArray(vertexArray);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  /**
   * Trace one sample per pixel into the accumulation buffer.
   *
   * The camera is passed rather than read from the rasteriser, so a caller can
   * trace any view of the same scene.
   */
  const traceSample = ({
    eye, target, up, tanHalfFov, palette, surfaces, paletteCount,
    lightLevel, plainLighting, lightRadius = 0.10, maxBounces = 1,
  }) => {
    if (disposed || nodes === null || traceTargets === null) return false;

    gl.bindFramebuffer(gl.FRAMEBUFFER, traceTargets.framebuffer);
    gl.viewport(0, 0, width, height);
    // Additive: each pass accumulates, and the resolve divides by the count. This
    // is what lets a soft shadow emerge from many single-sample passes.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(traceProgram);

    bindTexture(0, nodes.texture, traceUniforms.uNodes);
    bindTexture(1, prims.texture, traceUniforms.uPrims);

    gl.uniform2i(traceUniforms.uNodeSize, nodes.size[0], nodes.size[1]);
    gl.uniform2i(traceUniforms.uPrimSize, prims.size[0], prims.size[1]);
    gl.uniform3f(traceUniforms.uEye, eye[0], eye[1], eye[2]);
    gl.uniform3f(traceUniforms.uTarget, target[0], target[1], target[2]);
    gl.uniform3f(traceUniforms.uUp, up[0], up[1], up[2]);
    gl.uniform1f(traceUniforms.uTanHalfFov, tanHalfFov);
    gl.uniform2f(traceUniforms.uResolution, width, height);
    gl.uniform3fv(traceUniforms.uPalette, palette);
    gl.uniform4fv(traceUniforms.uSurface, surfaces);
    gl.uniform1i(traceUniforms.uPaletteCount, paletteCount);
    gl.uniform1f(traceUniforms.uLightLevel, lightLevel);
    gl.uniform1i(traceUniforms.uPlainLighting, plainLighting ? 1 : 0);
    gl.uniform1f(traceUniforms.uFrameSeed, frameSeed);
    gl.uniform1i(traceUniforms.uMaxBounces, Math.max(0, Math.min(2, Math.round(maxBounces))));
    gl.uniform1f(traceUniforms.uLightRadius, Math.max(0, Number(lightRadius) || 0.10));
    gl.uniform1i(traceUniforms.uGeometryOnly, 0);

    drawFullscreen();
    gl.disable(gl.BLEND);
    samples += 1;
    frameSeed += 1;
    return true;
  };

  /**
   * Trace one primary ray per pixel and write the normal and distance.
   *
   * Separate from the accumulation because a normal is not a quantity to average
   * across samples: the denoiser compares neighbours, and a blurred normal would
   * make every edge it is meant to find soft. One pass per presented frame is
   * enough, since the geometry does not change between samples.
   */
  const traceGeometry = ({ eye, target, up, tanHalfFov }) => {
    if (disposed || nodes === null || geometryTarget === null) return false;
    gl.bindFramebuffer(gl.FRAMEBUFFER, geometryTarget.framebuffer);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.BLEND);
    gl.useProgram(traceProgram);

    bindTexture(0, nodes.texture, traceUniforms.uNodes);
    bindTexture(1, prims.texture, traceUniforms.uPrims);
    gl.uniform2i(traceUniforms.uNodeSize, nodes.size[0], nodes.size[1]);
    gl.uniform2i(traceUniforms.uPrimSize, prims.size[0], prims.size[1]);
    gl.uniform3f(traceUniforms.uEye, eye[0], eye[1], eye[2]);
    gl.uniform3f(traceUniforms.uTarget, target[0], target[1], target[2]);
    gl.uniform3f(traceUniforms.uUp, up[0], up[1], up[2]);
    gl.uniform1f(traceUniforms.uTanHalfFov, tanHalfFov);
    gl.uniform2f(traceUniforms.uResolution, width, height);
    gl.uniform1i(traceUniforms.uGeometryOnly, 1);
    drawFullscreen();
    return true;
  };

  /**
   * Resolve, denoise and present the accumulated image.
   *
   * @param options - `background` (unit RGB), `opaque`, and `denoise` to control
   *   the filter's strength: `1` is the default, `0` turns it off.
   */
  const present = ({ background = [0, 0, 0], opaque = false, denoise = 1, camera } = {}) => {
    if (disposed || traceTargets === null) return false;

    // --- 1. divide by the sample count.
    gl.bindFramebuffer(gl.FRAMEBUFFER, resolveTarget.framebuffer);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.BLEND);
    gl.useProgram(resolveProgram);
    bindTexture(0, traceTargets.textures[0], resolveUniforms.uAccumulation);
    gl.uniform1f(resolveUniforms.uSamples, samples);
    gl.uniform3f(resolveUniforms.uBackground, 0, 0, 0);
    gl.uniform1f(resolveUniforms.uOpaque, 0);
    drawFullscreen();

    // --- 2. the geometry guide: one primary ray per pixel, no shading, no shadow
    //        rays. It depends on the camera and the scene and on nothing else, so it
    //        is traced once per camera and reused. Re-tracing it on every presented
    //        frame put a second full BVH traversal behind each of ninety-six passes,
    //        which is what made a heavy plate feel frozen while it converged.
    const key = camera === undefined ? null : [
      camera.eye?.[0], camera.eye?.[1], camera.eye?.[2],
      camera.target?.[0], camera.target?.[1], camera.target?.[2],
      camera.tanHalfFov,
    ];
    const sameCamera = key !== null && geometryKey !== null
      && key.length === geometryKey.length
      && key.every((value, index) => value === geometryKey[index]);
    if (!sameCamera) {
      traceGeometry(camera);
      geometryKey = key;
    }

    // --- 3. denoise: three passes at radius 1, 2, 4. Each writes to the other
    //        ping-pong buffer, so the result ends up in `denoiseB` after an odd
    //        number of passes.
    let source = resolveTarget.textures[0];
    const passes = denoise > 0 ? 3 : 0;
    if (passes > 0) {
      gl.useProgram(denoiseProgram);
      gl.uniform2f(denoiseUniforms.uResolution, width, height);
      // The normal test is a dot product raised to a power: higher is stricter.
      // Tuned against measured noise rather than guessed, and each value is the
      // loosest that still refuses a genuine boundary:
      //   - normal power 2: a silhouette flips the normal by ~90 degrees, which
      //     still weights to nearly zero, while the curvature of a stroke is kept;
      //   - depth 0.25 relative: one pixel of tangential slope moves a surface by
      //     a few percent, so 2% rejected the neighbours it was meant to keep. The
      //     normal test already handles silhouettes, and this only has to catch a
      //     surface behind another;
      //   - colour 0.40: the filter runs on linear pre-tone-map values, where one
      //     sample's noise is several tenths. 0.10 was sized for 0..255 sRGB and
      //     made the filter a no-op.
      gl.uniform1f(denoiseUniforms.uNormalSigma, 2.0);
      gl.uniform1f(denoiseUniforms.uDepthSigma, 0.25);
      gl.uniform1f(denoiseUniforms.uColourSigma, 0.40);
      // One texture holds both: xyz is the normal, the fourth channel the
      // distance. Bound twice because the shader reads them as separate samplers,
      // which keeps the filter's code readable.
      bindTexture(1, geometryTarget.textures[0], denoiseUniforms.uNormal);
      bindTexture(2, geometryTarget.textures[0], denoiseUniforms.uDepth);

      // The colour ping-pongs between two buffers; the guides are the same
      // texture on every pass, because the geometry never changes.
      for (let pass = 0; pass < passes; pass += 1) {
        const target = pass % 2 === 0 ? denoiseA : denoiseB;
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
        gl.viewport(0, 0, width, height);
        // Each pass looks twice as far as the last, so three passes cover a
        // 7-pixel neighbourhood with 27 taps rather than 49.
        gl.uniform2f(denoiseUniforms.uStep, 1 << pass, 1 << pass);
        bindTexture(0, source, denoiseUniforms.uColour);
        drawFullscreen();
        source = target.textures[0];
      }
    }

    // --- 4. present to the canvas.
    gl.bindFramebuffer(gl.FRAMEBUFFER, presentTarget.framebuffer);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.BLEND);
    gl.useProgram(presentProgram);
    bindTexture(0, source, presentUniforms.uColour);
    gl.uniform3f(presentUniforms.uBackground, background[0], background[1], background[2]);
    gl.uniform1f(presentUniforms.uOpaque, opaque ? 1 : 0);
    drawFullscreen();

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, presentTarget.framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return true;
  };

  /**
   * The presented image as a PNG data URL.
   *
   * The canvas holds the last presented frame, which is the denoised one, so the
   * file matches what was on screen rather than a noisier intermediate.
   */
  const toDataUrl = () => {
    if (disposed || presentTarget === null) return null;
    try {
      return canvas.toDataURL('image/png');
    } catch {
      return null;
    }
  };

  return {
    setScene,
    ensureTargets,
    createTargets: ensureTargets,
    traceSample,
    traceGeometry,
    present,
    /**
     * Read the geometry guide back.
     *
     * Exposed for tests and for a host that wants to preview the guide; the
     * tracer itself never needs to read it on the CPU.
     *
     * @returns `{ width, height, data }` with RGBA floats, or `null`.
     */
    readGeometry: () => {
      if (disposed || geometryTarget === null) return null;
      const data = new Float32Array(width * height * 4);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, geometryTarget.framebuffer);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, data);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      return { width, height, data };
    },
    /** Kept under the old name for callers that only want a screen image. */
    resolveToScreen: ({ background, opaque }) => present({ background, opaque, denoise: 1 }),
    /**
     * Block until the GPU has actually finished the work queued so far.
     *
     * A WebGL call only *submits*; the commands sit in a queue and the driver runs
     * them when it gets round to it. That is why stepping a slice can return in
     * zero milliseconds while the wait lands somewhere else entirely -- measured
     * here, forty slices "took" no time at all and then one final read-back blocked
     * the page for four and a half seconds.
     *
     * For a frame on screen that is exactly right: the browser wants the queue
     * split across the compositor's own deadlines. For a loop that is trying to do
     * bounded work per slice it is useless -- the bound is only real if the slice
     * waits for its own cost. Reading one pixel back is the cheapest full
     * synchronisation WebGL offers; the value is discarded, only the stall matters.
     */
    sync: () => {
      if (disposed || traceTargets === null) return;
      const pixel = new Float32Array(4);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, traceTargets.framebuffer);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, pixel);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    },
    toDataUrl,
    /** How many samples have been accumulated. */
    sampleCount: () => samples,
    /** Forget the accumulated image and start over, e.g. after a camera change. */
    /**
     * Forget the accumulated image and start again.
     *
     * Clears the buffer as well as the counter. Resetting one without the other
     * leaves the next sample divided by a count it was not drawn with, which
     * silently produces a wrong image rather than an obviously wrong one.
     */
    restart: () => {
      samples = 0;
      if (traceTargets !== null) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, traceTargets.framebuffer);
        gl.viewport(0, 0, width, height);
        gl.disable(gl.BLEND);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
    },
    size: () => ({ width, height }),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      releaseTargets();
      if (nodes !== null) gl.deleteTexture(nodes.texture);
      if (prims !== null) gl.deleteTexture(prims.texture);
      for (const program of [traceProgram, resolveProgram, denoiseProgram, presentProgram]) {
        gl.deleteProgram(program);
      }
      gl.deleteVertexArray(vertexArray);
      nodes = null;
      prims = null;
    },
  };
}
