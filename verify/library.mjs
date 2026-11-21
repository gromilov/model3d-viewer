#!/usr/bin/env node
/**
 * The library's own checks: one browser, three pages, and assertions on both the
 * DOM markers a page reports and the pixels it actually painted.
 *
 * The pixel half is the part that matters. Every previous round of work on this
 * viewer was verified by maths and by rasterising triangles in Node, which cannot
 * catch a shader that compiles but shades wrongly, a canvas that is the wrong
 * size, or a layer slider that is drawn off the edge. A headless browser can, so
 * the checks below assert on the screenshot itself.
 *
 * Usage:
 *   node verify/library.mjs            # run every check
 *   node verify/library.mjs --keep     # keep the screenshots for inspection
 *
 * Exits 0 when every check passes, 1 otherwise.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPng } from './pixels.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// Rooted at the plugin root. The demo pages import `../dist` (the embed build)
// and one of them loads `../../client.js` (the plugin build), so the server has
// to sit high enough that both resolve -- the pages' own relative paths are what
// a real static host would serve, which is the point of testing them as-is.
const demo = resolve(here, '..');
const keep = process.argv.includes('--keep');

/** Run one command, collecting stdout and stderr. */
function run(command, args) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

/**
 * The checks, as data.
 *
 * Each one names a page in `embed/demo`, a marker the page must report, and a
 * pixel assertion on the screenshot. `centre` is the fraction of the frame the
 * assertion looks at, as `[x, y, width, height]` in 0..1.
 */
