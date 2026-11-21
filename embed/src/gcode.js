/**
 * A G-code reader for the sliced view.
 *
 * A slicer writes a toolpath as a sequence of moves between layer-change
 * markers. This module replays those moves and records each extruded segment as
 * a *centre line plus its extrusion cross-section* — width, height, filament —
 * rather than as immediate triangles.
 *
 * That split follows how OrcaSlicer draws a sliced plate (see
 * `ToolpathsObjExporter::export_segment` and the segment shaders in libvgcode):
 * one quad per segment, whose four corners are expanded in the vertex shader
 * along the extrusion's own right and up axes, and whose surface is shaded from
 * an *elliptical* normal in the fragment shader, so the stroke reads as a
 * rounded tube rather than a flat sheet. Two triangles per segment instead of a
 * twelve-triangle box leaves the whole plate inside the triangle budget.
 *
 * Supported input: absolute XY and Z (`G90`), relative extrusion (`M83`, the
 * slicer default), `G0`/`G1` moves, and `G2`/`G3` arcs, which Bowden-style
 * printers use heavily. Anything else is skipped rather than guessed at.
 */

/** Default extrusion width, in millimetres, when the file names none. */
const DEFAULT_WIDTH = 0.45;

/** Default layer height, in millimetres, when the file names none. */
const DEFAULT_HEIGHT = 0.2;

/**
 * Cap on emitted segments. Each one costs a quad, so this budget is in
 * segments, not triangles; past it the reader drops the shortest strokes, which
 * thins infill but keeps the shell — the long wall strokes that carry the
 * visible outline.
 */
const SEGMENT_BUDGET = 500000;

/**
 * Split a slicer's per-section `;KEY:value` marker.
 *
 * The slicers this reader targets write their running width and height as
 * `;WIDTH:0.42` and `;HEIGHT:0.2` — colon, no spaces — while the file header
 * states its settings as `; key = value`. Both spellings occur in one file, so
 * both are accepted here.
 * @param line - a comment line.
 * @param key - the setting to match.
 * @returns the value, or `undefined`.
 */
function markerOf(line, key) {
  const match = new RegExp(`^;\\s*${key}\\s*[:=]\\s*(.*)$`).exec(line);
  return match === null ? undefined : match[1].trim();
}

/**
 * Split one `;KEY = value` line out of a comment header.
 * @param line - a comment line.
 * @param key - the setting to match.
 * @returns the value, or `undefined`.
 */
function settingOf(line, key) {
  return markerOf(line, key);
}

/**
 * Parse a slicer's `;#RRGGBB;#RRGGBB` filament list.
 * @param value - the setting's value.
 * @returns normalised colours, in slot order.
 */
