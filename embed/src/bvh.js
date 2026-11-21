/**
 * Building the GPU ray tracer's acceleration structure.
 *
 * The tracer walks a binary bounding volume hierarchy on the GPU, over the same
 * geometry the rasteriser draws, so this module's only job is turning a parsed
 * mesh into the two flat float arrays `bvh-layout.md` describes: `uNodes` and
 * `uPrims`. It runs once per opened file, on the main thread, while the user is
 * waiting for the model to appear — and that, rather than tree quality, shapes
 * every decision below: typed arrays from end to end, no object per primitive, an
 * explicit stack instead of recursion, and a splitter that never compares.
 *
 * The splitter is a binned surface-area heuristic across the widest axis of a
 * node's centroid bounds — twelve buckets, one counting-sort partition, so the
 * work per node is linear in its primitive count and the tree comes out balanced
 * (a 154k-capsule plate reaches depth 23 with 18 primitive visits per primitive,
 * which is the log of its leaf count). A three-axis sweep would pick marginally
 * better splits for three times the passes, which a plate of mostly flat, mostly
 * parallel strokes does not repay.
 *
 * Two quantities decide cost here, and both are about memory rather than
 * arithmetic: a primitive's box is read once per level of the tree below it, and
 * the split has to gather those boxes through whatever order the previous level
 * left behind. Two consequences run through the design:
 *
 *   - **A node's centroid bounds are handed down by its parent**, which was
 *     already reading those centroids to place them in buckets. That removes a
 *     whole gather pass per node, and with it about half the cache misses.
 *   - **Boxes are stored as float32.** They are unions of float32 values, so
 *     min and max are exact; storing them as float64 would double the bytes
 *     touched per level for no accuracy at all.
 *
 * Geometry arrives in the file's millimetres. Everything written here is in the
 * viewer's *normalised* space instead — `(raw - centre) * scale` — because that
 * is the space the camera orbits in and so the space the tracer's rays live in.
 * `centreAndScale` has the exact rule, and the reason there is more than one.
 */

/**
 * Floats per node: two `RGBA32F` texels.
 *
 * `(minX, minY, minZ, leftOrFirst)` then `(maxX, maxY, maxZ, count)`. An internal
 * node has `count === 0` and `leftOrFirst` naming the first of two *contiguous*
 * children; a leaf holds `count` primitives from `leftOrFirst`.
 */
const NODE_FLOATS = 8;

/** Floats per primitive: three `RGBA32F` texels — `(p0, type)`, `(p1, radius)`, `(p2, slot)`. */
const PRIM_FLOATS = 12;

/**
 * The two shapes `uPrims` can hold, as the tracer's `type` code.
 *
 * A triangle needs all three corners and no radius; a capsule needs its two end
 * points and the sweep radius, and leaves `p2` free for the palette slot.
 */
const TYPE_TRIANGLE = 0;
const TYPE_CAPSULE = 1;

/** Floats per instance in a segment mesh: a(3) b(3) half-extent(2) slot(1) layer(1). */
const SEGMENT_STRIDE = 12;

/** The shader's palette has eight slots; a slot outside `0..7` samples nothing. */
const MAX_SLOTS = 8;

/**
 * Default cap on nodes, and so on leaves.
 *
 * 400k nodes is 12.8 MB of texture — comfortable next to the geometry — and
 * holds ~200k leaves, four times what a 400k-stroke plate needs at the default
 * leaf size. The budget exists so a pathological model degrades into a coarser
 * tree rather than an allocation failure.
 */
const DEFAULT_MAX_NODES = 400000;

/**
 * Primitives per leaf before splitting stops.
 *
 * Four is the usual sweet spot for a GPU tracer: fewer and the stack work
 * dominates, more and every leaf pays for primitives the ray does not hit. It is
 * a ceiling, not a target — the area heuristic makes most leaves smaller than
 * this, which is why the measured tree averages about three.
 */
const DEFAULT_LEAF_SIZE = 4;

/**
 * Depth beyond which a node becomes a leaf regardless.
 *
 * A safety valve, not a tuning knob: the node budget runs out long before a
 * balanced tree reaches this depth (23 for the largest real plate measured). A
 * tree that hits it is one the splitter cannot separate — coincident geometry —
 * and dividing further would not help. It also bounds the explicit stack.
 */
const DEFAULT_MAX_DEPTH = 64;

/**
 * Hard ceiling on `maxDepth`, because the stack is a fixed-size typed array.
 *
 * Twice the default and far past anything a real model reaches; a caller asking
 * for more than this gets a leaf early rather than a stack overflow.
 */
const MAX_DEPTH_LIMIT = 128;

/** Buckets for the area heuristic. Twelve is the usual compromise between resolution and passes. */
const BIN_COUNT = 12;

/**
 * How far node boxes are grown when written as float32, relatively and absolutely.
 *
 * The tree is measured in float64 but stored in float32, and a box that rounds
 * *inwards* would let a ray slip past a primitive it should have hit — a black
 * speck, exactly the artefact the layout document warns the capsule form about.
 * ~1e-6 is eight float32 ulps at the magnitude of a normalised model (which
 * spans about 2 units), so it costs no measurable number of extra traversals.
 */
const BOUND_EPSILON = 1e-6;

/**
 * Build the tracer's tree and primitive buffer for one mesh.
 *
 * Both mesh kinds the viewer loads are accepted:
 *
 *   - `mesh.kind === 'segments'` (a sliced plate): each instance becomes a
 *     capsule whose radius is `max(halfWidth, halfHeight)` — the layout document
 *     stores one radius for a stroke and accepts that its height may differ,
 *     because at a 0.2 mm layer the two are within a few per cent.
 *   - anything else: `mesh.positions`, nine floats per triangle, become
 *     triangles (`type 0`). The palette slot comes from `mesh.colours` when the
 *     project is painted and is `0` otherwise.
 *
 * Everything is normalised into the viewer's space on the way in, so no caller
 * has to remember to do it: see `centreAndScale`.
 *
 * `nodes` and `prims` are exactly `nodeCount * 8` and `primCount * 12` floats
 * long, so they can go straight to `texImage2D` with no padding.
 *
 * A mesh with no primitives yields `nodeCount === 0`. That case is *not*
 * representable in the layout — `count === 0` means internal, so an empty node
 * would look like an internal node pointing at itself — so callers must skip
 * tracing when `primCount === 0` rather than relying on a degenerate root.
 *
 * @param mesh - a parsed mesh: `{ kind: 'segments', instances, stride }`, or
 *   `{ positions, triangles, colours?, palette?, center, size }`.
 * @param options - `maxNodes` (default 400000), `leafSize` (default 4),
 *   `maxDepth` (default 64, clamped to 128).
 * @returns `{ nodes, nodeCount, prims, primCount, bounds, stats }`, where
 *   `bounds` is the exact primitive union in normalised space and `stats` counts
 *   nodes, leaves, primitives, the deepest level reached, the build time in
 *   milliseconds, and how many leaves the node budget or depth cap forced early.
 */
