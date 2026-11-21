/**
 * Colour decoding for a 3MF project, following the formats BambuStudio and
 * OrcaSlicer write.
 *
 * Two channels decide a triangle's filament:
 *
 * 1. **The part's extruder.** `Metadata/model_settings.config` assigns each
 *    `<part>` a one-based `extruder` slot into the project's `filament_colour`
 *    palette. A part inherits its parent `<object>`'s slot when it declares none.
 * 2. **Per-triangle paint.** A `<triangle paint_color="…">` overrides the part
 *    for that face. The attribute is a hex string read right-to-left as a
 *    bitstream, and a painted face may be split into sub-faces that carry
 *    different extruders.
 */

/** `EnforcerBlockerType::NONE` — a leaf that names no extruder. */
const STATE_NONE = 0;

/**
 * Turn a `paint_color` string into its bitstream.
 *
 * The string is read from its last character to its first, four bits per hex
 * digit, least-significant bit first — the order
 * `FacetsAnnotation::set_triangle_from_string` writes.
 * @param text - the attribute value.
 * @returns the bit array.
 */
export function paintBits(text) {
  const bits = [];
  for (let index = text.length - 1; index >= 0; index -= 1) {
    const digit = parseInt(text[index], 16);
    if (Number.isNaN(digit)) return new Uint8Array(0);
    for (let bit = 0; bit < 4; bit += 1) bits.push((digit >> bit) & 1);
  }
  return Uint8Array.from(bits);
}

/**
 * Read the 4-bit code at a bit index, advancing it.
 * @param bits - flat bit array, LSB-first per nibble.
 * @param cursor - mutable `{ at }` bit cursor.
 * @returns the nibble, or `undefined` when fewer than four bits remain.
 */
function readNibble(bits, cursor) {
  if (cursor.at + 4 > bits.length) return undefined;
  let value = 0;
  for (let offset = 0; offset < 4; offset += 1) value |= bits[cursor.at + offset] << offset;
  cursor.at += 4;
  return value;
}

/**
 * Read a leaf state stored behind the `11` prefix: one nibble of `state - 3`
 * for states 3–17, or `1111` followed by a nibble of `state - 18` above that.
 * @param bits - the triangle's bitstream.
 * @param cursor - mutable bit cursor.
 * @returns the state, or `undefined` when the stream ran out.
 */
function readLeafState(bits, cursor) {
  const nibble = readNibble(bits, cursor);
  if (nibble === undefined) return undefined;
  if (nibble !== 0b1111) return nibble + 3;
  const extended = readNibble(bits, cursor);
  return extended === undefined ? undefined : extended + 18;
}

/** Midpoint of two corner positions. */
function midpoint(p, q) {
  return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
}

/**
 * Split one triangle into its children, mirroring `TriangleSelector::perform_split`.
 *
 * The split is described relative to a *special side*, so the corners are
 * rotated until corner 0 sits on it; a one-side split cuts one edge, a two-side
 * split cuts two, and a three-side split joins all three midpoints around a
 * central triangle.
 * @param corners - the triangle's three corner positions.
 * @param splitSides - how many sides are cut, 1 to 3.
 * @param specialSide - the corner the split starts from.
 * @returns children in child-index order.
 */
function splitTriangle(corners, splitSides, specialSide) {
  const rotated = [
    corners[specialSide],
    corners[(specialSide + 1) % 3],
    corners[(specialSide + 2) % 3],
  ];
  const [a, b, c] = rotated;

  if (splitSides === 1) {
    const m = midpoint(c, b);
    return [[a, b, m], [m, c, a]];
  }
  if (splitSides === 2) {
    const first = midpoint(b, a);
    const second = midpoint(a, c);
    return [[a, first, second], [first, b, second], [b, c, second]];
  }
  const first = midpoint(b, a);
  const second = midpoint(c, b);
  const third = midpoint(a, c);
  return [[a, first, third], [first, b, second], [third, second, c], [first, second, third]];
}

/**
 * Decode one painted triangle into coloured sub-triangles.
 *
 * A leaf code carries its state in the upper two bits for states 0–2, or behind
 * a `11` prefix for states 3 and above. A non-leaf code carries the split-side
 * count in the lower two bits and the special side above it. Children follow
 * depth-first, last child first, which is the order `serialize` writes them.
 *
 * @param bits - the triangle's bitstream.
 * @param corners - the source triangle's three corner positions, in order.
 * @param fallback - the one-based filament to use when a leaf names none.
 * @returns pieces of `{ corners, filament }`; the source triangle when the data is unusable.
 */