function parseColourList(value) {
  return [...value.matchAll(/#([0-9a-fA-F]{6})/g)].map((entry) => `#${entry[1].toLowerCase()}`);
}

/**
 * Read the numeric `PARAM` of a G-code word.
 * @param line - the command line.
 * @param letter - the word's letter.
 * @returns the value, or `undefined` when the word is absent.
 */
function word(line, letter) {
  const match = new RegExp(`(?:^|\\s)${letter}(-?\\d*\\.?\\d+)`).exec(line);
  return match === null ? undefined : Number(match[1]);
}

/**
 * Read the parameters that decide how wide and how tall a segment is.
 *
 * A slicer announces the width and height for the section that follows, so the
 * reader keeps the last one it saw rather than looking it up per feature type;
 * that matches what the printer actually deposits.
 * @param line - the comment or command line.
 * @param state - mutable reader state.
 */
function trackWidth(line, state) {
  const height = settingOf(line, 'HEIGHT');
  if (height !== undefined) {
    const value = Number(height);
    if (Number.isFinite(value) && value > 0) state.layerHeight = value;
  }
  const width = settingOf(line, 'WIDTH');
  if (width !== undefined) {
    const value = Number(width);
    if (Number.isFinite(value) && value > 0) state.width = value;
  }
}

/**
 * Replay a whole program and record one extrusion segment per deposited move.
 *
 * Each segment keeps both endpoints, the extrusion's width and height, and the
 * filament it was printed with. The viewer turns those into four corner
 * vertices per segment and expands them against the current camera, which is how
 * a single quad can present a rounded, correctly sized tube from every angle.
 *
 * @param text - the decoded G-code file.
 * @returns a segment mesh: endpoint pairs, per-segment width and height, and the
 *   filament palette the plate was printed from.
 */
export function parseGcode(text) {
  const lines = text.split('\n');

  // Palette and geometry defaults come from the leading comment block.
  const palette = [];
  const state = {
    x: 0,
    y: 0,
    z: 0,
    e: 0,
    relativeExtrusion: true,
    absolutePositioning: true,
    tool: 0,
    layerHeight: DEFAULT_HEIGHT,
    width: DEFAULT_WIDTH,
    layerZ: Number.NaN,
  };
  /** The printer's bed outline, as the file states it: `x0,y0,x1,y1,...`. */
  let bedOutline = null;
  let printerName;
  let sawPalette = false;
  for (const line of lines) {
    if (!line.startsWith(';')) continue;
    const colours = settingOf(line, 'filament_colour');
    if (colours !== undefined) {
      palette.push(...parseColourList(colours));
      sawPalette = palette.length > 0;
      continue;
    }
    // The bed is stated either as `printable_area` or, by other slicers, as
    // `bed_shape`; both are a flat list of corners in millimetres.
    const outline = settingOf(line, 'printable_area') ?? settingOf(line, 'bed_shape');
    if (outline !== undefined) {
      const points = [...outline.matchAll(/(-?[\d.]+)\s*x\s*(-?[\d.]+)/g)]
        .map((match) => [Number(match[1]), Number(match[2])])
        .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
      if (points.length >= 3) bedOutline = points;
    }
    const printer = settingOf(line, 'printer_model');
    if (printer !== undefined && printer !== '') printerName = printer;
    const firstLayer = settingOf(line, 'first_layer_height');
    if (firstLayer !== undefined) {
      const value = Number(firstLayer);
      if (Number.isFinite(value) && value > 0) state.layerHeight = value;
    }
    // The header names its per-feature widths; the widest one draws the shell.
    const wallWidth = settingOf(line, 'outer_wall_line_width');
    if (wallWidth !== undefined) {
      const value = Number(wallWidth);
      if (Number.isFinite(value) && value > 0) state.width = value;
    }
    // The config block at the tail repeats the palette in a different syntax.
    if (!sawPalette) {
      const configColours = settingOf(line, 'filament_colour');
      if (configColours !== undefined) palette.push(...parseColourList(configColours));
    }
  }
  if (palette.length === 0) palette.push('#9aa4b8');

  /** One deposited stroke: a centre line, its cross-section, and its filament. */
  const segments = [];

  /**
   * Record one extruded move.
   *
   * The slicer's Z is the top of the layer being printed, so the stroke is
   * centred half a layer below it. The first layer must not drop past the bed,
   * hence the clamp that lifts a bottom layer to sit on Z=0.
   */
  const emitSegment = (fromX, fromY, toX, toY, z, width, height) => {
    const dx = toX - fromX;
    const dy = toY - fromY;
    const length = Math.hypot(dx, dy);
    if (!(length > 1e-6)) return;
    const layerHeight = height > 0 ? height : DEFAULT_HEIGHT;
    const top = z;
    const bottom = Math.max(0, z - layerHeight);
    // Centre the tube in the band it occupies rather than hanging it from the
    // slicer's Z, which is the band's top.
    const centreZ = (top + bottom) / 2;
    segments.push({
      ax: fromX,
      ay: fromY,
      az: centreZ,
      bx: toX,
      by: toY,
      bz: centreZ,
      width: width > 0 ? width : DEFAULT_WIDTH,
      height: Math.max(1e-3, top - bottom),
      tool: state.tool,
      length,
      layerZ: top,
    });
  };

  let segmentCount = 0;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith(';')) {
      if (line.includes(';')) trackWidth(line, state);
      continue;
    }
    // A trailing comment may carry the slicer's own width for this section.
    const comment = line.indexOf(';');
    if (comment !== -1) trackWidth(line.slice(comment), state);
    const command = comment === -1 ? line : line.slice(0, comment).trim();
    if (command === '') continue;

    const letter = command[0];
    if (letter === 'G') {
      const code = Number.parseInt(command.slice(1), 10);
      if (code === 90) { state.absolutePositioning = true; continue; }
      if (code === 91) { state.absolutePositioning = false; continue; }
      if (code === 92) {
        const e = word(command, 'E');
        if (e !== undefined) state.e = e;
        continue;
      }
      if (code === 0 || code === 1) {
        const nextX = word(command, 'X');
        const nextY = word(command, 'Y');
        const nextZ = word(command, 'Z');
        const nextE = word(command, 'E');

        const fromX = state.x, fromY = state.y;
        if (nextX !== undefined) state.x = state.absolutePositioning ? nextX : state.x + nextX;
        if (nextY !== undefined) state.y = state.absolutePositioning ? nextY : state.y + nextY;
        if (nextZ !== undefined) {
          state.z = state.absolutePositioning ? nextZ : state.z + nextZ;
          // Layers are numbered by height once the whole file is read: a plate
          // holding several objects prints their first layers in turn, so Z goes
          // 0.2, 0.6, 0.2, 0.6 and counting distinct Z visits would invent a
          // layer per object instead of one per height.
          state.layerZ = state.z;
        }

        let extruded = false;
        if (nextE !== undefined) {
          const delta = state.relativeExtrusion ? nextE : nextE - state.e;
          if (!state.relativeExtrusion) state.e = nextE;
          // Retractions and travels carry no meaningful positive flow.
          extruded = delta > 1e-5;
        }
        if (extruded) {
          emitSegment(fromX, fromY, state.x, state.y, state.z, state.width, state.layerHeight);
          segmentCount += 1;
        }
        continue;
      }
      if (code === 2 || code === 3) {
        readArc(command, state, emitSegment);
        segmentCount += 8;
        continue;
      }
      continue;
    }
    if (letter === 'M') {
      const code = Number.parseInt(command.slice(1), 10);
      if (code === 82) state.relativeExtrusion = false;
      else if (code === 83) state.relativeExtrusion = true;
      continue;
    }
    if (letter === 'T') {
      const tool = Number.parseInt(command.slice(1), 10);
      if (Number.isFinite(tool)) state.tool = tool;
      continue;
    }
  }

  if (segmentCount === 0) throw new Error('gcode: no extruded moves found');

  // Over budget, keep the longest strokes: they carry the visible shell, while
  // the dropped ones are the dense infill that reads as solid fill anyway.
  let kept = segments;
  if (segments.length > SEGMENT_BUDGET) {
    kept = segments
      .slice()
      .sort((a, b) => b.length - a.length)
      .slice(0, SEGMENT_BUDGET);
  }

  // One layer per distinct height, in print order.
  const layerZs = [...new Set(kept.map((segment) => Math.round(segment.layerZ * 1000) / 1000))]
    .sort((a, b) => a - b);
  const mesh = buildSegmentMesh(kept, palette, layerZs);
  // The bed is not geometry the slicer prints: it is the machine the plate sits
  // in, so it travels beside the strokes and the viewer draws it on demand.
  if (bedOutline !== null) {
    const xs = bedOutline.map((point) => point[0]);
    const ys = bedOutline.map((point) => point[1]);
    mesh.bed = {
      outline: bedOutline,
      minimum: [Math.min(...xs), Math.min(...ys)],
      maximum: [Math.max(...xs), Math.max(...ys)],
      name: printerName,
    };
  }
  mesh.dropped = Math.max(0, segments.length - kept.length);
  return mesh;
}

