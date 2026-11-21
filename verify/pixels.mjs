#!/usr/bin/env node
/**
 * PNG decoding and pixel statistics for screenshot verification.
 *
 * Why hand-rolled: this harness has to run on a machine with no network and no
 * installed packages (no npm install, no ImageMagick, no Pillow), and invoking
 * `sips`/`python3` from a Node script would make results depend on another
 * process's version and output formatting. A PNG decoder for the subset Chrome
 * emits is ~200 lines: 8-bit RGB/RGBA, zlib-deflated IDAT, five filter types.
 * We keep support for the other legal colour types anyway so a screenshot
 * produced by some other pipeline does not fail with a confusing error.
 *
 * All luminance values and thresholds in this module are on the 0..255 scale of
 * the stored samples, not 0..1, so they line up with what a PNG viewer's
 * colour picker shows and with CLI `--above 180` style arguments.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * CRC table for zlib's CRC-32. Node 20+ exposes `zlib.crc32`, but chunk
 * verification is cheap and this keeps the decoder usable on older runtimes
 * without a feature probe.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Undo one scanline's filter. `prior` is the already-unfiltered previous row;
 * PNG filters reference the byte `bpp` bytes to the left, so a per-byte loop is
 * both correct and unavoidable.
 */
function unfilterRow(filter, row, prior, bpp) {
  const n = row.length;
  switch (filter) {
    case 0:
      return row;
    case 1:
      for (let i = bpp; i < n; i += 1) row[i] = (row[i] + row[i - bpp]) & 0xff;
      return row;
    case 2:
      for (let i = 0; i < n; i += 1) row[i] = (row[i] + prior[i]) & 0xff;
      return row;
    case 3:
      for (let i = 0; i < n; i += 1) {
        const left = i >= bpp ? row[i - bpp] : 0;
        row[i] = (row[i] + ((left + prior[i]) >> 1)) & 0xff;
      }
      return row;
    case 4:
      for (let i = 0; i < n; i += 1) {
        const a = i >= bpp ? row[i - bpp] : 0;
        const b = prior[i];
        const c = i >= bpp ? prior[i - bpp] : 0;
        // Paeth picks whichever neighbour is closest to a+b-c; ties go left,
        // then above, matching the reference implementation.
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        row[i] = (row[i] + pred) & 0xff;
      }
      return row;
    default:
      throw new Error(`PNG: unknown scanline filter ${filter}`);
  }
}

/** Read one channel sample for pixel `x` from an unfiltered scanline. */
function readSample(row, x, channel, channels, bitDepth) {
  const index = x * channels + channel;
  if (bitDepth === 8) return row[index];
  if (bitDepth === 16) return row[index * 2]; // High byte is the visually significant one.
  const bitOffset = index * bitDepth;
  const byte = row[bitOffset >> 3];
  const shift = 8 - bitDepth - (bitOffset & 7);
  // Sub-byte greyscale stores a fraction of full white, not a raw value; callers
  // that need the literal index (palette images) use readIndex instead.
  const max = (1 << bitDepth) - 1;
  return Math.round((((byte >> shift) & max) * 255) / max);
}

/**
 * Read a sub-8-bit sample as its literal stored value, which is what a palette
 * image needs: index 3 must map to palette entry 3, not to 85.
 */
function readIndex(row, x, bitDepth) {
  if (bitDepth === 8) return row[x];
  const bitOffset = x * bitDepth;
  const byte = row[bitOffset >> 3];
  const shift = 8 - bitDepth - (bitOffset & 7);
  return (byte >> shift) & ((1 << bitDepth) - 1);
}

/**
 * Decode a PNG buffer into 8-bit RGBA.
 *
 * `data` is RGBA, 4 bytes per pixel, whatever the stored colour type was, so
 * callers never branch on colour type. `storedOpaqueFraction` is the share of
 * pixels whose alpha byte in the *file* is 255 — it distinguishes a plain RGB
 * screenshot (always 1.0) from an RGBA one that happens to be fully opaque.
 * Interlaced PNGs are rejected: Chrome never writes them, and silently
 * mis-decoding would be worse.
 */