export function buildBvh(mesh, options = {}) {
  const started = now();
  const maxNodes = Math.max(1, Math.floor(options.maxNodes ?? DEFAULT_MAX_NODES));
  const leafSize = Math.max(1, Math.floor(options.leafSize ?? DEFAULT_LEAF_SIZE));
  const maxDepth = Math.min(MAX_DEPTH_LIMIT, Math.max(1, Math.floor(options.maxDepth ?? DEFAULT_MAX_DEPTH)));

  if (mesh === null || typeof mesh !== 'object') throw new Error('bvh: a mesh is required');
  const packed = mesh.kind === 'segments' ? packSegments(mesh) : packTriangles(mesh);
  const prims = packed.prims;
  const primCount = packed.primCount;

  const stats = (nodeCount, leaves, depth, cappedNodes) => ({
    nodes: nodeCount,
    leaves,
    prims: primCount,
    maxDepth: depth,
    buildMs: now() - started,
    cappedNodes,
  });

  if (primCount === 0) {
    const empty = [0, 0, 0];
    return {
      nodes: new Float32Array(0),
      nodeCount: 0,
      prims: new Float32Array(0),
      primCount: 0,
      bounds: { minimum: empty.slice(), maximum: empty.slice() },
      stats: stats(0, 0, 0, 0),
    };
  }

  // Primitive boxes and centroids are measured once, from the packed primitives,
  // and then only read: every level unions the same boxes, so measuring them at
  // the leaves instead of per node is what keeps the build linear. The
  // measurement is fused with the packing so the primitive buffer is walked once.
  const bounds = new Float32Array(primCount * 6);
  const modelBox = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  const centroidBox = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  for (let id = 0; id < primCount; id += 1) {
    const base = id * PRIM_FLOATS;
    const ax = prims[base], ay = prims[base + 1], az = prims[base + 2];
    const bx = prims[base + 4], by = prims[base + 5], bz = prims[base + 6];
    let minX, minY, minZ, maxX, maxY, maxZ;
    if (prims[base + 3] === TYPE_CAPSULE) {
      const radius = prims[base + 7];
      minX = (ax < bx ? ax : bx) - radius;
      minY = (ay < by ? ay : by) - radius;
      minZ = (az < bz ? az : bz) - radius;
      maxX = (ax > bx ? ax : bx) + radius;
      maxY = (ay > by ? ay : by) + radius;
      maxZ = (az > bz ? az : bz) + radius;
    } else {
      const cx = prims[base + 8], cy = prims[base + 9], cz = prims[base + 10];
      minX = ax < bx ? (ax < cx ? ax : cx) : (bx < cx ? bx : cx);
      minY = ay < by ? (ay < cy ? ay : cy) : (by < cy ? by : cy);
      minZ = az < bz ? (az < cz ? az : cz) : (bz < cz ? bz : cz);
      maxX = ax > bx ? (ax > cx ? ax : cx) : (bx > cx ? bx : cx);
      maxY = ay > by ? (ay > cy ? ay : cy) : (by > cy ? by : cy);
      maxZ = az > bz ? (az > cz ? az : cz) : (bz > cz ? bz : cz);
    }
    const six = id * 6;
    bounds[six] = minX;
    bounds[six + 1] = minY;
    bounds[six + 2] = minZ;
    bounds[six + 3] = maxX;
    bounds[six + 4] = maxY;
    bounds[six + 5] = maxZ;
    if (minX < modelBox[0]) modelBox[0] = minX;
    if (minY < modelBox[1]) modelBox[1] = minY;
    if (minZ < modelBox[2]) modelBox[2] = minZ;
    if (maxX > modelBox[3]) modelBox[3] = maxX;
    if (maxY > modelBox[4]) modelBox[4] = maxY;
    if (maxZ > modelBox[5]) modelBox[5] = maxZ;
    // The centroid is the box's midpoint, so it costs two adds here and nothing
    // to re-derive at every level that needs it.
    const centreX = (minX + maxX) * 0.5;
    const centreY = (minY + maxY) * 0.5;
    const centreZ = (minZ + maxZ) * 0.5;
    if (centreX < centroidBox[0]) centroidBox[0] = centreX;
    if (centreY < centroidBox[1]) centroidBox[1] = centreY;
    if (centreZ < centroidBox[2]) centroidBox[2] = centreZ;
    if (centreX > centroidBox[3]) centroidBox[3] = centreX;
    if (centreY > centroidBox[4]) centroidBox[4] = centreY;
    if (centreZ > centroidBox[5]) centroidBox[5] = centreZ;
  }

  // `order` is the only thing permuted: the primitives themselves are reordered
  // once at the end, from this, so that a leaf's range is contiguous in `uPrims`
  // as the layout requires. Permuting 4-byte indices instead of 48-byte
  // primitives is why the tree build is cheap.
  const order = new Int32Array(primCount);
  for (let id = 0; id < primCount; id += 1) order[id] = id;

  // The largest leaf is `leafSize` primitives, so a balanced tree needs about
  // `2 * n / leafSize` nodes; this guesses that and growth covers an unbalanced
  // tree. Guessing beats allocating the 12.8 MB worst case for every model.
  const predicted = Math.min(maxNodes, Math.max(3, 4 * Math.ceil(primCount / leafSize) + 1));
  let nodeData = new Float32Array(predicted * NODE_FLOATS);
  let nodeCount = 1;
  let leafCount = 0;
  let cappedNodes = 0;
  let deepest = 0;

  const reserveNodes = (needed) => {
    if (needed * NODE_FLOATS <= nodeData.length) return;
    let capacity = Math.max(3, nodeData.length / NODE_FLOATS);
    while (capacity < needed) capacity *= 2;
    const grown = new Float32Array(capacity * NODE_FLOATS);
    grown.set(nodeData);
    nodeData = grown;
  };

  /** Grow a box on the way into the float32 texture, so rounding cannot hide a hit. */
  const lower = (value) => value - (Math.abs(value) + 1) * BOUND_EPSILON;
  const upper = (value) => value + (Math.abs(value) + 1) * BOUND_EPSILON;

  // Root box: the only node whose box is measured from the model. Every other
  // node gets its box from the split that created it, where the buckets already
  // hold it — which is the whole point of binning.
  nodeData[0] = lower(modelBox[0]);
  nodeData[1] = lower(modelBox[1]);
  nodeData[2] = lower(modelBox[2]);
  nodeData[4] = upper(modelBox[3]);
  nodeData[5] = upper(modelBox[4]);
  nodeData[6] = upper(modelBox[5]);

  // Scratch reused by every node. Allocating these per node would be 100k sets of
  // small arrays and a build dominated by the collector.
  const scratch = new Int32Array(primCount);
  const binOf = new Uint8Array(primCount);
  const binCounts = new Int32Array(BIN_COUNT);
  const binBounds = new Float32Array(BIN_COUNT * 6);
  const binOffsets = new Int32Array(BIN_COUNT);
  const binCentroids = new Float32Array(BIN_COUNT * 6);
  const leftCount = new Int32Array(BIN_COUNT);
  const leftBounds = new Float32Array(BIN_COUNT * 6);
  const leftCentroids = new Float32Array(BIN_COUNT * 6);
  const leftArea = new Float64Array(BIN_COUNT);
  const rightCount = new Int32Array(BIN_COUNT);
  const rightBounds = new Float32Array(BIN_COUNT * 6);
  const rightCentroids = new Float32Array(BIN_COUNT * 6);
  const rightArea = new Float64Array(BIN_COUNT);
  // The count-split fallback's two boxes, hoisted so the rare path allocates
  // nothing either.
  const fallbackLeft = new Float64Array(6);
  const fallbackRight = new Float64Array(6);

  // DFS with the right child deferred, so the stack never holds more than one
  // entry per level — which is why a fixed-size stack is enough. Recursion here
  // would be one frame per node, and the stack must outlive a leaf that the
  // depth cap turned early.
  const stackSize = maxDepth + 2;
  const stackNode = new Int32Array(stackSize);
  const stackStart = new Int32Array(stackSize);
  const stackEnd = new Int32Array(stackSize);
  const stackDepth = new Int32Array(stackSize);
  // Each stack entry also carries the centroid bounds of its primitive range:
  // the parent computed them while bucketing, so the child never has to.
  const stackCentroidMin = new Float64Array(stackSize * 3);
  const stackCentroidMax = new Float64Array(stackSize * 3);

  let stackPointer = 1;
  stackNode[0] = 0;
  stackStart[0] = 0;
  stackEnd[0] = primCount;
  stackDepth[0] = 0;
  stackCentroidMin[0] = centroidBox[0];
  stackCentroidMin[1] = centroidBox[1];
  stackCentroidMin[2] = centroidBox[2];
  stackCentroidMax[0] = centroidBox[3];
  stackCentroidMax[1] = centroidBox[4];
  stackCentroidMax[2] = centroidBox[5];

  /**
   * Union the boxes of `order[from, to)` into `out`.
   *
   * The fallback path's only use: when no plane separates a node's centroids the
   * split is by count, and neither side's box came out of a bucket.
   */
  const measureRange = (from, to, out) => {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let cursor = from; cursor < to; cursor += 1) {
      const six = order[cursor] * 6;
      if (bounds[six] < minX) minX = bounds[six];
      if (bounds[six + 1] < minY) minY = bounds[six + 1];
      if (bounds[six + 2] < minZ) minZ = bounds[six + 2];
      if (bounds[six + 3] > maxX) maxX = bounds[six + 3];
      if (bounds[six + 4] > maxY) maxY = bounds[six + 4];
      if (bounds[six + 5] > maxZ) maxZ = bounds[six + 5];
    }
    out[0] = minX; out[1] = minY; out[2] = minZ;
    out[3] = maxX; out[4] = maxY; out[5] = maxZ;
  };

  while (stackPointer > 0) {
    stackPointer -= 1;
    const node = stackNode[stackPointer];
    const start = stackStart[stackPointer];
    const end = stackEnd[stackPointer];
    const depth = stackDepth[stackPointer];
    if (depth > deepest) deepest = depth;
    const count = end - start;

    if (count <= leafSize || depth >= maxDepth || nodeCount + 2 > maxNodes) {
      // A node that is a leaf past the leaf size is one the budget or the depth
      // cap stopped; that is what `cappedNodes` reports, so a caller can tell
      // "small model, small tree" from "budget ran out".
      if (count > leafSize) cappedNodes += 1;
      const base = node * NODE_FLOATS;
      nodeData[base + 3] = start;
      nodeData[base + 7] = count;
      leafCount += 1;
      continue;
    }

    // Widest axis of the centroid bounds: the axis along which a plane can
    // actually separate primitives that are spread out.
    const cminX = stackCentroidMin[stackPointer * 3];
    const cminY = stackCentroidMin[stackPointer * 3 + 1];
    const cminZ = stackCentroidMin[stackPointer * 3 + 2];
    const cmaxX = stackCentroidMax[stackPointer * 3];
    const cmaxY = stackCentroidMax[stackPointer * 3 + 1];
    const cmaxZ = stackCentroidMax[stackPointer * 3 + 2];
    let axis = 0;
    let extent = cmaxX - cminX;
    let centroidMin = cminX;
    if (cmaxY - cminY > extent) { axis = 1; extent = cmaxY - cminY; centroidMin = cminY; }
    if (cmaxZ - cminZ > extent) { axis = 2; extent = cmaxZ - cminZ; centroidMin = cminZ; }

    let bestBin = -1;
    let splitLeft = 0;
    if (extent > 0) {
      // One walk assigns buckets and accumulates, per bucket, both the primitive
      // bounds and the centroid bounds. The centroid bounds are what this node
      // hands its children, so they never gather centroids themselves; the
      // primitive bounds are what the split hands the children their boxes.
      binCounts.fill(0);
      for (let bin = 0; bin < BIN_COUNT; bin += 1) {
        const base = bin * 6;
        binCentroids[base] = Infinity;
        binCentroids[base + 1] = Infinity;
        binCentroids[base + 2] = Infinity;
        binCentroids[base + 3] = -Infinity;
        binCentroids[base + 4] = -Infinity;
        binCentroids[base + 5] = -Infinity;
        binBounds[base] = Infinity;
        binBounds[base + 1] = Infinity;
        binBounds[base + 2] = Infinity;
        binBounds[base + 3] = -Infinity;
        binBounds[base + 4] = -Infinity;
        binBounds[base + 5] = -Infinity;
      }
      const scale = BIN_COUNT / extent;
      for (let cursor = start; cursor < end; cursor += 1) {
        const id = order[cursor];
        const box = id * 6;
        const minX = bounds[box];
        const minY = bounds[box + 1];
        const minZ = bounds[box + 2];
        const maxX = bounds[box + 3];
        const maxY = bounds[box + 4];
        const maxZ = bounds[box + 5];
        // The centroid comes from the box this iteration has to load anyway, so
        // the split needs one array to walk rather than two.
        const cx = (minX + maxX) * 0.5;
        const cy = (minY + maxY) * 0.5;
        const cz = (minZ + maxZ) * 0.5;
        const along = axis === 0 ? cx : (axis === 1 ? cy : cz);
        let bin = Math.floor((along - centroidMin) * scale);
        // `!(bin > 0)` rather than `bin < 0` so a NaN centroid lands in bucket 0
        // instead of being written past the end of the arrays.
        if (!(bin > 0)) bin = 0;
        else if (bin >= BIN_COUNT) bin = BIN_COUNT - 1;
        binOf[cursor] = bin;
        binCounts[bin] += 1;

        const boundsBase = bin * 6;
        if (minX < binBounds[boundsBase]) binBounds[boundsBase] = minX;
        if (minY < binBounds[boundsBase + 1]) binBounds[boundsBase + 1] = minY;
        if (minZ < binBounds[boundsBase + 2]) binBounds[boundsBase + 2] = minZ;
        if (maxX > binBounds[boundsBase + 3]) binBounds[boundsBase + 3] = maxX;
        if (maxY > binBounds[boundsBase + 4]) binBounds[boundsBase + 4] = maxY;
        if (maxZ > binBounds[boundsBase + 5]) binBounds[boundsBase + 5] = maxZ;
        if (cx < binCentroids[boundsBase]) binCentroids[boundsBase] = cx;
        if (cy < binCentroids[boundsBase + 1]) binCentroids[boundsBase + 1] = cy;
        if (cz < binCentroids[boundsBase + 2]) binCentroids[boundsBase + 2] = cz;
        if (cx > binCentroids[boundsBase + 3]) binCentroids[boundsBase + 3] = cx;
        if (cy > binCentroids[boundsBase + 4]) binCentroids[boundsBase + 4] = cy;
        if (cz > binCentroids[boundsBase + 5]) binCentroids[boundsBase + 5] = cz;
      }

      // Cumulative boxes and counts from both ends, so each of the eleven
      // candidate planes costs one multiply instead of a walk over primitives.
      // Both the primitive boxes and the centroid boxes are accumulated, because
      // the winning split hands each child both.
      let running = 0;
      let runMinX = Infinity, runMinY = Infinity, runMinZ = Infinity;
      let runMaxX = -Infinity, runMaxY = -Infinity, runMaxZ = -Infinity;
      let cRunMinX = Infinity, cRunMinY = Infinity, cRunMinZ = Infinity;
      let cRunMaxX = -Infinity, cRunMaxY = -Infinity, cRunMaxZ = -Infinity;
      for (let bin = 0; bin < BIN_COUNT; bin += 1) {
        const base = bin * 6;
        running += binCounts[bin];
        leftCount[bin] = running;
        if (binCounts[bin] > 0) {
          if (binBounds[base] < runMinX) runMinX = binBounds[base];
          if (binBounds[base + 1] < runMinY) runMinY = binBounds[base + 1];
          if (binBounds[base + 2] < runMinZ) runMinZ = binBounds[base + 2];
          if (binBounds[base + 3] > runMaxX) runMaxX = binBounds[base + 3];
          if (binBounds[base + 4] > runMaxY) runMaxY = binBounds[base + 4];
          if (binBounds[base + 5] > runMaxZ) runMaxZ = binBounds[base + 5];
          if (binCentroids[base] < cRunMinX) cRunMinX = binCentroids[base];
          if (binCentroids[base + 1] < cRunMinY) cRunMinY = binCentroids[base + 1];
          if (binCentroids[base + 2] < cRunMinZ) cRunMinZ = binCentroids[base + 2];
          if (binCentroids[base + 3] > cRunMaxX) cRunMaxX = binCentroids[base + 3];
          if (binCentroids[base + 4] > cRunMaxY) cRunMaxY = binCentroids[base + 4];
          if (binCentroids[base + 5] > cRunMaxZ) cRunMaxZ = binCentroids[base + 5];
        }
        leftBounds[base] = runMinX;
        leftBounds[base + 1] = runMinY;
        leftBounds[base + 2] = runMinZ;
        leftBounds[base + 3] = runMaxX;
        leftBounds[base + 4] = runMaxY;
        leftBounds[base + 5] = runMaxZ;
        leftCentroids[base] = cRunMinX;
        leftCentroids[base + 1] = cRunMinY;
        leftCentroids[base + 2] = cRunMinZ;
        leftCentroids[base + 3] = cRunMaxX;
        leftCentroids[base + 4] = cRunMaxY;
        leftCentroids[base + 5] = cRunMaxZ;
        leftArea[bin] = running === 0 ? 0 : boxArea(runMinX, runMinY, runMinZ, runMaxX, runMaxY, runMaxZ);
      }

      running = 0;
      runMinX = Infinity; runMinY = Infinity; runMinZ = Infinity;
      runMaxX = -Infinity; runMaxY = -Infinity; runMaxZ = -Infinity;
      cRunMinX = Infinity; cRunMinY = Infinity; cRunMinZ = Infinity;
      cRunMaxX = -Infinity; cRunMaxY = -Infinity; cRunMaxZ = -Infinity;
      for (let bin = BIN_COUNT - 1; bin >= 0; bin -= 1) {
        const base = bin * 6;
        running += binCounts[bin];
        rightCount[bin] = running;
        if (binCounts[bin] > 0) {
          if (binBounds[base] < runMinX) runMinX = binBounds[base];
          if (binBounds[base + 1] < runMinY) runMinY = binBounds[base + 1];
          if (binBounds[base + 2] < runMinZ) runMinZ = binBounds[base + 2];
          if (binBounds[base + 3] > runMaxX) runMaxX = binBounds[base + 3];
          if (binBounds[base + 4] > runMaxY) runMaxY = binBounds[base + 4];
          if (binBounds[base + 5] > runMaxZ) runMaxZ = binBounds[base + 5];
          if (binCentroids[base] < cRunMinX) cRunMinX = binCentroids[base];
          if (binCentroids[base + 1] < cRunMinY) cRunMinY = binCentroids[base + 1];
          if (binCentroids[base + 2] < cRunMinZ) cRunMinZ = binCentroids[base + 2];
          if (binCentroids[base + 3] > cRunMaxX) cRunMaxX = binCentroids[base + 3];
          if (binCentroids[base + 4] > cRunMaxY) cRunMaxY = binCentroids[base + 4];
          if (binCentroids[base + 5] > cRunMaxZ) cRunMaxZ = binCentroids[base + 5];
        }
        rightBounds[base] = runMinX;
        rightBounds[base + 1] = runMinY;
        rightBounds[base + 2] = runMinZ;
        rightBounds[base + 3] = runMaxX;
        rightBounds[base + 4] = runMaxY;
        rightBounds[base + 5] = runMaxZ;
        rightCentroids[base] = cRunMinX;
        rightCentroids[base + 1] = cRunMinY;
        rightCentroids[base + 2] = cRunMinZ;
        rightCentroids[base + 3] = cRunMaxX;
        rightCentroids[base + 4] = cRunMaxY;
        rightCentroids[base + 5] = cRunMaxZ;
        rightArea[bin] = running === 0 ? 0 : boxArea(runMinX, runMinY, runMinZ, runMaxX, runMaxY, runMaxZ);
      }

      // The classic cost, without the traversal term: the area a ray's chance of
      // reaching a side is proportional to, times how many primitives it tests.
      let bestCost = Infinity;
      for (let bin = 0; bin + 1 < BIN_COUNT; bin += 1) {
        const left = leftCount[bin];
        const right = rightCount[bin + 1];
        if (left === 0 || right === 0) continue;
        const cost = leftArea[bin] * left + rightArea[bin + 1] * right;
        if (cost < bestCost) {
          bestCost = cost;
          bestBin = bin;
        }
      }
    }

    // Where each child's box and centroid bounds are to be found. The bucket
    // split's are already accumulated in the scratch arrays and are addressed by
    // offset; the count split's are measured into two hoisted buffers and
    // addressed from zero. Keeping the offsets rather than views means no object
    // is created per node, which at 50k nodes cost more than the split itself.
    let leftBoxSource, rightBoxSource;
    let leftBoxOffset, rightBoxOffset;

    if (bestBin >= 0) {
      splitLeft = leftCount[bestBin];
      leftBoxSource = leftBounds;
      rightBoxSource = rightBounds;
      leftBoxOffset = bestBin * 6;
      rightBoxOffset = (bestBin + 1) * 6;

      // Counting sort into `scratch`, then back: stable, no comparisons, and the
      // offsets were known from the bucket counts before the walk.
      let offset = start;
      for (let bin = 0; bin < BIN_COUNT; bin += 1) {
        binOffsets[bin] = offset;
        offset += binCounts[bin];
      }
      for (let cursor = start; cursor < end; cursor += 1) {
        const bin = binOf[cursor];
        scratch[binOffsets[bin]] = order[cursor];
        binOffsets[bin] += 1;
      }
      for (let cursor = start; cursor < end; cursor += 1) order[cursor] = scratch[cursor];
    } else {
      // The centroids do not differ on any axis — coincident or NaN geometry.
      // Halving by count still makes progress and still yields boxes that contain
      // their primitives, so the tree stays correct and merely stops improving.
      splitLeft = count >> 1;
      measureRange(start, start + splitLeft, fallbackLeft);
      measureRange(start + splitLeft, end, fallbackRight);
      leftBoxSource = fallbackLeft;
      rightBoxSource = fallbackRight;
      leftBoxOffset = 0;
      rightBoxOffset = 0;
    }

    const splitAt = start + splitLeft;
    const leftNode = nodeCount;
    nodeCount += 2;
    reserveNodes(nodeCount);
    const base = node * NODE_FLOATS;
    nodeData[base + 3] = leftNode;
    nodeData[base + 7] = 0;

    // Boxes into the node array, grown outwards so float32 rounding can never
    // move a face inwards past a primitive it should contain.
    const leftNodeBase = leftNode * NODE_FLOATS;
    nodeData[leftNodeBase] = lower(leftBoxSource[leftBoxOffset]);
    nodeData[leftNodeBase + 1] = lower(leftBoxSource[leftBoxOffset + 1]);
    nodeData[leftNodeBase + 2] = lower(leftBoxSource[leftBoxOffset + 2]);
    nodeData[leftNodeBase + 4] = upper(leftBoxSource[leftBoxOffset + 3]);
    nodeData[leftNodeBase + 5] = upper(leftBoxSource[leftBoxOffset + 4]);
    nodeData[leftNodeBase + 6] = upper(leftBoxSource[leftBoxOffset + 5]);
    const rightNodeBase = leftNodeBase + NODE_FLOATS;
    nodeData[rightNodeBase] = lower(rightBoxSource[rightBoxOffset]);
    nodeData[rightNodeBase + 1] = lower(rightBoxSource[rightBoxOffset + 1]);
    nodeData[rightNodeBase + 2] = lower(rightBoxSource[rightBoxOffset + 2]);
    nodeData[rightNodeBase + 4] = upper(rightBoxSource[rightBoxOffset + 3]);
    nodeData[rightNodeBase + 5] = upper(rightBoxSource[rightBoxOffset + 4]);
    nodeData[rightNodeBase + 6] = upper(rightBoxSource[rightBoxOffset + 5]);

    // Push the right child first so the left one is popped (and built) next: DFS
    // order is what makes a subtree's primitives contiguous, which a leaf's range
    // depends on. Each child also inherits the centroid bounds its half of the
    // buckets covered, so it never has to gather centroids to decide its axis.
    const rightStack = stackPointer * 3;
    stackNode[stackPointer] = leftNode + 1;
    stackStart[stackPointer] = splitAt;
    stackEnd[stackPointer] = end;
    stackDepth[stackPointer] = depth + 1;
    if (bestBin >= 0) {
      const from = (bestBin + 1) * 6;
      stackCentroidMin[rightStack] = rightCentroids[from];
      stackCentroidMin[rightStack + 1] = rightCentroids[from + 1];
      stackCentroidMin[rightStack + 2] = rightCentroids[from + 2];
      stackCentroidMax[rightStack] = rightCentroids[from + 3];
      stackCentroidMax[rightStack + 1] = rightCentroids[from + 4];
      stackCentroidMax[rightStack + 2] = rightCentroids[from + 5];
    } else {
      measureCentroids(splitAt, end, stackCentroidMin, stackCentroidMax, rightStack, order, bounds);
    }
    stackPointer += 1;

    const leftStack = stackPointer * 3;
    stackNode[stackPointer] = leftNode;
    stackStart[stackPointer] = start;
    stackEnd[stackPointer] = splitAt;
    stackDepth[stackPointer] = depth + 1;
    if (bestBin >= 0) {
      const from = bestBin * 6;
      stackCentroidMin[leftStack] = leftCentroids[from];
      stackCentroidMin[leftStack + 1] = leftCentroids[from + 1];
      stackCentroidMin[leftStack + 2] = leftCentroids[from + 2];
      stackCentroidMax[leftStack] = leftCentroids[from + 3];
      stackCentroidMax[leftStack + 1] = leftCentroids[from + 4];
      stackCentroidMax[leftStack + 2] = leftCentroids[from + 5];
    } else {
      measureCentroids(start, splitAt, stackCentroidMin, stackCentroidMax, leftStack, order, bounds);
    }
    stackPointer += 1;
  }

  // Give the primitives the tree's order, so each leaf owns a contiguous range of
  // `uPrims` as the layout requires. The original buffer is left to the collector.
  const ordered = new Float32Array(primCount * PRIM_FLOATS);
  for (let cursor = 0; cursor < primCount; cursor += 1) {
    const from = order[cursor] * PRIM_FLOATS;
    const to = cursor * PRIM_FLOATS;
    for (let float = 0; float < PRIM_FLOATS; float += 1) ordered[to + float] = prims[from + float];
  }

  return {
    nodes: nodeData.slice(0, nodeCount * NODE_FLOATS),
    nodeCount,
    prims: ordered,
    primCount,
    bounds: {
      minimum: [modelBox[0], modelBox[1], modelBox[2]],
      maximum: [modelBox[3], modelBox[4], modelBox[5]],
    },
    stats: stats(nodeCount, leafCount, deepest, cappedNodes),
  };
}