/**
 * Interpolate an arc command into short chords.
 *
 * `I` and `J` give the centre relative to the start, the convention every
 * mainstream slicer shares.
 * @param command - the arc line.
 * @param state - reader state, updated to the arc's end point.
 * @param emit - segment sink.
 */
function readArc(command, state, emit) {
  const isClockwise = command[0] === 'G' && Number.parseInt(command.slice(1), 10) === 2;
  const toX = word(command, 'X');
  const toY = word(command, 'Y');
  const e = word(command, 'E');
  if (toX === undefined || toY === undefined) return;

  const fromX = state.x, fromY = state.y;
  const centreX = fromX + (word(command, 'I') ?? 0);
  const centreY = fromY + (word(command, 'J') ?? 0);
  const radius = Math.hypot(fromX - centreX, fromY - centreY);
  if (!(radius > 1e-6)) {
    state.x = toX;
    state.y = toY;
    return;
  }

  const startAngle = Math.atan2(fromY - centreY, fromX - centreX);
  const endAngle = Math.atan2(toY - centreY, toX - centreX);
  let sweep = endAngle - startAngle;
  // Take the short way round the direction the code asks for.
  if (isClockwise) {
    while (sweep > 0) sweep -= Math.PI * 2;
    while (sweep < -Math.PI * 2) sweep += Math.PI * 2;
  } else {
    while (sweep < 0) sweep += Math.PI * 2;
    while (sweep > Math.PI * 2) sweep -= Math.PI * 2;
  }

  const extruded = e !== undefined && (state.relativeExtrusion ? e > 1e-5 : e > state.e);
  if (!state.relativeExtrusion && e !== undefined) state.e = e;

  // Chords stay under the extrusion width, so the stroke reads as a curve.
  const steps = Math.max(2, Math.min(48, Math.ceil(Math.abs(sweep) * radius / Math.max(0.2, state.width))));
  let lastX = fromX, lastY = fromY;
  for (let step = 1; step <= steps; step += 1) {
    const angle = startAngle + (sweep * step) / steps;
    const x = centreX + Math.cos(angle) * radius;
    const y = centreY + Math.sin(angle) * radius;
    if (extruded) emit(lastX, lastY, x, y, state.z, state.width, state.layerHeight);
    lastX = x;
    lastY = y;
  }
  state.x = toX;
  state.y = toY;
}

