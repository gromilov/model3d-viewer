/**
 * The navigation cube, ported from g54.app.
 *
 * The construction here is g54.app's, not an approximation of it: the same
 * bevel, the same 26 pick regions (6 faces, 12 edges, 8 corners), the same
 * per-axis colours, the same head-light shading, and the same ray-against-
 * triangles picking. Reproducing it approximately produced a cube that looked
 * similar but behaved differently under the pointer, which is worse than not
 * having one.
 *
 * The source is minified, so names are restated and the meaning of each block
 * is documented; the arithmetic is unchanged.
 *
 * It owns a canvas and a WebGL context of its own. OrcaSlicer's cube is an
 * ImGuizmo widget canvas and g54.app's is a separate widget too: a reference
 * object needs its own depth range, its own clear and a fixed camera.
 */

/* ------------------------------------------------------------------ constants */

/** Half-size of the cube; the mesh spans ±1 before the bevel. */
const CUBE_HALF = 1;
/** How far the bevel cuts each edge in, which is what makes 26 flat regions. */
const CUBE_BEVEL = 0.3;
/** First region index of each kind, so a face/edge/corner is one arithmetic step. */
const REGION_FACE = 0;
const REGION_EDGE = 6;
const REGION_CORNER = 18;
/** Vertex stride: position, normal, colour, region. */
const CUBE_STRIDE = 40;

/** Per-axis face colours, as g54.app tints them: X warm, Y green, Z blue. */
const AXIS_COLOURS = [
  [0.92, 0.6, 0.6],
  [0.6, 0.92, 0.6],
  [0.6, 0.7, 0.95],
];
/** How much darker the −axis face of each pair is. */
const AXIS_DARKEN = 0.78;

/** Field of view of the cube's own camera. */
const CUBE_FOV = Math.PI / 5;
/**
 * How far the cube sits from its camera, in cube units.
 *
 * The cube spans ±1, so at a 36° field of view it needs to be far enough back
 * that its silhouette stays inside the frame at every orbit. The worst case is
 * a three-face view, where the corner reaches about 1.73 units across the view;
 * 7 puts the farthest corner at 0.79 of the half-frame, which leaves the cube
 * whole with a margin to spare. At 3.1 — the distance an earlier version used —
 * the corner projected to 2.07, more than twice the half-frame, and the widget
 * showed a cropped fragment.
 */
const CUBE_DISTANCE = 7;

/**
 * The face names, in the order the mesh emits its face regions.
 *
 * The order follows the normals the builder walks: +X, −X, +Y, −Y, +Z, −Z. A
 * 3D-printing file is authored Z-up with −Y as its front, so +Y is the back.
 */
export const FACES = ['right', 'left', 'back', 'front', 'top', 'bottom'];

/* ------------------------------------------------------------- mesh building */

/** A face colour, darkened for the −axis half of the pair. */
function axisColour(axis, sign) {
  const base = AXIS_COLOURS[axis];
  return sign > 0 ? base : [base[0] * AXIS_DARKEN, base[1] * AXIS_DARKEN, base[2] * AXIS_DARKEN];
}

