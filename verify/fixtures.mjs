#!/usr/bin/env node
/**
 * Stage the verification fixtures the demo's richer checks need.
 *
 * The interesting cases -- filament colours, a painted 3MF, a plate that carries
 * its own sliced G-code -- need a real slicer output. Those are megabytes each and
 * belong to whoever made the print rather than to this library, so they are not
 * committed. What is committed is two small STLs, which prove the viewer draws
 * something but not that it can colour a 3MF or cut one into layers.
 *
 * This script looks for print files near the checkout and copies one of each kind
 * into the demo. It is a no-op elsewhere: a checkout without any print files still
 * builds, still runs the STL demo and still passes the checks that do not need a
 * fixture. The searches are by extension and by shape, never by name: which
 * particular print happens to be sitting on disk is nobody's business but the
 * machine it is on, and hard-coding one would make this file about that print.
 *
 * Usage:
 *   node verify/fixtures.mjs                    # look in the usual places
 *   node verify/fixtures.mjs ~/prints           # look here instead
 *   MODEL3D_FIXTURES=~/prints node verify/fixtures.mjs
 *   node verify/fixtures.mjs --clean            # remove the staged copies
 */

import { copyFile, mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const demoFixtures = resolve(here, '..', 'embed', 'demo', 'fixtures');

/**
 * Where to look for the print files, in order of preference.
 *
 * All relative to the repository, so a checkout that keeps sample prints anywhere
 * nearby can use them. Nothing here names a folder that only exists on the
 * machine this was written on.
 */
const SEARCH = [
  // An explicit directory, which is the reliable way and the one to use when the
  // prints live somewhere this script has no business guessing at.
  ...(process.env.MODEL3D_FIXTURES ? [resolve(process.env.MODEL3D_FIXTURES)] : []),
  ...(process.argv.slice(2).filter((arg) => !arg.startsWith('--')).map((arg) => resolve(arg))),
  // Inside the repository: a checkout that carries its own sample prints.
  resolve(here, '..', 'samples'),
  // Beside the repository, in a folder of its own.
  resolve(here, '..', '..', '..', 'samples'),
  resolve(here, '..', '..', '..', 'prints'),
];

/**
 * How deep to walk each search root.
 *
 * One level: the roots above are already "the folder where prints live". Walking
 * deeper was how this script once picked up an unrelated file from a sibling
 * project -- a checkout under `/tmp` searched all of `/tmp`, found some other
 * repository's model and staged it. A fixture is only meaningful if it actually
 * has the properties the checks assert, so the search stays narrow and the
 * content filters below decide.
 */
const SEARCH_DEPTH = 1;

/**
 * The fixture names the demo and the checks ask for.
 *
 * Chosen by what the file *is*, never by its name: the checks care that there is
 * a 3MF carrying sliced G-code, not which print it came from.
 *
 * The distinction that matters is `needsSlicedGcode`. A 3 MF from a slicer either
 * embeds `Metadata/*.gcode` -- so the viewer can offer both views -- or carries
 * only geometry, in which case there is no sliced view at all and a dozen checks
 * quietly fail on a page that is working correctly. Picking by file size, as this
 * did first, gets that wrong about half the time.
 */
const WANTED = [
  // The one the richer checks need: a 3MF with its own sliced G-code inside, so
  // both the model view and the plate view exist.
  { name: 'sliced.3mf', extensions: ['.3mf'], needsSlicedGcode: true, pick: 'smallest' },
  // A second one with the same property, from a different print, so the colour
  // checks are not all dependent on the particulars of one file.
  { name: 'dup.3mf', extensions: ['.3mf'], needsSlicedGcode: true, pick: 'smallest', skipFirst: true },
  // A bare G-code: strokes only, no model view, which is its own case.
  { name: 'plate-small.gcode', extensions: ['.gcode'], pick: 'smallest' },
  // The largest G-code available: the size and layer count are what make it worth
  // having as a fixture rather than a chunk of one.
  { name: 'large.gcode', extensions: ['.gcode'], pick: 'largest' },
];

/**
 * Whether a 3 MF has a sliced G-code inside it.
 *
 * Read from the ZIP central directory rather than by unzipping: the entry names
 * are stored uncompressed there, so this costs one seek and no inflation. A 3 MF
 * from a slicer lists `Metadata/plate_N.gcode`; one exported straight from a CAD
 * tool lists only the model parts, and the viewer then has no sliced view to
 * offer at all -- which is a property of the file, not a fault in the viewer.
 *
 * @param path - a `.3mf` file.
 * @returns whether a `.gcode` entry is present. Unreadable files count as no.
 */
async function hasSlicedGcode(path) {
  let handle;
  try {
    handle = await open(path, 'r');
    const info = await handle.stat();
    // ZIP central directory entries store their names uncompressed, and the whole
    // directory sits at the end of the file. Reading the last 64 KiB therefore
    // gives every entry name without inflating anything; a 3 MF with more entries
    // than fit there would need a real parser, and one file with sliced G-code has
    // a couple of dozen.
    const tailLength = Math.min(info.size, 65_557);
    const tail = Buffer.alloc(tailLength);
    const { bytesRead } = await handle.read(tail, 0, tailLength, info.size - tailLength);
    return tail.subarray(0, bytesRead).includes('.gcode');
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

/** Whether a path exists. */
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

if (process.argv.includes('--clean')) {
  await rm(demoFixtures, { recursive: true, force: true });
  console.log('fixtures removed');
  process.exit(0);
}

await mkdir(demoFixtures, { recursive: true });

/**
 * Every file under the search roots with a wanted extension, with its size.
 *
 * Recursive to a shallow depth: a folder of prints usually means one folder of
 * slicer output beside another, not a tree, so two levels is enough to find a
 * sibling directory without walking a whole disk.
 */
async function catalogue(extensions) {
  const found = [];
  const walk = async (root, depth) => {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        if (depth > 0 && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          await walk(path, depth - 1);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (!extensions.some((extension) => lower.endsWith(extension))) continue;
      found.push({ path, size: (await stat(path)).size });
    }
  };
  for (const root of SEARCH) {
    if (await exists(root)) await walk(root, SEARCH_DEPTH);
  }
  // Biggest first, so "largest" is the head and "smallest" the tail; ties broken by
  // path so two runs on the same machine stage the same file.
  found.sort((a, b) => b.size - a.size || a.path.localeCompare(b.path));
  return found;
}

let staged = 0;
/** Paths already used, so two fixtures never stage the same file twice. */
const used = new Set();

for (const wanted of WANTED) {
  if (await exists(join(demoFixtures, wanted.name))) {
    console.log(`${wanted.name}: already staged`);
    staged += 1;
    continue;
  }
  let available = (await catalogue(wanted.extensions)).filter((entry) => !used.has(entry.path));
  if (wanted.needsSlicedGcode === true) {
    // Filter by content, not by size: a 3MF without embedded G-code has no sliced
    // view, and several checks would fail on a page that works.
    const withGcode = [];
    for (const entry of available) {
      if (await hasSlicedGcode(entry.path)) withGcode.push(entry);
    }
    available = withGcode;
  }
  // `skipFirst` takes the second choice, which is how a second 3MF from a
  // different project is found without naming either file.
  const pool = wanted.skipFirst === true ? available.slice(1) : available;
  const best = wanted.pick === 'largest' ? pool[0] : pool[pool.length - 1];
  if (best === undefined) {
    console.log(`${wanted.name}: no source found — the checks that need it will be skipped`);
    continue;
  }
  used.add(best.path);
  await copyFile(best.path, join(demoFixtures, wanted.name));
  console.log(`${wanted.name}: staged (${(best.size / 1024).toFixed(0)} KB)`);
  staged += 1;
}

console.log(`\n${staged}/${WANTED.length} fixtures available in embed/demo/fixtures/`);