export function decodePng(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('PNG: missing 8-byte signature (not a PNG file)');
  }

  let offset = 8;
  let header = null;
  let palette = null;
  let transparency = null;
  const idatParts = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) throw new Error(`PNG: truncated ${type} chunk`);

    const data = buffer.subarray(dataStart, dataEnd);
    // Verifying CRCs turns silent corruption into a clear error; screenshots are
    // read once so the extra pass is irrelevant.
    const expectedCrc = buffer.readUInt32BE(dataEnd);
    const actualCrc = crc32(buffer.subarray(offset + 4, dataEnd));
    if (expectedCrc !== actualCrc) throw new Error(`PNG: CRC mismatch in ${type} chunk`);

    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      transparency = data;
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }

  if (!header) throw new Error('PNG: no IHDR chunk');
  const { width, height, bitDepth, colorType, interlace } = header;
  if (!width || !height) throw new Error(`PNG: implausible size ${width}x${height}`);
  if (header.compression !== 0) throw new Error(`PNG: unsupported compression ${header.compression}`);
  if (header.filter !== 0) throw new Error(`PNG: unsupported filter method ${header.filter}`);
  if (interlace !== 0) throw new Error('PNG: interlaced (Adam7) images are not supported');

  const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = CHANNELS[colorType];
  if (!channels) throw new Error(`PNG: unsupported colour type ${colorType}`);
  // Greyscale (0) and palette (3) may pack 1/2/4/8/16 bits per sample; the
  // colour types that carry real channels are limited to 8 or 16.
  const ALLOWED_DEPTHS = { 0: [1, 2, 4, 8, 16], 3: [1, 2, 4, 8], 2: [8, 16], 4: [8, 16], 6: [8, 16] };
  if (!ALLOWED_DEPTHS[colorType].includes(bitDepth)) {
    throw new Error(`PNG: colour type ${colorType} cannot use a ${bitDepth}-bit sample`);
  }
  if (colorType === 3 && !palette) throw new Error('PNG: palette image without PLTE chunk');

  const rowBytes = Math.ceil((width * channels * bitDepth) / 8);
  // Filters operate on whole bytes, so the "left" neighbour is one pixel away in
  // bytes rounded up to a byte boundary.
  const bpp = Math.max(1, Math.ceil((channels * bitDepth) / 8));
  const inflated = inflateSync(Buffer.concat(idatParts));
  const needed = height * (rowBytes + 1);
  if (inflated.length < needed) {
    throw new Error(`PNG: image data too short (${inflated.length} < ${needed} bytes after inflate)`);
  }

  const out = new Uint8Array(width * height * 4);
  const prior = new Uint8Array(rowBytes);
  let opaque = 0;

  for (let y = 0; y < height; y += 1) {
    const start = y * (rowBytes + 1);
    const filter = inflated[start];
    const row = inflated.subarray(start + 1, start + 1 + rowBytes);
    const pixels = unfilterRow(filter, row, prior, bpp);
    prior.set(pixels);

    for (let x = 0; x < width; x += 1) {
      let r;
      let g;
      let b;
      let a = 255;
      if (colorType === 0) {
        r = g = b = readSample(row, x, 0, channels, bitDepth);
        if (transparency && transparency.length >= 2 && r === transparency.readUInt16BE(0)) a = 0;
      } else if (colorType === 2) {
        r = readSample(row, x, 0, channels, bitDepth);
        g = readSample(row, x, 1, channels, bitDepth);
        b = readSample(row, x, 2, channels, bitDepth);
      } else if (colorType === 3) {
        const index = readIndex(row, x, bitDepth);
        const p = index * 3;
        if (p + 2 >= palette.length) throw new Error('PNG: palette index out of range');
        r = palette[p];
        g = palette[p + 1];
        b = palette[p + 2];
        if (transparency && index < transparency.length) a = transparency[index];
      } else if (colorType === 4) {
        r = g = b = readSample(row, x, 0, channels, bitDepth);
        a = readSample(row, x, 1, channels, bitDepth);
      } else {
        r = readSample(row, x, 0, channels, bitDepth);
        g = readSample(row, x, 1, channels, bitDepth);
        b = readSample(row, x, 2, channels, bitDepth);
        a = readSample(row, x, 3, channels, bitDepth);
      }

      const o = (y * width + x) * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = a;
      if (a === 255) opaque += 1;
    }
  }

  return {
    width,
    height,
    colorType,
    bitDepth,
    data: out,
    // Named distinctly from the `opaqueFraction()` statistic, which counts alpha
    // > 0; this one counts alpha === 255 as stored in the file.
    storedOpaqueFraction: opaque / (width * height),
    hasAlphaChannel: colorType === 4 || colorType === 6 || colorType === 3,
  };
}

