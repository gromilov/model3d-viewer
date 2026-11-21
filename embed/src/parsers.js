/**
 * Model readers for the 3D viewer: raw DEFLATE, the ZIP container, binary and
 * ASCII STL, and the 3MF package. Nothing here touches the DOM, so the same
 * code runs in the browser bundle and under Node for tests.
 *
 * A parsed mesh is `{ positions, normals, triangles, size }` where the buffers
 * are flat triangle soup (nine floats per triangle, one face normal repeated
 * per corner), which is what the viewer uploads to the GPU unchanged. A 3MF
 * project that names a filament per face also carries `colours`, the same
 * length as `positions`, plus the palette it resolved them from.
 */

import {
  decodePaintedTriangle,
  hexToRgb,
  paintBits,
  readModelSettings,
  readPalette,
  FALLBACK_COLOUR,
} from './paint.js';
import { parseGcode } from './gcode.js';

/* ---------------------------------------------------------------- inflate -- */

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** Build canonical Huffman decoding tables from a list of code lengths. */
function buildHuffman(lengths) {
  let maxBits = 0;
  for (const len of lengths) if (len > maxBits) maxBits = len;
  const counts = new Uint16Array(maxBits + 1);
  for (const len of lengths) if (len !== 0) counts[len] += 1;
  const offsets = new Uint16Array(maxBits + 2);
  for (let bits = 1; bits <= maxBits; bits += 1) offsets[bits + 1] = offsets[bits] + counts[bits];
  const symbols = new Uint16Array(lengths.length);
  for (let symbol = 0; symbol < lengths.length; symbol += 1) {
    const len = lengths[symbol];
    if (len !== 0) symbols[offsets[len]++] = symbol;
  }
  return { counts, symbols, maxBits };
}