/** The midpoint of two colours. */
function mixColour(a, b) {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

/** The average of three colours. */
function averageColour(a, b, c) {
  return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
}

/** A normalised vector, guarding against a zero length. */
function normalise(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

/** Append one vertex and return its index. */
function pushVertex(mesh, position, normal, colour, region) {
  mesh.verts.push(position[0], position[1], position[2], normal[0], normal[1], normal[2], colour[0], colour[1], colour[2], region);
  return mesh.vertCount++;
}

/** Append one triangle, recording it under its region for picking. */
function pushTriangle(mesh, region, a, b, c, normal, colour) {
  const ia = pushVertex(mesh, a, normal, colour, region);
  const ib = pushVertex(mesh, b, normal, colour, region);
  const ic = pushVertex(mesh, c, normal, colour, region);
  mesh.idx.push(ia, ib, ic);
  let list = mesh.regionTriangles.get(region);
  if (list === undefined) {
    list = [];
    mesh.regionTriangles.set(region, list);
  }
  list.push({ a, b, c });
}

/** Append a quad as two triangles. */
function pushQuad(mesh, region, a, b, c, d, normal, colour) {
  pushTriangle(mesh, region, a, b, c, normal, colour);
  pushTriangle(mesh, region, a, c, d, normal, colour);
}

/**
 * Build the 26-region beveled cube.
 *
 * The order is fixed and matters: six faces, then twelve edges, then eight
 * corners, numbered from `REGION_FACE` / `REGION_EDGE` / `REGION_CORNER`. The
 * loops walk both signs of each axis, which is where the counts come from —
 * 2×2 edges per axis pair, 2×2×2 corners — and the winding flips with the sign
 * product so every face still points outwards.
 */
function buildCubeMesh() {
  const t = CUBE_HALF;
  const n = t - CUBE_BEVEL;
  const mesh = { verts: [], idx: [], vertCount: 0, regionTriangles: new Map() };

  // The six faces, each slightly proud of the bevel so a flat panel remains.
  const faces = [
    { normal: [1, 0, 0], colour: axisColour(0, 1), region: REGION_FACE + 0, verts: [[t, -n, -n], [t, n, -n], [t, n, n], [t, -n, n]] },
    { normal: [-1, 0, 0], colour: axisColour(0, -1), region: REGION_FACE + 1, verts: [[-t, n, -n], [-t, -n, -n], [-t, -n, n], [-t, n, n]] },
    { normal: [0, 1, 0], colour: axisColour(1, 1), region: REGION_FACE + 2, verts: [[n, t, -n], [-n, t, -n], [-n, t, n], [n, t, n]] },
    { normal: [0, -1, 0], colour: axisColour(1, -1), region: REGION_FACE + 3, verts: [[-n, -t, -n], [n, -t, -n], [n, -t, n], [-n, -t, n]] },
    { normal: [0, 0, 1], colour: axisColour(2, 1), region: REGION_FACE + 4, verts: [[-n, -n, t], [n, -n, t], [n, n, t], [-n, n, t]] },
    { normal: [0, 0, -1], colour: axisColour(2, -1), region: REGION_FACE + 5, verts: [[n, -n, -t], [-n, -n, -t], [-n, n, -t], [n, n, -t]] },
  ];
  for (const face of faces) {
    pushQuad(mesh, face.region, face.verts[0], face.verts[1], face.verts[2], face.verts[3], face.normal, face.colour);
  }

  const signs = [-1, 1];
  let region = REGION_EDGE;

  // The twelve edges: two axes vary per pair, the third sits on the bevel.
  for (const a of signs) for (const b of signs) {
    const ca = axisColour(0, a);
    const cb = axisColour(1, b);
    const colour = mixColour(ca, cb);
    const normal = normalise([a, b, 0]);
    const p0 = [a * t, b * n, -n];
    const p1 = [a * n, b * t, -n];
    const p2 = [a * n, b * t, n];
    const p3 = [a * t, b * n, n];
    if (a * b > 0) pushQuad(mesh, region, p0, p1, p2, p3, normal, colour);
    else pushQuad(mesh, region, p0, p3, p2, p1, normal, colour);
    region += 1;
  }
  for (const a of signs) for (const b of signs) {
    const ca = axisColour(0, a);
    const cb = axisColour(2, b);
    const colour = mixColour(ca, cb);
    const normal = normalise([a, 0, b]);
    const p0 = [a * t, -n, b * n];
    const p1 = [a * t, n, b * n];
    const p2 = [a * n, n, b * t];
    const p3 = [a * n, -n, b * t];
    if (a * b > 0) pushQuad(mesh, region, p0, p1, p2, p3, normal, colour);
    else pushQuad(mesh, region, p0, p3, p2, p1, normal, colour);
    region += 1;
  }
  for (const a of signs) for (const b of signs) {
    const ca = axisColour(1, a);
    const cb = axisColour(2, b);
    const colour = mixColour(ca, cb);
    const normal = normalise([0, a, b]);
    const p0 = [-n, a * t, b * n];
    const p1 = [n, a * t, b * n];
    const p2 = [n, a * n, b * t];
    const p3 = [-n, a * n, b * t];
    if (a * b > 0) pushQuad(mesh, region, p0, p3, p2, p1, normal, colour);
    else pushQuad(mesh, region, p0, p1, p2, p3, normal, colour);
    region += 1;
  }

  // The eight corners. g54.app draws one triangle per corner between the three
  // adjacent edges, which leaves a wedge of the corner open between that
  // triangle and the cube's own vertex: at its camera distance the gap is small
  // enough that a ray rarely finds it, but at a wider framing a ray aimed at a
  // corner falls straight through and the click is lost.
  //
  // The corner is closed here with three triangles fanned from the vertex
  // instead, so the region is a solid pyramid cap with no hole in it.
  region = REGION_CORNER;
  for (const a of signs) for (const b of signs) for (const c of signs) {
    const ca = axisColour(0, a);
    const cb = axisColour(1, b);
    const cc = axisColour(2, c);
    const colour = averageColour(ca, cb, cc);
    const normal = normalise([a, b, c]);
    // The three points where the bevel meets each of the adjacent edges.
    const p0 = [a * t, b * n, c * n];
    const p1 = [a * n, b * t, c * n];
    const p2 = [a * n, b * n, c * t];
    // The cube's own vertex, which the fan closes against.
    const apex = [a * t, b * t, c * t];
    if (a * b * c > 0) {
      pushTriangle(mesh, region, p0, p1, apex, normal, colour);
      pushTriangle(mesh, region, p1, p2, apex, normal, colour);
      pushTriangle(mesh, region, p2, p0, apex, normal, colour);
    } else {
      pushTriangle(mesh, region, p1, p0, apex, normal, colour);
      pushTriangle(mesh, region, p2, p1, apex, normal, colour);
      pushTriangle(mesh, region, p0, p2, apex, normal, colour);
    }
    region += 1;
  }

  return {
    vertices: new Float32Array(mesh.verts),
    indices: new Uint32Array(mesh.idx),
    regionTriangles: mesh.regionTriangles,
  };
}

/* ------------------------------------------------------------------- shaders */

const CUBE_VERTEX_SHADER = `
attribute vec3 aPosition;
attribute vec3 aNormal;
attribute vec3 aColour;
attribute float aRegion;
uniform mat4 uProjection;
uniform mat4 uView;
varying vec3 vNormal;
varying vec3 vWorld;
varying vec3 vColour;
varying float vRegion;

void main() {
  vNormal = aNormal;
  vWorld = aPosition;
  vColour = aColour;
  vRegion = aRegion;
  gl_Position = uProjection * uView * vec4(aPosition, 1.0);
}
`;

const CUBE_FRAGMENT_SHADER = `
precision mediump float;
varying vec3 vNormal;
varying vec3 vWorld;
varying vec3 vColour;
varying float vRegion;
uniform vec3 uEye;
uniform float uHoverRegion;

void main() {
  // A head-light plus a constant ambient term: the light travels with the
  // camera, so every visible face stays distinct from every angle. A fixed
  // world light leaves two faces equally dark at some orbits.
  vec3 normal = normalize(vNormal);
  vec3 toEye = normalize(uEye - vWorld);
  float facing = clamp(dot(normal, toEye), 0.0, 1.0);
  float shade = 0.55 + 0.5 * facing;
  vec3 colour = vColour * shade;

  // The region under the pointer is tinted toward the accent, so a click target
  // advertises itself before the click lands.
  if (abs(vRegion - uHoverRegion) < 0.5) {
    colour = mix(colour, vec3(0.29, 0.85, 1.0), 0.55);
  }
  gl_FragColor = vec4(colour, 1.0);
}
`;

/* ---------------------------------------------------------------- utilities */

/** A column-major cubePerspective projection matrix. */
function cubePerspective(fovY, aspect, near, far) {
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
function cubeLookAt(eye, target, up) {
  const zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
  const zLength = Math.hypot(zx, zy, zz) || 1;
  const zv = [zx / zLength, zy / zLength, zz / zLength];
  let xv = [up[1] * zv[2] - up[2] * zv[1], up[2] * zv[0] - up[0] * zv[2], up[0] * zv[1] - up[1] * zv[0]];
  let xLength = Math.hypot(xv[0], xv[1], xv[2]);
  if (xLength < 1e-6) {
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

/** Compile one shader stage, reporting the driver's log on failure. */
function cubeCompileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (shader === null) throw new Error('model3d: the cube\'s WebGL context is unavailable');
  gl.shaderSource(shader, source);
  // This is WebGL's own method, not this module's helper: an over-broad rename
  // once turned it into `cubeCompileShader` and broke the cube the moment it was
  // shown.
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`model3d: cube shader compile failed: ${log || 'no driver log'}`);
  }
  return shader;
}

/** Link the cube's program and expose its locations. */
function createCubeProgram(gl) {
  const vertex = cubeCompileShader(gl, gl.VERTEX_SHADER, CUBE_VERTEX_SHADER);
  const fragment = cubeCompileShader(gl, gl.FRAGMENT_SHADER, CUBE_FRAGMENT_SHADER);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`model3d: cube program link failed: ${log}`);
  }
  return {
    program,
    position: gl.getAttribLocation(program, 'aPosition'),
    normal: gl.getAttribLocation(program, 'aNormal'),
    colour: gl.getAttribLocation(program, 'aColour'),
    region: gl.getAttribLocation(program, 'aRegion'),
    projection: gl.getUniformLocation(program, 'uProjection'),
    view: gl.getUniformLocation(program, 'uView'),
    eye: gl.getUniformLocation(program, 'uEye'),
    hoverRegion: gl.getUniformLocation(program, 'uHoverRegion'),
  };
}