const CHECKS = [
  // `needs` names a staged fixture. Short of it, the check is reported as skipped
  // rather than failed: the fixtures are the user's print files and are not
  // committed, so a fresh clone legitimately cannot run these.

  {
    name: 'embed: demo page mounts and paints',
    page: 'index.html',
    size: [1200, 700],
    expect: /mounted /,
    reject: /ERR|REJ|failed/,
    pixels: { minColours: 64, minNonBackground: 0.03, centre: [0.2, 0.2, 0.6, 0.6] },
  },
  {
    name: 'embed: every control drives the engine',
    page: 'features.html',
    needs: 'sliced.3mf',
    size: [900, 620],
    // 28 named round-trips through the panel's API, reported in the page's title.
    expect: /DONE 28/,
    reject: /THREW|ERR|REJ/,
    pixels: { minColours: 32, minNonBackground: 0.02 },
  },
  {
    name: 'embed: bed and navigation cube draw together',
    page: 'cube-shot.html',
    needs: 'sliced.3mf',
    size: [820, 620],
    expect: /CUBE OK/,
    reject: /ERR|REJ|FAIL/,
    // The bed's grid and the cube are both faint; the check is that the frame has
    // real structure rather than a flat fill.
    pixels: { minColours: 64, minNonBackground: 0.05 },
  },
  {
    // A bare G-code is the case that used to crash: the parser returns the
    // drawing itself rather than `{ mesh }`, and the panel read `.mesh` off it.
    name: 'embed: a bare G-code opens on its sliced view',
    page: 'gcode-check.html',
    needs: 'plate-small.gcode',
    size: [720, 560],
    expect: /GCODE OK/,
    reject: /ERR|REJ|FAIL/,
    pixels: { minColours: 16, minNonBackground: 0.01 },
  },
  {
    // Twelve mount/dispose rounds. A browser caps live WebGL contexts, so a
    // panel that leaked one per open would fail partway through an app's life
    // rather than in any single view -- which is why this needs its own check.
    name: 'embed: mounting and disposing twelve times leaks no context',
    page: 'leak-check.html',
    size: [640, 440],
    expect: /LEAK OK rounds=12/,
    reject: /FAIL|THROW|ERR|REJ/,
    // No pixel assertion: the page removes each panel after checking it, so an
    // empty stage is the expected end state, and the DOM marker is the evidence.
    pixels: { minColours: 1, minNonBackground: 0 },
  },
  {
    name: 'embed: the classic script defines the element and a global',
    page: 'iife-test.html',
    size: [500, 300],
    expect: /IIFE OK/,
    reject: /FAIL|THROW/,
    pixels: { minColours: 2, minNonBackground: 0 },
  },
  {
    // Settings must survive a panel being thrown away and a new one built from the
    // same file, which is the whole feature. An STL has no bed or palette, so the
    // page also runs the round trip on a staged 3MF for those two.
    name: 'embed: per-file settings survive a rebuild of the panel',
    page: 'persist-check.html',
    size: [720, 560],
    expect: /PERSIST DONE/,
    reject: /THREW|ERR|REJ/,
    pixels: { minColours: 8, minNonBackground: 0.005 },
  },
  {
    // The same round trip, judged by the picture rather than by the state object:
    // a light backdrop, the plate, a downward camera and a recoloured filament are
    // all visible in the frame, so a broken restore shows up as a different image.
    name: 'embed: a restored file looks the way it was left',
    page: 'persist-visual.html',
    size: [820, 600],
    needs: 'sliced.3mf',
    expect: /VISUAL #dfe3e8 bed/,
    reject: /FAIL|THREW/,
    pixels: { minColours: 64, minNonBackground: 0.10 },
  },
  {
    // The exported PNG cleared to pure green for a while: the panel handed the
    // engine a hex string where it expected three channels, and `'#1c1d20'[0..2]`
    // is '#','1','c' -- which clamps to (0, 1, 0). The page reads the corner pixel
    // back out of the data URL, so this cannot regress unnoticed again.
    name: 'embed: the PNG export clears to the chosen colour',
    page: 'export-check.html',
    size: [640, 440],
    needs: 'sliced.3mf',
    expect: /EXPORT DONE/,
    reject: /FAIL|THREW|pending/,
    pixels: { minColours: 4, minNonBackground: 0.001 },
  },
  {
    // The real file from the order folder at full size: 154 034 strokes across 65
    // layers, the case a chunk of a fixture would not exercise. It also pins the
    // stats line to "paths" rather than "triangles", which was misleading.
    name: 'embed: the full-size G-code opens as strokes',
    page: 'full-gcode.html',
    size: [920, 680],
    needs: 'large.gcode',
    expect: /FULL OK/,
    reject: /ERR|REJ|FAIL/,
    pixels: { minColours: 16, minNonBackground: 0.01 },
  },
  {
    // Tracing produces an image the rasteriser cannot: soft cast shadows and
    // contact darkening. The check asserts both that it converges (sample count
    // rises) and that it actually darkened the surface, which is the evidence that
    // occlusion was found rather than merely shaded.
    name: 'embed: ray tracing converges and finds shadows',
    page: 'trace-panel.html',
    size: [800, 640],
    needs: 'sliced.3mf',
    expect: /TRACEPANEL s=(\d+)/,
    // At least eight passes: one or two would mean the loop stalled, which happened
    // when it relied on requestAnimationFrame alone.
    expectAll: [/TRACEPANEL s=(?:[1-9]\d+)/],
    reject: /ERR|REJ|FAIL/,
    pixels: { minColours: 32, minNonBackground: 0.02 },
  },
  {
    // The builder cannot express an empty tree, and a degenerate one would spin the
    // traversal. The panel must refuse with a message rather than upload it.
    name: 'embed: an empty scene refuses to trace, with a reason',
    page: 'empty2.html',
    size: [420, 320],
    expect: /EMPTY2 tracing=false/,
    reject: /THREW|ERR |Uncaught/,
    pixels: { minColours: 1, minNonBackground: 0 },
  },
  {
    // The traced frame is exported as a PNG at its own size, through its own
    // offscreen tracer. The check reads the file back: a blank export is a valid
    // PNG, so "a file arrived" would prove nothing.
    name: 'embed: the traced view saves a real PNG',
    page: 'trace-export.html',
    size: [640, 560],
    needs: 'sliced.3mf',
    expect: /TRACEEXPORT \d+x\d+ lit=\d+/,
    // A real render at 1024 wide lights tens of thousands of pixels; a blank one
    // lights none.
    expectAll: [/TRACEEXPORT \d+x\d+ lit=[1-9]\d{3,}/],
    reject: /ERR|REJ|NO DOWNLOAD|DECODE FAILED/,
    pixels: { minColours: 8, minNonBackground: 0.005 },
  },
  {
    // The export used to run as one blocking loop. Slicing it was not enough on its
    // own: a WebGL call only queues work, so forty slices returned instantly and the
    // whole cost landed on the final read-back as a single 4.6-second freeze. Each
    // slice now ends with a synchronisation. What is asserted here is the property
    // virtual time cannot fake -- a loop that blocks is observed once, a sliced one
    // is observed climbing.
    name: 'embed: the traced export gives the page its turn back',
    page: 'trace-yield.html',
    size: [640, 560],
    needs: 'sliced.3mf',
    expect: /YIELD observations=\d+ png=\d+/,
    expectAll: [/YIELD observations=(?:[89]|\d{2,}) png=\d{5,}/],
    reject: /ERR|REJ|FAIL/,
    pixels: { minColours: 8, minNonBackground: 0.005 },
  },
  {
    // Two bugs of the "fine until you toggle" kind, both in the seam between the
    // two render pipelines. The palette never reached the viewer on first open --
    // `syncPalette` updated the swatch row only, while the geometry is coloured by
    // `setPalette`, which ran only when a colour was edited -- so the model opened
    // with an empty palette. And `vertexAttribDivisor` leaked across the seam: the
    // stroke path sets 1 on the indices it instances and the triangle path never
    // reset them, so a model drawn after a plate read one colour per triangle
    // instead of per vertex and came back flat. Measured on shades: 52 collapsed
    // to 4.
    name: 'embed: a view switch keeps the colours it started with',
    page: 'view-switch.html',
    size: [500, 620],
    needs: 'dup.3mf',
    expect: /VIEWSWITCH ok/,
    reject: /ERR|REJ|FAIL/,
    pixels: { minColours: 16, minNonBackground: 0.01 },
  },
  {
    // Five defects that all looked like deliberate minimalism and none of which
    // threw: the tracing buttons had no icon (a missing path made `icon()` return
    // null), the slider value labels were empty (applySettings returned early with
    // nothing stored), the sliders edited defaults rather than the scene, the reset
    // button was disabled forever (the loading flag was never cleared), and the
    // fourth slider sat past the right edge of a narrow row with the scrollbar
    // hidden. Checked at 400px, which is a sidebar rather than a full window.
    name: 'embed: the panel shows icons, values and every control',
    page: 'panel-check.html',
    size: [500, 620],
    needs: 'large.gcode',
    expect: /PANELCHECK ok/,
    reject: /ERR|REJ|FAIL/,
    pixels: { minColours: 8, minNonBackground: 0.005 },
  },
  {
    // The pass loop armed a frame callback and a watchdog timer at once and let both
    // stand. On a plate whose pass outran the watchdog the timer won the race and the
    // abandoned frame callback started a second pass chain beside the first; the
    // counter then climbed past its budget while the tab froze. The order file showed
    // 109 against a budget of 96. The page forces that ordering deterministically and
    // asserts the counter stays inside the budget.
    name: 'embed: the traced view never overshoots its sample budget',
    page: 'trace-budget.html',
    size: [640, 560],
    needs: 'large.gcode',
    // The page does the arithmetic and only reports BUDGET when the count is inside
    // the budget; anything else is a FAIL the reject filter catches.
    expect: /BUDGET budget=\d+ highest=\d+ armed=\d+/,
    reject: /ERR|REJ|FAIL/,
    pixels: { minColours: 8, minNonBackground: 0.005 },
  },
  {
    name: 'dsh: the sidebar bundle registers and mounts',
    page: 'dsh-harness.html',
    needs: 'sliced.3mf',
    size: [820, 620],
    expect: /DSH MOUNT OK/,
    reject: /THREW|ERR |REJ|NOT LOADED|NO FACTORY|NO BODY/,
    pixels: { minColours: 32, minNonBackground: 0.02 },
  },
];