/** Inflate a raw DEFLATE stream (RFC 1951), without a zlib or gzip wrapper. */
export function inflateRaw(source) {
  const input = source instanceof Uint8Array ? source : new Uint8Array(source);
  let output = new Uint8Array(Math.max(1024, input.length * 4));
  let outputLength = 0;
  let position = 0;
  let bitBuffer = 0;
  let bitCount = 0;

  const reserve = (extra) => {
    if (outputLength + extra <= output.length) return;
    let capacity = output.length;
    while (capacity < outputLength + extra) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(output.subarray(0, outputLength));
    output = grown;
  };

  const bits = (count) => {
    while (bitCount < count) {
      if (position >= input.length) throw new Error('inflate: unexpected end of stream');
      bitBuffer |= input[position++] << bitCount;
      bitCount += 8;
    }
    const value = bitBuffer & ((1 << count) - 1);
    bitBuffer >>>= count;
    bitCount -= count;
    return value;
  };

  const decode = (table) => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let length = 1; length <= table.maxBits; length += 1) {
      code |= bits(1);
      const count = table.counts[length];
      if (code - first < count) return table.symbols[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('inflate: invalid Huffman code');
  };

  const inflateBlock = (literalTable, distanceTable) => {
    for (;;) {
      const symbol = decode(literalTable);
      if (symbol < 256) {
        reserve(1);
        output[outputLength++] = symbol;
        continue;
      }
      if (symbol === 256) return;
      const lengthIndex = symbol - 257;
      if (lengthIndex >= LENGTH_BASE.length) throw new Error('inflate: bad length symbol');
      const length = LENGTH_BASE[lengthIndex] + bits(LENGTH_EXTRA[lengthIndex]);
      const distanceSymbol = decode(distanceTable);
      if (distanceSymbol >= DIST_BASE.length) throw new Error('inflate: bad distance symbol');
      const distance = DIST_BASE[distanceSymbol] + bits(DIST_EXTRA[distanceSymbol]);
      if (distance > outputLength) throw new Error('inflate: distance before start of output');
      reserve(length);
      for (let index = 0; index < length; index += 1) {
        output[outputLength] = output[outputLength - distance];
        outputLength += 1;
      }
    }
  };

  let finalBlock = 0;
  while (finalBlock === 0) {
    finalBlock = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitBuffer = 0;
      bitCount = 0;
      if (position + 4 > input.length) throw new Error('inflate: truncated stored block header');
      const length = input[position] | (input[position + 1] << 8);
      const complement = input[position + 2] | (input[position + 3] << 8);
      position += 4;
      if ((length ^ 0xffff) !== complement) throw new Error('inflate: stored block length mismatch');
      if (position + length > input.length) throw new Error('inflate: truncated stored block');
      reserve(length);
      output.set(input.subarray(position, position + length), outputLength);
      outputLength += length;
      position += length;
    } else if (type === 1) {
      const literalLengths = new Uint8Array(288);
      literalLengths.fill(8, 0, 144);
      literalLengths.fill(9, 144, 256);
      literalLengths.fill(7, 256, 280);
      literalLengths.fill(8, 280, 288);
      const distanceLengths = new Uint8Array(30).fill(5);
      inflateBlock(buildHuffman(literalLengths), buildHuffman(distanceLengths));
    } else if (type === 2) {
      const literalCount = bits(5) + 257;
      const distanceCount = bits(5) + 1;
      const codeLengthCount = bits(4) + 4;
      const codeLengthLengths = new Uint8Array(19);
      for (let index = 0; index < codeLengthCount; index += 1) {
        codeLengthLengths[CODE_LENGTH_ORDER[index]] = bits(3);
      }
      const codeLengthTable = buildHuffman(codeLengthLengths);
      const lengths = new Uint8Array(literalCount + distanceCount);
      let filled = 0;
      while (filled < lengths.length) {
        const symbol = decode(codeLengthTable);
        if (symbol < 16) {
          lengths[filled++] = symbol;
        } else if (symbol === 16) {
          if (filled === 0) throw new Error('inflate: repeat with no previous length');
          const previous = lengths[filled - 1];
          const repeat = 3 + bits(2);
          for (let index = 0; index < repeat; index += 1) lengths[filled++] = previous;
        } else if (symbol === 17) {
          filled += 3 + bits(3);
        } else {
          filled += 11 + bits(7);
        }
      }
      if (filled > lengths.length) throw new Error('inflate: code lengths overrun');
      inflateBlock(
        buildHuffman(lengths.subarray(0, literalCount)),
        buildHuffman(lengths.subarray(literalCount)),
      );
    } else {
      throw new Error('inflate: reserved block type');
    }
  }

  return output.subarray(0, outputLength);
}

/* -------------------------------------------------------------------- zip -- */

const utf8 = new TextDecoder('utf-8');

/** Read a little-endian 16-bit value. */
function u16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

/** Read a little-endian 32-bit value. */
function u32(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

/**
 * Read every entry of a ZIP archive into memory, decompressed.
 * @param bytes - complete archive bytes.
 * @returns entry name to contents; directory entries are omitted.
 */
export function readZip(bytes) {
  let endOfCentral = -1;
  for (let offset = bytes.length - 22; offset >= 0 && offset >= bytes.length - 65558; offset -= 1) {
    if (u32(bytes, offset) === 0x06054b50) {
      endOfCentral = offset;
      break;
    }
  }
  if (endOfCentral < 0) throw new Error('zip: end of central directory not found');
  const entryCount = u16(bytes, endOfCentral + 10);
  const directoryOffset = u32(bytes, endOfCentral + 16);
  const entries = new Map();
  let cursor = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (u32(bytes, cursor) !== 0x02014b50) throw new Error('zip: bad central directory header');
    const method = u16(bytes, cursor + 10);
    const compressedSize = u32(bytes, cursor + 20);
    const nameLength = u16(bytes, cursor + 28);
    const extraLength = u16(bytes, cursor + 30);
    const commentLength = u16(bytes, cursor + 32);
    const localOffset = u32(bytes, cursor + 42);
    const name = utf8.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if (u32(bytes, localOffset) !== 0x04034b50) throw new Error(`zip: bad local header for ${name}`);
    const dataStart = localOffset + 30 + u16(bytes, localOffset + 26) + u16(bytes, localOffset + 28);
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) entries.set(name, raw);
    else if (method === 8) entries.set(name, inflateRaw(raw));
    else throw new Error(`zip: unsupported compression method ${method}`);
  }
  return entries;
}