/**
 * Ray against one triangle, returning the distance or null.
 *
 * Möller–Trumbore, the same test g54.app's picker runs; picking against the
 * real triangles is what lets edges and corners be separate targets rather than
 * splitting a face box by hand.
 */
function rayTriangle(origin, direction, triangle) {
  const ax = triangle.a[0], ay = triangle.a[1], az = triangle.a[2];
  const bx = triangle.b[0], by = triangle.b[1], bz = triangle.b[2];
  const cx = triangle.c[0], cy = triangle.c[1], cz = triangle.c[2];

  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;

  const px = direction[1] * e2z - direction[2] * e2y;
  const py = direction[2] * e2x - direction[0] * e2z;
  const pz = direction[0] * e2y - direction[1] * e2x;

  const determinant = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(determinant) < 1e-7) return null;
  const inverse = 1 / determinant;

  const tx = origin[0] - ax, ty = origin[1] - ay, tz = origin[2] - az;
  const u = (tx * px + ty * py + tz * pz) * inverse;
  if (u < 0 || u > 1) return null;

  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;

  const v = (direction[0] * qx + direction[1] * qy + direction[2] * qz) * inverse;
  if (v < 0 || u + v > 1) return null;

  const t = (e2x * qx + e2y * qy + e2z * qz) * inverse;
  return t > 0 ? t : null;
}