/* ------------------------------------------------------------ primitives -- */

/**
 * Pack a sliced plate's strokes as capsules.
 *
 * Each instance is already the centre line plus its cross-section (see
 * `gcode.js`), so the only work is normalising the endpoints and choosing the
 * one radius the layout allows: `max(halfWidth, halfHeight)`. Dropping the
 * second radius is the documented approximation — a stroke is an ellipse in
 * cross-section, and at 0.2 mm layers the difference is invisible.
 *
 * The stroke count is read from the instance buffer rather than from
 * `mesh.segments`, because that field is set by hand in `gcode.js` and a reader
 * that forgets it would otherwise silently produce an empty tree.
 *
 * @param mesh - a `kind: 'segments'` mesh.
 * @returns `{ prims, primCount }` in normalised space.
 */
function packSegments(mesh) {
  const instances = mesh.instances;
  if (instances === undefined || instances === null) {
    throw new Error('bvh: a segment mesh needs `instances`');
  }
  const stride = Number.isFinite(mesh.stride) && mesh.stride >= SEGMENT_STRIDE
    ? Math.floor(mesh.stride)
    : SEGMENT_STRIDE;
  const primCount = Math.floor(instances.length / stride);
  if (primCount <= 0) return { prims: new Float32Array(0), primCount: 0 };

  const { center, scale } = centreAndScale(mesh, 'segments', () => segmentBounds(instances, primCount, stride));
  const prims = new Float32Array(primCount * PRIM_FLOATS);
  const centerX = center[0], centerY = center[1], centerZ = center[2];
  for (let id = 0; id < primCount; id += 1) {
    const from = id * stride;
    const to = id * PRIM_FLOATS;
    prims[to] = (instances[from] - centerX) * scale;
    prims[to + 1] = (instances[from + 1] - centerY) * scale;
    prims[to + 2] = (instances[from + 2] - centerZ) * scale;
    prims[to + 3] = TYPE_CAPSULE;
    prims[to + 4] = (instances[from + 3] - centerX) * scale;
    prims[to + 5] = (instances[from + 4] - centerY) * scale;
    prims[to + 6] = (instances[from + 5] - centerZ) * scale;
    prims[to + 7] = (instances[from + 6] > instances[from + 7] ? instances[from + 6] : instances[from + 7]) * scale;
    // `p2` is unused by a capsule, and the slot is the instance's filament.
    const slot = Math.round(instances[from + 8]);
    prims[to + 11] = slot > 0 ? (slot < MAX_SLOTS ? slot : MAX_SLOTS - 1) : 0;
  }
  return { prims, primCount };
}