/* -------------------------------------------------------------------- stl -- */

/** Whether an STL payload is the binary layout rather than ASCII text. */
function isBinaryStl(bytes) {
  if (bytes.length < 84) return false;
  if (bytes.length === 84 + u32(bytes, 80) * 50) return true;
  const head = utf8.decode(bytes.subarray(0, Math.min(5, bytes.length)));
  return head !== 'solid';
}

/**
 * Parse an STL payload, binary or ASCII.
 * @param bytes - complete file bytes.
 * @returns flat positions and per-corner face normals.
 */
export function parseStl(bytes) {
  if (isBinaryStl(bytes)) {
    const count = u32(bytes, 80);
    const positions = new Float32Array(count * 9);
    const normals = new Float32Array(count * 9);
    let cursor = 84;
    for (let triangle = 0; triangle < count; triangle += 1) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + cursor, 50);
      const nx = view.getFloat32(0, true);
      const ny = view.getFloat32(4, true);
      const nz = view.getFloat32(8, true);
      for (let corner = 0; corner < 3; corner += 1) {
        const base = triangle * 9 + corner * 3;
        positions[base] = view.getFloat32(12 + corner * 12, true);
        positions[base + 1] = view.getFloat32(16 + corner * 12, true);
        positions[base + 2] = view.getFloat32(20 + corner * 12, true);
        normals[base] = nx;
        normals[base + 1] = ny;
        normals[base + 2] = nz;
      }
      cursor += 50;
    }
    return finishMesh(positions, normals, count);
  }
  return parseAsciiStl(utf8.decode(bytes));
}

/** Parse the textual STL dialect emitted by some exporters. */
function parseAsciiStl(text) {
  const coordinates = [];
  const pattern = /vertex\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    coordinates.push(Number(match[1]), Number(match[2]), Number(match[3]));
  }
  const count = Math.floor(coordinates.length / 9);
  const positions = new Float32Array(coordinates.slice(0, count * 9));
  return finishMesh(positions, new Float32Array(count * 9), count);
}

/* -------------------------------------------------------------------- 3mf -- */

/**
 * Parse the attributes of one XML tag into an object keyed by attribute name.
 * Namespaced names such as `p:path` keep their prefix, since the prefix is what
 * distinguishes a component's cross-part reference from its local one.
 */
function attributes(tag) {
  const result = {};
  const pattern = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let match;
  while ((match = pattern.exec(tag)) !== null) result[match[1]] = match[2];
  return result;
}

/** Turn the twelve values of a 3MF transform into a row-major 4×4 matrix. */
function transformMatrix(value) {
  if (value === undefined) return null;
  const parts = value.trim().split(/\s+/).map(Number);
  if (parts.length !== 12 || parts.some((part) => !Number.isFinite(part))) return null;
  return [
    parts[0], parts[1], parts[2], 0,
    parts[3], parts[4], parts[5], 0,
    parts[6], parts[7], parts[8], 0,
    parts[9], parts[10], parts[11], 1,
  ];
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Multiply two row-major 4×4 matrices, applying `b` after `a`. */
function multiplyMatrix(a, b) {
  const result = new Array(16);
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      let sum = 0;
      for (let index = 0; index < 4; index += 1) sum += a[row * 4 + index] * b[index * 4 + column];
      result[row * 4 + column] = sum;
    }
  }
  return result;
}

/**
 * Read the objects of one 3MF model part.
 * @param xml - decoded part contents.
 * @returns object id to its mesh, components, and own transform.
 */