/* ------------------------------------------------------------------- widget */

/**
 * Create the navigation cube over a canvas of its own.
 *
 * @param canvas - the cube's canvas; it owns the context for its lifetime.
 * @param onPick - called with a face name when a region is clicked.
 * @returns the handle: `setOrbit`, `readOnly`, `pick`, `dispose`.
 */
export function createCube(canvas, onPick, onOrbit) {
  const gl = canvas.getContext('webgl2', { antialias: true, alpha: true, premultipliedAlpha: false })
    ?? canvas.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: false });
  if (gl === null) throw new Error('model3d: WebGL is unavailable for the navigation cube');

  const program = createCubeProgram(gl);
  const mesh = buildCubeMesh();
  const vertexBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
  const indexBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);

  let orbit = { yaw: -0.65, pitch: 0.42 };
  let hoverRegion = -1;
  // A drag on the cube turns the camera, the same gesture the plate has: press
  // and move rather than click a face. A click that never moved is still a
  // preset, so the two are told apart by how far the pointer travelled.
  let dragging = null;
  let disposed = false;
  let frame = 0;

  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);
  gl.clearColor(0, 0, 0, 0);

  /** Match the backing store to the element's size. */
  const resize = () => {
    const ratio = Math.min(globalThis.devicePixelRatio ?? 1, 2.5);
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  };

  /** Where the eye sits for the current orbit. */
  const eyeFor = (angles) => {
    const cosPitch = Math.cos(angles.pitch);
    return [
      cosPitch * Math.cos(angles.yaw) * CUBE_DISTANCE,
      cosPitch * Math.sin(angles.yaw) * CUBE_DISTANCE,
      Math.sin(angles.pitch) * CUBE_DISTANCE,
    ];
  };

  /** Draw the cube once. */
  const draw = () => {
    if (disposed) return;
    resize();
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const eye = eyeFor(orbit);
    const aspect = canvas.width / Math.max(1, canvas.height);
    gl.useProgram(program.program);
    gl.uniformMatrix4fv(program.projection, false, cubePerspective(CUBE_FOV, aspect, 0.1, 20));
    gl.uniformMatrix4fv(program.view, false, cubeLookAt(eye, [0, 0, 0], [0, 0, 1]));
    gl.uniform3f(program.eye, eye[0], eye[1], eye[2]);
    gl.uniform1f(program.hoverRegion, hoverRegion);

    const stride = CUBE_STRIDE;
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.enableVertexAttribArray(program.position);
    gl.vertexAttribPointer(program.position, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(program.normal);
    gl.vertexAttribPointer(program.normal, 3, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(program.colour);
    gl.vertexAttribPointer(program.colour, 3, gl.FLOAT, false, stride, 24);
    gl.enableVertexAttribArray(program.region);
    gl.vertexAttribPointer(program.region, 1, gl.FLOAT, false, stride, 36);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.drawElements(gl.TRIANGLES, mesh.indices.length, gl.UNSIGNED_INT, 0);
  };

  /**
   * Which region a pointer over the canvas hits, by casting a ray at the mesh.
   *
   * Every region's triangles are tested and the nearest hit wins, which is what
   * makes an edge and a corner distinguishable from the face beside them.
   */
  const pick = (clientX, clientY) => {
    const box = canvas.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return -1;
    // Normalised device coordinates, with Y flipped: screen Y grows downwards.
    const nx = ((clientX - box.left) / box.width) * 2 - 1;
    const ny = -(((clientY - box.top) / box.height) * 2 - 1);

    const eye = eyeFor(orbit);
    const forward = normalise([-eye[0], -eye[1], -eye[2]]);
    let right = [-forward[1], forward[0], 0];
    right = normalise(right);
    const up = [
      forward[1] * right[2] - forward[2] * right[1],
      forward[2] * right[0] - forward[0] * right[2],
      forward[0] * right[1] - forward[1] * right[0],
    ];
    const tanHalf = Math.tan(CUBE_FOV / 2);
    const direction = normalise([
      forward[0] + right[0] * nx * tanHalf + up[0] * ny * tanHalf,
      forward[1] + right[1] * nx * tanHalf + up[1] * ny * tanHalf,
      forward[2] + right[2] * nx * tanHalf + up[2] * ny * tanHalf,
    ]);

    let nearest = Infinity;
    let hitRegion = -1;
    for (const [region, triangles] of mesh.regionTriangles) {
      for (const triangle of triangles) {
        const distance = rayTriangle(eye, direction, triangle);
        if (distance !== null && distance < nearest) {
          nearest = distance;
          hitRegion = region;
        }
      }
    }
    return hitRegion;
  };

  /**
   * The camera angles a region names.
   *
   * Every one of the 26 regions is a direction in the cube: a face is one axis,
   * an edge is two, a corner is three. Its centroid points that way, so the
   * orbit that looks straight at the region is the orbit whose eye sits on the
   * *opposite* side — which is the whole of the mapping, with no table to keep
   * in step with the geometry.
   *
   * The region's centroid is computed here rather than stored, because storing
   * 26 vectors would be a second copy of what the mesh already encodes.
   */
  const viewOfRegion = (region) => {
    const triangles = mesh.regionTriangles.get(region);
    if (triangles === undefined || triangles.length === 0) return null;
    // The centroid of the region's triangles, averaged.
    const sum = [0, 0, 0];
    let count = 0;
    for (const triangle of triangles) {
      for (const corner of [triangle.a, triangle.b, triangle.c]) {
        sum[0] += corner[0];
        sum[1] += corner[1];
        sum[2] += corner[2];
        count += 1;
      }
    }
    if (count === 0) return null;
    const centroid = [sum[0] / count, sum[1] / count, sum[2] / count];
    const length = Math.hypot(centroid[0], centroid[1], centroid[2]);
    if (length < 1e-6) return null;
    const direction = [centroid[0] / length, centroid[1] / length, centroid[2] / length];

    // The eye looks back along the direction, so the orbit places it opposite.
    // Pitch is clamped just shy of the poles, where the up vector degenerates.
    const limit = Math.PI / 2 - 0.02;
    const pitch = Math.max(-limit, Math.min(limit, Math.asin(direction[2])));
    const yaw = Math.atan2(direction[1], direction[0]);
    return { yaw, pitch };
  };

  /** How far the pointer moved since the press, below which a press is a click. */
  const CLICK_SLOP = 4;

  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragging = { x: event.clientX, y: event.clientY, moved: 0 };
    canvas.setPointerCapture?.(event.pointerId);
    canvas.style.cursor = 'grabbing';
  };

  const onPointerMove = (event) => {
    if (dragging === null) {
      // No gesture: only the hover highlight changes.
      const region = pick(event.clientX, event.clientY);
      if (region === hoverRegion) return;
      hoverRegion = region;
      draw();
      return;
    }

    const deltaX = event.clientX - dragging.x;
    const deltaY = event.clientY - dragging.y;
    dragging.x = event.clientX;
    dragging.y = event.clientY;
    dragging.moved += Math.abs(deltaX) + Math.abs(deltaY);
    if (dragging.moved < CLICK_SLOP) return;

    // Turning the cube is turning the camera, so the orbit moves the same way
    // the plate's does and the plate follows through the subscription.
    const limit = Math.PI / 2 - 0.02;
    orbit = {
      yaw: orbit.yaw - deltaX * 0.012,
      pitch: Math.max(-limit, Math.min(limit, orbit.pitch + deltaY * 0.012)),
    };
    hoverRegion = -1;
    draw();
    onOrbit?.(orbit);
  };

  const endDrag = () => {
    if (dragging === null) return;
    const wasClick = dragging.moved < CLICK_SLOP;
    dragging = null;
    canvas.style.cursor = 'grab';
    if (!wasClick) return;
    // A press that never moved is a preset: read the region under it.
    const region = lastPressRegion;
    if (region < 0) return;
    const view = viewOfRegion(region);
    if (view !== null) onPick?.(view);
  };

  // The region a press started on, so a click resolves the region the user
  // aimed at rather than whatever sits under the pointer after a nudge.
  let lastPressRegion = -1;

  canvas.addEventListener('pointerdown', (event) => {
    lastPressRegion = pick(event.clientX, event.clientY);
    onPointerDown(event);
  });
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('lostpointercapture', endDrag);
  canvas.addEventListener('pointerleave', () => {
    if (dragging !== null || hoverRegion === -1) return;
    hoverRegion = -1;
    draw();
  });

  // The first frame is drawn here: a widget that only paints in response to a
  // later event would be blank until the camera happened to move, which is a
  // blank box in the corner until something else touches it.
  draw();

  // At mount the element is usually not laid out yet, so its size reads as zero
  // and this first frame is a single pixel. A resize observer repaints once the
  // box has a size, and again whenever the sidebar is dragged.
  const resizeObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => draw())
    : null;
  resizeObserver?.observe(canvas);

  return {
    /** Turn the cube to the plate's orbit. */
    setOrbit: (next) => {
      orbit = next;
      // Coalesce frames: a drag reports the orbit many times per frame, and the
      // cube only needs to be drawn once for each.
      if (frame !== 0) return;
      frame = globalThis.requestAnimationFrame?.(() => {
        frame = 0;
        draw();
      }) ?? 0;
      if (frame === 0) draw();
    },
    /** How many pick regions the cube has, for a test to assert on. */
    readOnly: () => ({ regions: mesh.regionTriangles.size, triangles: mesh.indices.length / 3 }),
    viewOfRegion,
    pick,
    redraw: draw,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (frame !== 0) globalThis.cancelAnimationFrame?.(frame);
      resizeObserver?.disconnect();
      gl.deleteBuffer(vertexBuffer);
      gl.deleteBuffer(indexBuffer);
      gl.deleteProgram(program.program);
    },
  };
}