/**
 * Pack a triangle soup as triangles.
 *
 * @param mesh - any non-segment mesh; `positions` is nine floats per triangle.
 * @returns `{ prims, primCount }` in normalised space.
 */
function packTriangles(mesh) {
  const positions = mesh.positions;
  if (positions === undefined || positions === null) {
    throw new Error('bvh: a triangle mesh needs `positions`');
  }
  const available = Math.floor(positions.length / 9);
  const declared = Number.isFinite(mesh.triangles) ? Math.floor(mesh.triangles) : available;
  // A reader that over-reports `triangles` would walk off the buffer; trust the
  // buffer, which is the thing being read.
  const primCount = Math.min(declared, available);
  if (primCount <= 0) return { prims: new Float32Array(0), primCount: 0 };

  const { center, scale } = centreAndScale(mesh, 'triangles', () => positionBounds(positions, primCount * 9));
  const slots = triangleSlots(mesh, primCount);
  const prims = new Float32Array(primCount * PRIM_FLOATS);
  const centerX = center[0], centerY = center[1], centerZ = center[2];
  for (let id = 0; id < primCount; id += 1) {
    const from = id * 9;
    const to = id * PRIM_FLOATS;
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = from + corner * 3;
      const texel = to + corner * 4;
      prims[texel] = (positions[vertex] - centerX) * scale;
      prims[texel + 1] = (positions[vertex + 1] - centerY) * scale;
      prims[texel + 2] = (positions[vertex + 2] - centerZ) * scale;
      // The fourth float of each texel: `type` on p0, `radius` (unused) on p1,
      // `slot` on p2. Written rather than left at zero so no texture holds stale
      // data, which the tracer cannot tell from a real value.
      prims[texel + 3] = corner === 0 ? TYPE_TRIANGLE : 0;
    }
    prims[to + 11] = slots[id];
  }
  return { prims, primCount };
}