/** Read and decode a PNG from disk. */
export async function readPng(path) {
  return decodePng(await readFile(path));
}

/**
 * Rec.709 luma on gamma-encoded samples. This is the brightness a screenshot
 * reader perceives, and matches what `--dump-dom`-style thresholds were tuned
 * against in the reference render; true linear luminance would make the dark
 * background read much darker than it looks.
 */
export function luma(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Clip a rectangle to the image; `null` means the whole frame. */
export function clipRect(image, rect) {
  if (!rect) return { x: 0, y: 0, w: image.width, h: image.height };
  const x = Math.max(0, Math.min(image.width, Math.floor(rect.x ?? 0)));
  const y = Math.max(0, Math.min(image.height, Math.floor(rect.y ?? 0)));
  const w = Math.max(0, Math.min(image.width - x, Math.floor(rect.w ?? image.width - x)));
  const h = Math.max(0, Math.min(image.height - y, Math.floor(rect.h ?? image.height - y)));
  return { x, y, w, h };
}

/** Build a centred rectangle covering `fraction` of width and height. */
export function centreRect(image, fraction = 0.4) {
  const w = image.width * fraction;
  const h = image.height * fraction;
  return {
    x: Math.round((image.width - w) / 2),
    y: Math.round((image.height - h) / 2),
    w: Math.round(w),
    h: Math.round(h),
  };
}

/**
 * Mean luma over a rectangle (default whole frame). Fully transparent pixels are
 * skipped: an RGBA screenshot with a transparent background must not be scored
 * as "black", and skipping keeps the mean comparable to the opaque case.
 */
export function meanLuminance(image, rect) {
  const r = clipRect(image, rect);
  let sum = 0;
  let count = 0;
  for (let y = r.y; y < r.y + r.h; y += 1) {
    for (let x = r.x; x < r.x + r.w; x += 1) {
      const o = (y * image.width + x) * 4;
      if (image.data[o + 3] === 0) continue;
      sum += luma(image.data[o], image.data[o + 1], image.data[o + 2]);
      count += 1;
    }
  }
  return count ? sum / count : 0;
}

/** Fraction of pixels in `rect` whose luma is >= `threshold` (0..255). */
export function fractionAbove(image, threshold, rect) {
  return fractionMatching(image, rect, (l) => l >= threshold);
}

/** Fraction of pixels in `rect` whose luma is <= `threshold` (0..255). */
export function fractionBelow(image, threshold, rect) {
  return fractionMatching(image, rect, (l) => l <= threshold);
}

function fractionMatching(image, rect, predicate) {
  const r = clipRect(image, rect);
  let hits = 0;
  let count = 0;
  for (let y = r.y; y < r.y + r.h; y += 1) {
    for (let x = r.x; x < r.x + r.w; x += 1) {
      const o = (y * image.width + x) * 4;
      if (image.data[o + 3] === 0) continue;
      if (predicate(luma(image.data[o], image.data[o + 1], image.data[o + 2]))) hits += 1;
      count += 1;
    }
  }
  return count ? hits / count : 0;
}

/** Fraction of pixels with alpha > 0 (the "ink" of an RGBA screenshot). */
export function opaqueFraction(image) {
  let count = 0;
  for (let o = 3; o < image.data.length; o += 4) if (image.data[o] > 0) count += 1;
  return count / (image.width * image.height);
}

/**
 * Count distinct colours and the dominant one.
 *
 * The modal colour is treated as "background": a 3D render is mostly a flat
 * clear colour, so pixels differing from it approximate the rendered geometry
 * without needing to know which colour the page painted behind the canvas.
 * Exact comparison is deliberate — it avoids a distance threshold that would
 * report subtle shading gradients as background.
 */
export function colourStats(image) {
  const counts = new Map();
  let opaque = 0;
  for (let o = 0; o < image.data.length; o += 4) {
    if (image.data[o + 3] === 0) continue;
    opaque += 1;
    const key = (image.data[o] << 16) | (image.data[o + 1] << 8) | image.data[o + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let background = 0;
  let backgroundCount = 0;
  for (const [key, count] of counts) {
    if (count > backgroundCount) {
      backgroundCount = count;
      background = key;
    }
  }
  return {
    distinctColours: counts.size,
    totalPixels: image.width * image.height,
    visiblePixels: opaque,
    background: {
      r: (background >> 16) & 0xff,
      g: (background >> 8) & 0xff,
      b: background & 0xff,
      count: backgroundCount,
    },
    /** Share of visible pixels that differ from the modal background. */
    nonBackgroundFraction: opaque ? (opaque - backgroundCount) / opaque : 0,
    nonBlank: counts.size > 1 && backgroundCount < opaque,
  };
}

/**
 * Centroid of pixels brighter than `threshold`, in pixel coordinates.
 * Used to answer "is there a bright spot near the frame centre" without
 * depending on the model's exact silhouette: the print is what emits light, so
 * its bright pixels' centre of mass should land near the viewport middle.
 */
export function centroidAbove(image, threshold, rect) {
  const r = clipRect(image, rect);
  let sx = 0;
  let sy = 0;
  let count = 0;
  for (let y = r.y; y < r.y + r.h; y += 1) {
    for (let x = r.x; x < r.x + r.w; x += 1) {
      const o = (y * image.width + x) * 4;
      if (image.data[o + 3] === 0) continue;
      if (luma(image.data[o], image.data[o + 1], image.data[o + 2]) >= threshold) {
        sx += x;
        sy += y;
        count += 1;
      }
    }
  }
  if (!count) return { x: null, y: null, count: 0, fraction: 0 };
  const area = Math.max(1, r.w * r.h);
  return { x: sx / count, y: sy / count, count, fraction: count / area };
}

/** One-shot summary used by the CLI and by `report.mjs`. */
export function analyse(image, { rect, threshold = 160 } = {}) {
  const stats = colourStats(image);
  const area = rect ?? null;
  return {
    width: image.width,
    height: image.height,
    colorType: image.colorType,
    bitDepth: image.bitDepth,
    ...stats,
    meanLuminance: meanLuminance(image, area),
    opaqueFraction: opaqueFraction(image),
    aboveThreshold: fractionAbove(image, threshold, area),
    belowThreshold: fractionBelow(image, threshold, area),
    brightCentroid: centroidAbove(image, threshold, area),
    threshold,
  };
}

class UsageError extends Error {}

/** Format a rect for display. */
export function formatRect(rect) {
  return rect ? `${rect.x},${rect.y} ${rect.w}x${rect.h}` : 'whole frame';
}

/** Parse `x,y,w,h` from a CLI argument; empty input means the whole frame. */
export function parseRect(text) {
  if (!text) return null;
  const parts = String(text).split(',').map((part) => Number.parseInt(part.trim(), 10));
  if (parts.length !== 4 || parts.some(Number.isNaN)) {
    throw new Error(`bad rectangle "${text}", expected x,y,w,h`);
  }
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

const HELP = `pixels.mjs — decode a PNG and report pixel statistics (no dependencies).

Usage:
  node verify/pixels.mjs <image.png> [options]

Options:
  --rect x,y,w,h     Restrict luminance stats to this rectangle (default: whole frame)
  --threshold N      Luma threshold on the 0..255 scale (default 160)
  --json             Print machine-readable JSON instead of a text table
  --help, -h         Show this help

Output:
  distinct colours, non-background fraction, mean luma, luma above/below the
  threshold, opaque fraction, and the centroid of bright pixels.

Exit codes:
  0 = decoded and analysed
  1 = could not read/decode the PNG
  2 = bad arguments
`;

async function main(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  let file = null;
  let rect = null;
  let threshold = 160;
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') json = true;
    else if (arg === '--rect') {
      // Re-tag as a usage error so a bad rectangle gets exit 2, like other bad args.
      try {
        rect = parseRect(args[++i]);
      } catch (error) {
        throw new UsageError(error.message);
      }
    }
    else if (arg === '--threshold') threshold = Number.parseFloat(args[++i]);
    else if (arg.startsWith('-')) throw new UsageError(`unknown option ${arg}`);
    else if (!file) file = arg;
    else throw new UsageError(`unexpected argument ${arg}`);
  }
  if (!file) throw new UsageError('missing <image.png>');
  if (!Number.isFinite(threshold)) throw new UsageError('--threshold must be a number');

  const image = await readPng(file);
  const result = analyse(image, { rect, threshold });
  if (json) {
    process.stdout.write(`${JSON.stringify({ file, rect, ...result }, null, 2)}\n`);
    return 0;
  }
  const b = result.background;
  const lines = [
    `file             ${file}`,
    `size             ${result.width}x${result.height} colourType=${result.colorType} bitDepth=${result.bitDepth}`,
    `distinct colours ${result.distinctColours}`,
    `visible pixels   ${result.visiblePixels} / ${result.totalPixels} (opaque fraction ${result.opaqueFraction.toFixed(4)})`,
    `background       rgb(${b.r},${b.g},${b.b}) ${b.count} px`,
    `non-background   ${(result.nonBackgroundFraction * 100).toFixed(2)}%`,
    `mean luma        ${result.meanLuminance.toFixed(2)} (rect: ${formatRect(rect)})`,
    `above ${String(threshold).padEnd(6)}     ${(result.aboveThreshold * 100).toFixed(2)}%`,
    `below ${String(threshold).padEnd(6)}     ${(result.belowThreshold * 100).toFixed(2)}%`,
    result.brightCentroid.count
      ? `bright centroid  (${result.brightCentroid.x.toFixed(1)}, ${result.brightCentroid.y.toFixed(1)}) from ${result.brightCentroid.count} px`
      : 'bright centroid  none',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

/**
 * Detect "was this file run as a script". Comparing `process.argv[1]` against
 * `import.meta.url` breaks when the path contains non-ASCII or spaces (it gets
 * percent-encoded), which is exactly this workspace, so normalise both sides to
 * real filesystem paths before comparing.
 */
export function isMain(moduleUrl, argv = process.argv) {
  if (!argv[1]) return false;
  try {
    return resolve(fileURLToPath(moduleUrl)) === resolve(argv[1]);
  } catch {
    return false;
  }
}

if (isMain(import.meta.url)) {
  main(process.argv).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error instanceof UsageError ? '' : 'pixels: '}${error.message}\n`);
      if (error instanceof UsageError) process.stderr.write('Try --help.\n');
      process.exit(error instanceof UsageError ? 2 : 1);
    },
  );
}