export function decodePaintedTriangle(bits, corners, fallback) {
  const cursor = { at: 0 };
  const pieces = [];

  /** Decode one node and everything beneath it. Returns false when the stream ran out. */
  const decodeNode = (triangle) => {
    const code = readNibble(bits, cursor);
    if (code === undefined) return false;
    const splitSides = code & 0b11;

    if (splitSides === 0) {
      const state = (code & 0b1100) === 0b1100
        ? readLeafState(bits, cursor)
        : (code >> 2) & 0b11;
      if (state === undefined) return false;
      pieces.push({ corners: triangle, filament: state === STATE_NONE ? fallback : state });
      return true;
    }

    const specialSide = splitSides === 3 ? 0 : (code >> 2) & 0b11;
    const children = splitTriangle(triangle, splitSides, specialSide);
    // Children are serialized last-first, so they are read back in that order.
    for (let index = splitSides; index >= 0; index -= 1) {
      if (!decodeNode(children[index])) return false;
    }
    return true;
  };

  if (!decodeNode(corners) || pieces.length === 0) return [{ corners, filament: fallback }];
  return pieces;
}

/**
 * Read one `<metadata key="…" value="…"/>` entry from an XML fragment.
 * @param xml - fragment to search.
 * @param key - the metadata key.
 * @returns the value, or `undefined` when the key is absent.
 */
function readKey(xml, key) {
  const match = new RegExp(`<metadata\\s+key="${key}"\\s+value="([^"]*)"`).exec(xml);
  return match === null ? undefined : match[1];
}

/**
 * Parse `Metadata/model_settings.config` into per-part assignments.
 *
 * An `<object>` is an assembly; its `<part>` entries name the volumes that the
 * assembly's components place, and a part's id matches the object id inside the
 * part file it came from.
 * @param xml - the decoded settings file.
 * @returns object id to `{ extruder, parts: part id to { subtype, extruder } }`.
 */
export function readModelSettings(xml) {
  const objects = new Map();
  const objectPattern = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
  let objectMatch;
  while ((objectMatch = objectPattern.exec(xml)) !== null) {
    const objectId = attributesOf(objectMatch[1]).id;
    if (objectId === undefined) continue;
    const body = objectMatch[2];
    const firstPart = body.indexOf('<part');
    const ownXml = firstPart === -1 ? body : body.slice(0, firstPart);
    const ownExtruder = readKey(ownXml, 'extruder');

    const parts = new Map();
    const partPattern = /<part\b([^>]*)>([\s\S]*?)<\/part>/g;
    let partMatch;
    while ((partMatch = partPattern.exec(body)) !== null) {
      const header = attributesOf(partMatch[1]);
      if (header.id === undefined) continue;
      const inner = partMatch[2];
      const extruder = readKey(inner, 'extruder') ?? ownExtruder;
      const entry = {
        subtype: header.subtype ?? 'normal_part',
        extruder: extruder === undefined ? undefined : Number(extruder),
      };
      // One volume can appear twice — as a printable part and as the modifier
      // that shapes another part's infill. The printable entry wins, because the
      // same geometry is what the slicer prints.
      const existing = parts.get(header.id);
      if (existing !== undefined && existing.subtype !== 'modifier_part' && entry.subtype === 'modifier_part') continue;
      parts.set(header.id, entry);
    }
    objects.set(objectId, {
      extruder: ownExtruder === undefined ? undefined : Number(ownExtruder),
      parts,
    });
  }
  return objects;
}

/** Parse the attributes of one XML tag, keeping namespace prefixes. */
function attributesOf(tag) {
  const result = {};
  const pattern = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let match;
  while ((match = pattern.exec(tag)) !== null) result[match[1]] = match[2];
  return result;
}

/**
 * Parse the filament palette from `Metadata/project_settings.config`, which is
 * JSON with trailing commas that a strict parser rejects.
 * @param text - the decoded settings file.
 * @returns one `#rrggbb` per slot, in slot order; empty when the file names none.
 */
export function readPalette(text) {
  const match = /"filament_colour"\s*:\s*\[([\s\S]*?)\]/.exec(text);
  if (match === null) return [];
  return [...match[1].matchAll(/#([0-9a-fA-F]{6,8})/g)].map((entry) => `#${entry[1].slice(0, 6).toLowerCase()}`);
}

/**
 * Convert a `#rrggbb` colour to linear RGB.
 *
 * A hex colour is sRGB, which is gamma-encoded for display. The shader does its
 * lighting in linear light and encodes on the way out, so a colour handed to it
 * unconverted is treated as brighter than it is: the error is largest exactly
 * where it is most visible, at the dark end. A `#0d0a0a` filament arrived as
 * 0.05 linear when its true value is 0.004 -- twelve times too bright -- so a
 * black print rendered as grey, and the small hue difference in the low bits
 * (13, 10, 10) was amplified into a visible red cast.
 *
 * The transfer function is the sRGB one, not a plain 2.2 power, because that is
 * what the file states and what the display inverts.
 */
export function hexToRgb(hex) {
  const value = parseInt(hex.slice(1), 16);
  const channels = [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
  return channels.map((channel) => (channel <= 0.04045
    ? channel / 12.92
    : Math.pow((channel + 0.055) / 1.055, 2.4)));
}

/** The colour used when a project names no palette, or when a slot is out of range. */
export const FALLBACK_COLOUR = [0.60, 0.66, 0.80].map((channel) => (channel <= 0.04045
  ? channel / 12.92
  : Math.pow((channel + 0.055) / 1.055, 2.4)));