/** The mean luminance over the part of the image a check looks at. */
function regionLuma(image, rect) {
  const [rx, ry, rw, rh] = rect;
  const x0 = Math.floor(rx * image.width);
  const y0 = Math.floor(ry * image.height);
  const x1 = Math.min(image.width, Math.ceil((rx + rw) * image.width));
  const y1 = Math.min(image.height, Math.ceil((ry + rh) * image.height));
  let total = 0;
  let count = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const index = (y * image.width + x) * 4;
      // Rec. 709 weights: the frame is dark greys and filament colours, and a
      // plain average over RGB would call a saturated yellow as bright as white.
      total += 0.2126 * image.data[index] + 0.7152 * image.data[index + 1] + 0.0722 * image.data[index + 2];
      count += 1;
    }
  }
  return count === 0 ? 0 : total / count;
}

/** Count the distinct RGB triples in an image, ignoring fully transparent pixels. */
function distinctColours(image) {
  const seen = new Set();
  for (let index = 0; index < image.data.length; index += 4) {
    if (image.data[index + 3] === 0) continue;
    seen.add((image.data[index] << 16) | (image.data[index + 1] << 8) | image.data[index + 2]);
  }
  return seen.size;
}

/** The fraction of pixels that differ from the corner pixel, a stand-in for "background". */
function nonBackgroundFraction(image) {
  const corner = [image.data[0], image.data[1], image.data[2]];
  let different = 0;
  let total = 0;
  for (let index = 0; index < image.data.length; index += 4) {
    total += 1;
    if (image.data[index + 3] === 0) continue;
    if (Math.abs(image.data[index] - corner[0]) > 3
      || Math.abs(image.data[index + 1] - corner[1]) > 3
      || Math.abs(image.data[index + 2] - corner[2]) > 3) different += 1;
  }
  return total === 0 ? 0 : different / total;
}