/**
 * Pack the strokes into the buffers the segment pipeline consumes.
 *
 * Four vertices per segment, one per corner, sharing the segment's endpoints,
 * half-extents and colour; six indices turn them into two triangles. Repeating
 * the small per-segment payload four times is cheaper than a per-vertex texture
 * fetch at this scale, and it keeps the renderer free of extension checks.
 *
 * @param segments - the strokes to draw.
 * @param palette - the filament colours the strokes used.
 * @returns the segment mesh the viewer consumes.
 */
/**

/**
 * Pack the strokes into the buffers the segment pipeline consumes.
 *
 * One instance per stroke holds the two endpoints, the cross-section half
 * extents and the filament colour; eight ring corners are shared by every
 * instance and drawn by `drawElementsInstanced`. Repeating that payload per
 * vertex instead would cost 384 bytes a stroke, and a 400k-stroke plate would
 * not fit in a browser's buffers.
 *
 * @param segments - the strokes to draw.
 * @param palette - the filament colours the strokes used.
 * @returns the segment mesh the viewer consumes.
 */
function buildSegmentMesh(segments, palette, layerZs) {
  const count = segments.length;
  // aPositionA(3) aPositionB(3) aHalfExtent(2) aColour(3) aLayer(1).
  const stride = 12;
  const instances = new Float32Array(count * stride);

  // Eight ring corners make one stroke's twelve triangles: four longitudinal
  // faces plus the two end caps. x picks right/left, z picks bottom/top, and y
  // picks the start ring (0) or the end ring (1).
  //
  // The corners are the *rectangle's*, not a diamond's. A diamond is what
  // OrcaSlicer uses, and it covers only half its bounding rectangle: adjacent
  // strokes then touch along a single line and leave triangular gaps above and
  // below, through which the layers underneath show at the opposite infill
  // angle. On a dense plate that reads as a lattice of crossing shapes. The
  // rectangle tiles the plate with no gap, which is what a solid layer is.
  // The four corners in perimeter order, so the index buffer's ring walk
  // (0→1→2→3) traces the rectangle rather than crossing it:
  //   0 right-top, 1 right-bottom, 2 left-bottom, 3 left-top
  const ring = new Float32Array([
    1, 0, 1, 1, 0, -1, -1, 0, -1, -1, 0, 1,
    1, 1, 1, 1, 1, -1, -1, 1, -1, -1, 1, 1,
  ]);
  const indices = new Uint16Array([
    0, 4, 5, 0, 5, 1,
    1, 5, 6, 1, 6, 2,
    2, 6, 7, 2, 7, 3,
    3, 7, 4, 3, 4, 0,
    0, 1, 2, 0, 2, 3,
    4, 6, 5, 4, 7, 6,
  ]);

  // Map each distinct height to its layer index, using the same rounding the
  // height list was built with.
  const layerOf = new Map();
  for (let i = 0; i < layerZs.length; i += 1) layerOf.set(Math.round(layerZs[i] * 1000) / 1000, i);

  let minimumX = Infinity, minimumY = Infinity, minimumZ = Infinity;
  let maximumX = -Infinity, maximumY = -Infinity, maximumZ = -Infinity;
  let minimumWidth = Infinity, maximumWidth = 0, minimumHeight = Infinity, maximumHeight = 0;

  for (let index = 0; index < count; index += 1) {
    const segment = segments[index];
    const slot = Math.min(segment.tool, Math.max(0, palette.length - 1));
    const offset = index * stride;
    instances[offset] = segment.ax;
    instances[offset + 1] = segment.ay;
    instances[offset + 2] = segment.az;
    instances[offset + 3] = segment.bx;
    instances[offset + 4] = segment.by;
    instances[offset + 5] = segment.bz;
    instances[offset + 6] = segment.width / 2;
    instances[offset + 7] = segment.height / 2;
    // The slot, not the colour.
    //
    // Baking the RGB into the instance buffer meant a filament's colour could
    // only change by rebuilding the whole buffer -- 78k strokes on an ordinary
    // plate. Storing which slot the stroke belongs to lets a palette edit be a
    // uniform update, and leaves the colours in one place instead of repeated
    // across every segment that uses them.
    instances[offset + 8] = slot;
    instances[offset + 9] = 0;
    instances[offset + 10] = 0;
    instances[offset + 11] = layerOf.get(Math.round(segment.layerZ * 1000) / 1000) ?? 0;

    const halfHeight = segment.height / 2;
    const lowZ = Math.min(segment.az, segment.bz) - halfHeight;
    const highZ = Math.max(segment.az, segment.bz) + halfHeight;
    if (segment.ax < minimumX) minimumX = segment.ax;
    if (segment.bx < minimumX) minimumX = segment.bx;
    if (segment.ax > maximumX) maximumX = segment.ax;
    if (segment.bx > maximumX) maximumX = segment.bx;
    if (segment.ay < minimumY) minimumY = segment.ay;
    if (segment.by < minimumY) minimumY = segment.by;
    if (segment.ay > maximumY) maximumY = segment.ay;
    if (segment.by > maximumY) maximumY = segment.by;
    if (lowZ < minimumZ) minimumZ = lowZ;
    if (highZ > maximumZ) maximumZ = highZ;
    if (segment.width < minimumWidth) minimumWidth = segment.width;
    if (segment.width > maximumWidth) maximumWidth = segment.width;
    if (segment.height < minimumHeight) minimumHeight = segment.height;
    if (segment.height > maximumHeight) maximumHeight = segment.height;
  }

  const margin = Math.max(maximumWidth, maximumHeight) / 2;

  return {
    kind: 'segments',
    instances,
    stride,
    ring,
    indices,
    segments: count,
    triangles: count * 12,
    // What the layer slider scrubs through: the layer count, and the Z of each
    // layer so the viewer can cut the plate at an exact height.
    layerCount: layerZs.length,
    layerZs,
    palette,
    extrude: { minimumWidth, maximumWidth, minimumHeight, maximumHeight },
    minimum: [minimumX - margin, minimumY - margin, minimumZ],
    maximum: [maximumX + margin, maximumY + margin, maximumZ],
    size: [maximumX - minimumX + margin * 2, maximumY - minimumY + margin * 2, maximumZ - minimumZ],
    center: [
      (minimumX + maximumX) / 2,
      (minimumY + maximumY) / 2,
      (minimumZ + maximumZ) / 2,
    ],
  };
}
