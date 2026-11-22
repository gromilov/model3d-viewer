#!/usr/bin/env node
/**
 * Crop a region out of a screenshot and blow it up, for looking at small details.
 *
 * Verification by pixel statistics answers "is there structure here"; it cannot
 * answer "does this 14-pixel strip read as a ramp". For that a person has to look,
 * and the detail in question is often too small to see in the full frame. So:
 * nearest-neighbour upscaling, which keeps every source pixel visible as a square
 * instead of smoothing it into something the screenshot never contained.
 *
 * Usage:
 *   node verify/zoom.mjs <in.png> <out.png> --rect x,y,w,h [--scale 6]
 *
 * Coordinates are in stored pixels, origin top left, which is what the pixel
 * helpers in `pixels.mjs` use as well.
 */

import { writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { readPng } from './pixels.mjs';

/** Encode 8-bit RGBA as a PNG. */
export function encodePng(image) {
  const { width, height, data } = image;
  // One filter byte (0 = none) in front of every scanline: the format requires it,
  // and choosing per-row filters here would be work for a gain of a few kilobytes.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(data.buffer ?? data, (data.byteOffset ?? 0) + y * stride, stride)
      .copy(raw, y * (stride + 1) + 1);
  }

  const chunk = (type, body) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, crc]);
  };

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;   // bit depth
  header[9] = 6;   // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

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

/** Crop a rectangle, clamped to the image, and scale it up by whole pixels. */
export function cropZoom(image, [x, y, w, h], scale = 6) {
  const left = Math.max(0, Math.min(image.width - 1, Math.round(x)));
  const top = Math.max(0, Math.min(image.height - 1, Math.round(y)));
  const width = Math.max(1, Math.min(image.width - left, Math.round(w)));
  const height = Math.max(1, Math.min(image.height - top, Math.round(h)));
  const outWidth = width * scale;
  const outHeight = height * scale;
  const out = new Uint8Array(outWidth * outHeight * 4);
  for (let dy = 0; dy < outHeight; dy += 1) {
    const sy = top + Math.floor(dy / scale);
    for (let dx = 0; dx < outWidth; dx += 1) {
      const sx = left + Math.floor(dx / scale);
      const from = (sy * image.width + sx) * 4;
      const to = (dy * outWidth + dx) * 4;
      out[to] = image.data[from];
      out[to + 1] = image.data[from + 1];
      out[to + 2] = image.data[from + 2];
      out[to + 3] = image.data[from + 3];
    }
  }
  return { width: outWidth, height: outHeight, data: out };
}

function arg(name, fallback) {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : process.argv[at + 1];
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('zoom.mjs')) {
  const [input, output] = process.argv.slice(2).filter((a) => !a.startsWith('--') && !/^[\d,.]+$/.test(a));
  const rect = (arg('--rect', '0,0,100,100') ?? '').split(',').map(Number);
  const scale = Number(arg('--scale', '6'));
  if (input === undefined || output === undefined) {
    console.error('usage: node verify/zoom.mjs <in.png> <out.png> --rect x,y,w,h [--scale 6]');
    process.exit(2);
  }
  const image = await readPng(input);
  await writeFile(output, encodePng(cropZoom(image, rect, scale)));
  console.log(`${output}: ${rect.join(',')} at ${scale}x`);
}