// The richer pages need the staged fixtures, which are not committed. Staging is
// idempotent, so this is cheap when they are already there.
await run(process.execPath, [join(here, 'fixtures.mjs')]);

const results = [];
const shots = await mkdtemp(join(tmpdir(), 'model3d-library-'));

/** Which fixtures are actually present. */
const stage = resolve(here, '..', 'embed', 'demo', 'fixtures');
const available = new Set();
for (const entry of await readdir(stage).catch(() => [])) available.add(entry);

for (const check of CHECKS) {
  if (check.needs !== undefined && !available.has(check.needs)) {
    results.push({
      name: check.name,
      ok: true,
      skipped: true,
      detail: `skipped: ${check.needs} is not staged (run node verify/fixtures.mjs where the print files are)`,
    });
    continue;
  }
  const out = join(shots, `${check.page.replace(/\W+/g, '-')}.png`);
  const args = [
    join(here, 'shoot.mjs'),
    `embed/demo/${check.page}`,
    out,
    '--serve', demo,
    '--size', check.size.join(','),
    '--expect', check.expect.source.replace(/^\/|\/$/g, '').replace(/^\^/, ''),
    '--virtual-time-budget', '22000',
  ];
  for (const pattern of [check.reject].flat()) {
    args.push('--reject', pattern.source.replace(/^\/|\/$/g, ''));
  }
  for (const extra of (check.expectAll ?? [])) {
    args.push('--expect', extra.source ?? String(extra));
  }
  const shot = await run(process.execPath, args);
  if (shot.code !== 0) {
    results.push({ name: check.name, ok: false, detail: `screenshot run failed:\n${shot.stdout}${shot.stderr}` });
    continue;
  }

  // The screenshot is the point: read it back and assert on the pixels.
  let image;
  try {
    image = await readPng(out);
  } catch (error) {
    results.push({ name: check.name, ok: false, detail: `the screenshot did not decode: ${error.message}` });
    continue;
  }
  const colours = distinctColours(image);
  const nonBackground = nonBackgroundFraction(image);
  const problems = [];
  if (colours < check.pixels.minColours) problems.push(`${colours} colours < ${check.pixels.minColours}`);
  if (nonBackground < check.pixels.minNonBackground) problems.push(`non-background ${(nonBackground * 100).toFixed(2)}% < ${(check.pixels.minNonBackground * 100).toFixed(0)}%`);
  if (check.pixels.centre !== undefined) {
    const luma = regionLuma(image, check.pixels.centre);
    // A blank canvas is a flat fill; a rendered model always varies. 3 is below
    // any real render and above a uniformly cleared frame.
    if (luma < 3) problems.push(`centre luminance ${luma.toFixed(1)} looks blank`);
  }
  results.push({
    name: check.name,
    ok: problems.length === 0,
    detail: `${image.width}x${image.height}, ${colours} colours, non-background ${(nonBackground * 100).toFixed(2)}%${problems.length === 0 ? '' : ` — ${problems.join('; ')}`}`,
  });
}

if (keep) console.log(`screenshots kept in ${shots}`);
else await rm(shots, { recursive: true, force: true });

let failed = 0;
let skipped = 0;
for (const result of results) {
  if (result.skipped === true) {
    skipped += 1;
    console.log(`SKIP  ${result.name}`);
    console.log(`      ${result.detail}`);
    continue;
  }
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}`);
  console.log(`      ${result.detail}`);
  if (!result.ok) failed += 1;
}
const ran = results.length - skipped;
console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${ran - failed}/${ran} checks passed${skipped > 0 ? `, ${skipped} skipped` : ''}`);
process.exit(failed === 0 ? 0 : 1);