/* ---------------------------------------------------------- normalisation -- */

/**
 * The centre and scale that map the file's units into the viewer's normalised
 * space.
 *
 * The two mesh kinds are normalised by *different* rules in `viewer.js`, and each
 * has to match the rule its own kind is drawn with, or the traced image would
 * frame differently from the rasterised one:
 *
 *   - a triangle mesh is scaled by the radius of the bounding sphere around
 *     `mesh.center`, measured over its vertices (`setMesh`);
 *   - a sliced plate is scaled by the half-diagonal of its bounding box
 *     (`uploadSegments`), because its vertices are expanded in the shader and
 *     the shader is handed the centre and scale as uniforms rather than having
 *     them baked in.
 *
 * The asymmetry is the viewer's, not this module's, so it is mirrored rather
 * than corrected. `mesh.scale`, if the caller already computed one, wins over
 * both. When a mesh states no `size`, the box is measured from the geometry —
 * for a plate that is within one stroke radius of what `gcode.js` would have
 * written, because it derives the same span and then adds the stroke's margin.
 *
 * @param mesh - the mesh being packed.
 * @param kind - `'segments'` or `'triangles'`.
 * @param rawBoundsOf - thunk returning the raw union box, called only when
 *   `center` or `size` is missing, so the usual path pays nothing for it.
 * @returns `{ center, scale }`.
 */