function readModelPart(xml) {
  const objects = new Map();
  const objectPattern = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
  let objectMatch;
  while ((objectMatch = objectPattern.exec(xml)) !== null) {
    const header = attributes(objectMatch[1]);
    const id = header.id;
    if (id === undefined) continue;
    const body = objectMatch[2];
    const meshMatch = /<mesh>([\s\S]*?)<\/mesh>/.exec(body);
    const vertices = [];
    const triangles = [];
    /** Triangle index to its `paint_color` attribute, for the faces that carry one. */
    const paints = new Map();
    if (meshMatch !== null) {
      const vertexBlock = /<vertices>([\s\S]*?)<\/vertices>/.exec(meshMatch[1]);
      if (vertexBlock !== null) {
        const vertexPattern = /<vertex\b([^>]*)\/?>/g;
        let vertexToken;
        while ((vertexToken = vertexPattern.exec(vertexBlock[1])) !== null) {
          const value = attributes(vertexToken[1]);
          vertices.push(Number(value.x ?? 0), Number(value.y ?? 0), Number(value.z ?? 0));
        }
      }
      const triangleBlock = /<triangles>([\s\S]*?)<\/triangles>/.exec(meshMatch[1]);
      if (triangleBlock !== null) {
        const trianglePattern = /<triangle\b([^>]*)\/?>/g;
        let triangleToken;
        let triangleIndex = 0;
        while ((triangleToken = trianglePattern.exec(triangleBlock[1])) !== null) {
          const value = attributes(triangleToken[1]);
          triangles.push(Number(value.v1), Number(value.v2), Number(value.v3));
          // A painted face overrides its part's extruder; the attribute is sparse.
          if (value.paint_color !== undefined) paints.set(triangleIndex, value.paint_color);
          triangleIndex += 1;
        }
      }
    }
    const components = [];
    const componentPattern = /<component\b([^>]*)\/?>/g;
    let componentToken;
    while ((componentToken = componentPattern.exec(body)) !== null) {
      const value = attributes(componentToken[1]);
      if (value.objectid === undefined) continue;
      components.push({
        objectId: value.objectid,
        part: value['p:path'],
        matrix: transformMatrix(value.transform),
      });
    }
    objects.set(id, {
      vertices: Float32Array.from(vertices),
      triangles,
      paints,
      components,
      matrix: transformMatrix(header.transform),
    });
  }
  return objects;
}

/**
 * Parse a 3MF package: resolve its object tree, apply build transforms, and
 * flatten everything into one triangle soup.
 *
 * A production-extension package keeps each object in its own `.model` part
 * referenced by `p:path`, so every part is indexed before anything is emitted
 * and a component's part prefix selects which index its `objectid` names.
 * @param bytes - complete package bytes.
 * @returns flat positions and per-corner face normals.
 */