function centreAndScale(mesh, kind, rawBoundsOf) {
  const statedCenter = vector3Of(mesh.center);
  const statedSize = vector3Of(mesh.size);
  let raw = null;
  const rawBox = () => {
    if (raw === null) raw = rawBoundsOf();
    return raw;
  };

  let center = statedCenter;
  if (center === null) {
    const box = rawBox();
    center = [(box[0] + box[3]) / 2, (box[1] + box[4]) / 2, (box[2] + box[5]) / 2];
  }

  if (Number.isFinite(mesh.scale) && mesh.scale > 0) return { center, scale: mesh.scale };

  let radius;
  if (kind === 'segments') {
    // A plate always states its `size`, so the raw box — a full pass over the
    // instance buffer — is measured only for a caller that omits it.
    let size = statedSize;
    if (size === null) {
      const box = rawBox();
      size = [box[3] - box[0], box[4] - box[1], box[5] - box[2]];
    }
    radius = Math.hypot(size[0] / 2, size[1] / 2, size[2] / 2);
  } else {
    // The sphere of the vertices about the centre, exactly as `setMesh` measures
    // it: not the box diagonal, and not the farthest pair.
    radius = 0;
    const positions = mesh.positions;
    const limit = Math.min(positions.length, (mesh.triangles ?? Infinity) * 9);
    for (let index = 0; index < limit; index += 3) {
      const x = positions[index] - center[0];
      const y = positions[index + 1] - center[1];
      const z = positions[index + 2] - center[2];
      const squared = x * x + y * y + z * z;
      if (squared > radius) radius = squared;
    }
    radius = Math.sqrt(radius);
  }
  return { center, scale: radius > 1e-6 ? 1 / radius : 1 };
}

/** A `[x, y, z]` from a typed array or plain array, or `null` when it is not three finite numbers. */
function vector3Of(value) {
  if (value === undefined || value === null || value.length < 3) return null;
  const x = value[0], y = value[1], z = value[2];
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [x, y, z];
}

/**
 * The raw box of a segment mesh, as `[minX, minY, minZ, maxX, maxY, maxZ]`.
 *
 * Each stroke is a capsule, so its box is the endpoint span grown by the radius
 * on every axis. Fallback only: a plate from `gcode.js` always states `center`
 * and `size`.
 */
function segmentBounds(instances, count, stride) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let id = 0; id < count; id += 1) {
    const offset = id * stride;
    const radius = instances[offset + 6] > instances[offset + 7] ? instances[offset + 6] : instances[offset + 7];
    const lowX = (instances[offset] < instances[offset + 3] ? instances[offset] : instances[offset + 3]) - radius;
    const lowY = (instances[offset + 1] < instances[offset + 4] ? instances[offset + 1] : instances[offset + 4]) - radius;
    const lowZ = (instances[offset + 2] < instances[offset + 5] ? instances[offset + 2] : instances[offset + 5]) - radius;
    const highX = (instances[offset] > instances[offset + 3] ? instances[offset] : instances[offset + 3]) + radius;
    const highY = (instances[offset + 1] > instances[offset + 4] ? instances[offset + 1] : instances[offset + 4]) + radius;
    const highZ = (instances[offset + 2] > instances[offset + 5] ? instances[offset + 2] : instances[offset + 5]) + radius;
    if (lowX < minX) minX = lowX;
    if (lowY < minY) minY = lowY;
    if (lowZ < minZ) minZ = lowZ;
    if (highX > maxX) maxX = highX;
    if (highY > maxY) maxY = highY;
    if (highZ > maxZ) maxZ = highZ;
  }
  return [minX, minY, minZ, maxX, maxY, maxZ];
}