export function parse3mf(bytes) {
  const entries = readZip(bytes);
  const partNames = [...entries.keys()].filter((name) => /\.model$/i.test(name));
  if (partNames.length === 0) throw new Error('3mf: no 3D model part in the package');

  // Index every part under both its archive name and its `/`-rooted form, since a
  // `p:path` is written absolute while an archive entry name never is.
  const parts = new Map();
  for (const name of partNames) {
    const objects = readModelPart(utf8.decode(entries.get(name)));
    parts.set(name, objects);
    parts.set(`/${name}`, objects);
  }
  const mainName = partNames.find((name) => /(^|\/)3dmodel\.model$/i.test(name)) ?? partNames[0];
  const mainObjects = parts.get(mainName);

  // Colour channels: the project palette, and per-part extruder assignments.
  const settingsText = entries.has('Metadata/model_settings.config')
    ? utf8.decode(entries.get('Metadata/model_settings.config'))
    : '';
  const settings = readModelSettings(settingsText);
  const paletteText = entries.has('Metadata/project_settings.config')
    ? utf8.decode(entries.get('Metadata/project_settings.config'))
    : '';
  const palette = readPalette(paletteText);

  const positions = [];
  const colours = [];
  const emitted = { count: 0, coloured: 0 };
  const visiting = new Set();

  /** Resolve a one-based extruder slot to a normalised colour. */
  const colourOf = (extruder) => {
    if (extruder === undefined) return FALLBACK_COLOUR;
    const hex = palette[extruder - 1];
    return hex === undefined ? FALLBACK_COLOUR : hexToRgb(hex);
  };

  /**
   * Emit every coloured piece of one object, applying a transform to all of them.
   *
   * @param objects - the part index that owns `id`.
   * @param id - the object id inside that part.
   * @param matrix - accumulated transform.
   * @param settingsOf - the settings entry naming this object's parts, if any.
   */
  const emitObject = (objects, id, matrix, settingsOf) => {
    if (objects === undefined) return;
    const object = objects.get(id);
    if (object === undefined) return;
    const key = `${id}:${matrix}`;
    if (visiting.has(key)) return;
    visiting.add(key);

    for (const component of object.components) {
      const target = component.part === undefined
        ? objects
        : parts.get(component.part) ?? parts.get(component.part.replace(/^\//, ''));
      emitObject(target, component.objectId, multiplyMatrix(component.matrix ?? IDENTITY, matrix), settingsOf);
    }

    if (object.triangles.length > 0) {
      const part = settingsOf?.parts.get(id);
      // A modifier volume shapes another volume's infill; it is not a surface.
      if (part?.subtype !== 'modifier_part') {
        emitMeshWithColour(object, matrix, colourOf(part?.extruder ?? settingsOf?.extruder), {
          positions,
          colours,
          emitted,
          colourOfSlot: colourOf,
        });
      }
    }
    visiting.delete(key);
  };

  // The build section names what appears on the plate. Its `objectid` names an
  // assembly in the main part, whose settings entry carries the parts.
  const buildBlock = /<build>([\s\S]*?)<\/build>/.exec(utf8.decode(entries.get(mainName)));
  let placed = 0;
  if (buildBlock !== null) {
    const itemPattern = /<item\b([^>]*)\/?>/g;
    let itemToken;
    while ((itemToken = itemPattern.exec(buildBlock[1])) !== null) {
      const value = attributes(itemToken[1]);
      if (value.objectid === undefined) continue;
      emitObject(mainObjects, value.objectid, transformMatrix(value.transform) ?? IDENTITY, settings.get(value.objectid));
      placed += 1;
    }
  }
  if (placed === 0) {
    for (const id of mainObjects.keys()) emitObject(mainObjects, id, IDENTITY, settings.get(id));
  }
  if (emitted.count === 0) throw new Error('3mf: no triangles in the model part');

  const mesh = finishMesh(new Float32Array(positions), new Float32Array(emitted.count * 9), emitted.count);
  if (emitted.coloured > 0) mesh.colours = new Float32Array(colours);
  mesh.palette = palette;

  // A project saved after slicing embeds the plate's G-code beside the model;
  // that turns the tab into a two-view surface.
  const gcodeName = [...entries.keys()].find((name) => /Metadata\/plate_\d+\.gcode$/i.test(name))
    ?? [...entries.keys()].find((name) => /\.gcode$/i.test(name));
  if (gcodeName !== undefined) {
    try {
      return { mesh, sliced: parseGcode(utf8.decode(entries.get(gcodeName))) };
    } catch {
      // A G-code part the reader cannot replay leaves the model alone.
    }
  }
  return mesh;
}

/**
 * Append one object's triangles, decoding each painted face into coloured pieces.
 *
 * A painted face can split into several sub-faces of different filaments, so the
 * emitted triangle count is not the source count; `emitted.count` tracks it.
 * @param object - the object's mesh and its per-triangle paint map.
 * @param matrix - accumulated transform.
 * @param baseColour - the part's colour, used for unpainted and unpainted-leaf faces.
 * @param out - the flat position, colour, and counter accumulators.
 */
function emitMeshWithColour(object, matrix, baseColour, out) {
  const { vertices, triangles, paints } = object;
  const push = (corners, colour) => {
    for (const corner of corners) {
      out.positions.push(
        corner[0] * matrix[0] + corner[1] * matrix[4] + corner[2] * matrix[8] + matrix[12],
        corner[0] * matrix[1] + corner[1] * matrix[5] + corner[2] * matrix[9] + matrix[13],
        corner[0] * matrix[2] + corner[1] * matrix[6] + corner[2] * matrix[10] + matrix[14],
      );
      out.colours.push(colour[0], colour[1], colour[2]);
    }
    out.emitted.count += 1;
  };

  for (let index = 0; index + 2 < triangles.length; index += 3) {
    const corners = [0, 1, 2].map((corner) => {
      const vertex = triangles[index + corner] * 3;
      return [vertices[vertex], vertices[vertex + 1], vertices[vertex + 2]];
    });

    const paint = paints.get(index / 3);
    if (paint === undefined) {
      push(corners, baseColour);
      continue;
    }

    // A leaf that names no filament keeps the part's own colour.
    const pieces = decodePaintedTriangle(paintBits(paint), corners, 0);
    for (const piece of pieces) {
      push(piece.corners, piece.filament === 0 ? baseColour : out.colourOfSlot(piece.filament));
    }
    out.emitted.coloured += pieces.length;
  }
}

/** Append one object's transformed triangles to the flat position list. */
function emitMesh(vertices, triangles, matrix, positions, emitted) {
  for (let index = 0; index + 2 < triangles.length; index += 3) {
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = triangles[index + corner] * 3;
      const x = vertices[vertex];
      const y = vertices[vertex + 1];
      const z = vertices[vertex + 2];
      positions.push(
        x * matrix[0] + y * matrix[4] + z * matrix[8] + matrix[12],
        x * matrix[1] + y * matrix[5] + z * matrix[9] + matrix[13],
        x * matrix[2] + y * matrix[6] + z * matrix[10] + matrix[14],
      );
    }
    emitted.count += 1;
  }
}

/* ------------------------------------------------------------------ mesh -- */

/** Compute face normals, bounds, and summary statistics for a triangle soup. */
export function finishMesh(positions, normals, triangleCount) {
  if (triangleCount === 0) {
    // An empty mesh still needs finite bounds: the viewer divides by the radius.
    return {
      positions,
      normals,
      triangles: 0,
      minimum: [0, 0, 0],
      maximum: [0, 0, 0],
      size: [0, 0, 0],
      center: [0, 0, 0],
    };
  }
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < triangleCount * 9; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[index + axis];
      if (value < minimum[axis]) minimum[axis] = value;
      if (value > maximum[axis]) maximum[axis] = value;
    }
  }
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const base = triangle * 9;
    const ax = positions[base], ay = positions[base + 1], az = positions[base + 2];
    const bx = positions[base + 3], by = positions[base + 4], bz = positions[base + 5];
    const cx = positions[base + 6], cy = positions[base + 7], cz = positions[base + 8];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    if (length > 1e-12) { nx /= length; ny /= length; nz /= length; } else { nx = 0; ny = 0; nz = 1; }
    for (let corner = 0; corner < 3; corner += 1) {
      const offset = base + corner * 3;
      normals[offset] = nx;
      normals[offset + 1] = ny;
      normals[offset + 2] = nz;
    }
  }
  const size = [maximum[0] - minimum[0], maximum[1] - minimum[1], maximum[2] - minimum[2]];
  return {
    positions,
    normals,
    triangles: triangleCount,
    minimum,
    maximum,
    size,
    center: [
      (minimum[0] + maximum[0]) / 2,
      (minimum[1] + maximum[1]) / 2,
      (minimum[2] + maximum[2]) / 2,
    ],
  };
}

/**
 * Read a model by file extension.
 * @param path - the file path, used only for its suffix.
 * @param bytes - complete file bytes.
 * @returns the parsed mesh.
 */
export function parseModel(path, bytes) {
  const lower = path.toLowerCase();
  if (lower.endsWith('.stl')) return parseStl(bytes);
  if (lower.endsWith('.3mf')) return parse3mf(bytes);
  if (lower.endsWith('.gcode')) return parseGcode(utf8.decode(bytes));
  throw new Error(`model3d: unsupported file type "${path}"`);
}