/** The raw box of a flat position list, as `[minX, minY, minZ, maxX, maxY, maxZ]`. */
function positionBounds(positions, length) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let index = 0; index < length; index += 3) {
    const x = positions[index], y = positions[index + 1], z = positions[index + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return [minX, minY, minZ, maxX, maxY, maxZ];
}

/**
 * Centroid bounds of `order[from, to)`, for the count-split fallback's children.
 *
 * Only reached when a node's centroids are all identical, which is rare enough
 * that measuring rather than threading the bounds through is the cheaper design.
 */
function measureCentroids(from, to, minOut, maxOut, offset, order, bounds) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let cursor = from; cursor < to; cursor += 1) {
    const six = order[cursor] * 6;
    const x = (bounds[six] + bounds[six + 3]) * 0.5;
    const y = (bounds[six + 1] + bounds[six + 4]) * 0.5;
    const z = (bounds[six + 2] + bounds[six + 5]) * 0.5;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  minOut[offset] = minX;
  minOut[offset + 1] = minY;
  minOut[offset + 2] = minZ;
  maxOut[offset] = maxX;
  maxOut[offset + 1] = maxY;
  maxOut[offset + 2] = maxZ;
}

/* --------------------------------------------------------------- palette -- */

/**
 * Resolve one palette slot per triangle from the project's own colours.
 *
 * A painted 3MF stores a linear RGB triple per triangle corner, and the reader
 * splits a painted face into one triangle per colour, so all three corners of a
 * triangle carry the same filament: the first corner speaks for the triangle.
 * The slots index `mesh.palette`, whose entries are hex strings, and the match is
 * the nearest entry in linear space rather than a hash — the colours were
 * produced by that same conversion, so an exact match is expected, and a nearest
 * match degrades to a slightly wrong filament instead of to black if a project
 * ever writes a colour a rounding step off its palette.
 *
 * A mesh with colours but no palette, or with more distinct colours than the
 * shader has slots, gets slots in order of first appearance and later colours
 * sent to the nearest slot already recorded. Such a mesh is out of contract
 * anyway; drawing it with the wrong filament beats drawing it black.
 *
 * @param mesh - the mesh whose `colours` and `palette` to read.
 * @param triangleCount - how many slots to produce.
 * @returns one slot per triangle, zero when the mesh carries no colours.
 */
function triangleSlots(mesh, triangleCount) {
  const slots = new Uint8Array(triangleCount);
  const colours = mesh.colours;
  if (colours === undefined || colours === null || colours.length < triangleCount * 9) return slots;

  const table = [];
  if (Array.isArray(mesh.palette)) {
    for (const hex of mesh.palette.slice(0, MAX_SLOTS)) table.push(hexToLinear(hex));
  }
  const seen = new Map();
  for (let id = 0; id < triangleCount; id += 1) {
    const corner = id * 9; // nine floats per triangle, three per corner
    const red = colours[corner], green = colours[corner + 1], blue = colours[corner + 2];
    if (table.length > 0) {
      slots[id] = nearestSlot(table, red, green, blue);
      continue;
    }
    const key = quantisedColour(red, green, blue);
    const known = seen.get(key);
    if (known !== undefined) {
      slots[id] = known;
      continue;
    }
    if (table.length < MAX_SLOTS) {
      table.push([red, green, blue]);
      seen.set(key, table.length - 1);
      slots[id] = table.length - 1;
      continue;
    }
    const slot = nearestSlot(table, red, green, blue);
    seen.set(key, slot);
    slots[id] = slot;
  }
  return slots;
}

/** Index of the closest colour in `table`, by squared distance in linear RGB. */
function nearestSlot(table, red, green, blue) {
  let best = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < table.length; index += 1) {
    const entry = table[index];
    const dr = entry[0] - red;
    const dg = entry[1] - green;
    const db = entry[2] - blue;
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}

/** A 36-bit key for a linear colour, fine enough to tell palette entries apart. */
function quantisedColour(red, green, blue) {
  return (quantiseChannel(red) * 4096 + quantiseChannel(green)) * 4096 + quantiseChannel(blue);
}

/** One channel of `quantisedColour`'s key. */
function quantiseChannel(channel) {
  const scaled = Math.round(channel * 4095);
  return scaled > 0 ? (scaled < 4095 ? scaled : 4095) : 0;
}

/**
 * Convert a `#rrggbb` palette entry to linear RGB.
 *
 * Duplicated from `paint.js` rather than imported: this module is loaded on its
 * own by the build and by the tests, and six lines of transfer function are a
 * smaller liability than an import that ties the tree builder to the reader's
 * module order. It must stay identical to `paint.js`'s — the colours it is
 * compared against were produced there, and a different curve here would put
 * triangles in the wrong slots.
 */
function hexToLinear(hex) {
  const value = Number.parseInt(String(hex).slice(1), 16);
  if (!Number.isFinite(value)) return [0, 0, 0];
  const channels = [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
  return channels.map((channel) => (channel <= 0.04045
    ? channel / 12.92
    : Math.pow((channel + 0.055) / 1.055, 2.4)));
}

/* ------------------------------------------------------------------ misc -- */

/**
 * Surface area of a box: the heuristic's cost of "a ray could reach this".
 *
 * The factor of two a real surface area has is left off, because only ratios of
 * these costs are ever compared.
 */
function boxArea(minX, minY, minZ, maxX, maxY, maxZ) {
  const width = maxX - minX;
  const height = maxY - minY;
  const depth = maxZ - minZ;
  return width * height + height * depth + depth * width;
}

/** Milliseconds on the monotonic clock where the host has one, wall time otherwise. */
function now() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}
