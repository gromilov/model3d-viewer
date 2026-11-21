#!/usr/bin/env node
/**
 * Run a named list of checks against a page and print a pass/fail table.
 *
 * Why a separate runner: `shoot.mjs` answers "what did the page say", and
 * `pixels.mjs` answers "what did the page draw". A render can succeed at one and
 * fail at the other — a black canvas with a valid `title` is exactly the bug this
 * harness exists to catch — so the interesting assertion is usually a pair, and
 * having both in one table makes a regression obvious at a glance.
 *
 * Each check is a plain object so a caller can build them in code as well as pick
 * one of the built-in suites by name. Checks run in order; the first fatal
 * problem (no screenshot at all) stops the run because every later check would
 * only repeat the same failure.
 */

import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { analyse, centreRect, formatRect, readPng } from './pixels.mjs';
import { DEFAULT_CHROME, isMain, shoot } from './shoot.mjs';

/**
 * The reference page suite. Values are deliberately loose: the goal is to catch
 * "nothing rendered", "the model is off-screen", "the canvas is transparent",
 * not to pin exact pixels that change with any lighting tweak. A render that
 * passes these can still be wrong; one that fails them is definitely broken.
 */
export const SUITES = {
  reference: {
    title: 'reference embed page (/tmp/embed-poc)',
    url: '/index.html',
    root: '/tmp/embed-poc',
    // The reference page publishes its own outcome; a FAIL string in the title or
    // log means the engine threw, which the pixel checks could not distinguish
    // from a legitimately dark render.
    expectDom: ['POC OK', 'rendered'],
    rejectDom: ['FAIL', 'Uncaught'],
    // Threshold picks out the lit yellow/white print against the #111 backdrop.
    // 150 sits above the background's luma (~17) by a wide margin and below the
    // print's, so antialiased edges do not flip the result.
    brightThreshold: 150,
    minNonBackground: 0.02,
    minDistinctColours: 64,
    minBrightFractionCentre: 0.005,
    minMeanLuminance: 8,
    maxMeanLuminance: 200,
  },
  /**
   * Decoder self-test: no browser involved. Decodes eight PNGs covering every
   * colour type Chrome or a build tool could hand us and compares the RGBA output
   * against hashes produced by an independent encoder. This exists because the
   * reference page only exercises 8-bit RGB; without these fixtures a regression
   * in the palette/16-bit/filter paths would go unnoticed until it mattered.
   */
  png: {
    title: 'PNG decoder self-test (verify/fixtures/png)',
    fixtures: 'verify/fixtures/png',
  },
};

/** Assertion helpers: every check returns {name, pass, detail} so one table can hold all of them. */
function domCheck(name, result, pattern, kind) {
  let re;
  try {
    re = new RegExp(pattern);
  } catch (error) {
    return { name, pass: false, detail: `invalid pattern ${pattern}: ${error.message}` };
  }
  const haystack = result.markers.map((marker) => `${marker.source}: ${marker.text}`).join('\n');
  const found = re.test(haystack);
  const pass = kind === 'reject' ? !found : found;
  return { name, pass, detail: detailFor(result, { kind, pattern, found }) };
}

function detailFor(result, { kind, pattern, found }) {
  if (kind === 'reject') return found ? `/${pattern}/ present` : `no /${pattern}/`;
  return found ? `/${pattern}/ present` : `/${pattern}/ missing from: ${result.markers.map((m) => m.source).join(', ') || '(no markers)'}`;
}

/** Compare a measured value against a bound and print both, so a failure is diagnosable. */
function thresholdCheck(name, value, { min, max }, unit = '') {
  const pass = (!Number.isFinite(min) || value >= min) && (!Number.isFinite(max) || value <= max);
  const bounds = [Number.isFinite(min) ? `>= ${min}` : null, Number.isFinite(max) ? `<= ${max}` : null].filter(Boolean).join(' and ');
  return { name, pass, detail: `${fmt(value)}${unit} (want ${bounds})` };
}

function fmt(value) {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return String(value);
  return Math.abs(value) >= 100 ? value.toFixed(1) : value.toFixed(4);
}

/**
 * Build the check list for one suite. Pixel checks read the PNG from disk rather
 * than being handed pixels by shoot(), because decoding the actual file is part of
 * what is being verified: it proves Chrome wrote a compatible PNG, not just that a
 * buffer appeared.
 */
export function buildChecks(spec, { image, shotResult }) {
  const checks = [];
  for (const pattern of spec.expectDom ?? []) checks.push(domCheck(`dom contains /${pattern}/`, shotResult, pattern, 'expect'));
  for (const pattern of spec.rejectDom ?? []) checks.push(domCheck(`dom lacks /${pattern}/`, shotResult, pattern, 'reject'));

  if (!image) {
    checks.push({ name: 'screenshot decodes as PNG', pass: false, detail: 'no image decoded' });
    return checks;
  }
  checks.push({ name: 'screenshot decodes as PNG', pass: true, detail: `${image.width}x${image.height} colourType=${image.colorType}` });

  const threshold = spec.brightThreshold ?? 150;
  const stats = analyse(image, { threshold });
  const centre = centreRect(image, spec.centreFraction ?? 0.5);
  const centreStats = analyse(image, { rect: centre, threshold });

  checks.push(thresholdCheck('canvas is non-blank (distinct colours)', stats.distinctColours, { min: spec.minDistinctColours ?? 2 }, ' colours'));
  checks.push(thresholdCheck('non-background fraction', stats.nonBackgroundFraction, { min: spec.minNonBackground ?? 0.01 }));
  checks.push(thresholdCheck('mean luminance is neither black nor blown out', stats.meanLuminance, { min: spec.minMeanLuminance ?? 2, max: spec.maxMeanLuminance ?? 250 }));
  checks.push(thresholdCheck('opaque fraction (RGBA canvas)', stats.opaqueFraction, { min: spec.minOpaque ?? 0.5 }));
  checks.push(
    thresholdCheck(
      `bright pixels in centre ${formatRect(centre)}`,
      centreStats.aboveThreshold,
      { min: spec.minBrightFractionCentre ?? 0.001 },
    ),
  );

  // A centred bright region can come from a page-wide gradient; requiring the
  // bright pixels' centroid to be near the middle separates "the model is framed"
  // from "the background is lit".
  const centroid = stats.brightCentroid;
  const dx = centroid.x == null ? Infinity : Math.abs(centroid.x - image.width / 2) / (image.width / 2);
  const dy = centroid.y == null ? Infinity : Math.abs(centroid.y - image.height / 2) / (image.height / 2);
  const tolerance = spec.centroidTolerance ?? 0.5;
  checks.push({
    name: 'bright centroid is near the frame centre',
    pass: Number.isFinite(dx) && dx <= tolerance && dy <= tolerance,
    detail: centroid.x == null
      ? `no pixels above luma ${threshold}`
      : `(${centroid.x.toFixed(1)}, ${centroid.y.toFixed(1)}) offset ${(dx * 100).toFixed(1)}% / ${(dy * 100).toFixed(1)}% of half-size (want <= ${(tolerance * 100).toFixed(0)}%)`,
  });

  return checks;
}

/**
 * Render the table. Widths are computed from the content so long URLs and detail
 * strings do not wreck alignment.
 */
export function formatTable(rows) {
  const header = ['status', '#', 'check', 'detail'];
  const body = rows.map((row, index) => [row.pass ? 'PASS' : 'FAIL', String(index + 1), row.name, row.detail]);
  const all = [header, ...body];
  const widths = header.map((_, column) => Math.max(...all.map((line) => String(line[column]).length)));
  const line = (cells) => cells.map((cell, column) => (column === cells.length - 1 ? String(cell) : String(cell).padEnd(widths[column]))).join('  ');
  const divider = widths.map((width) => '-'.repeat(width)).join('  ');
  return [line(header), divider, ...body.map(line)].join('\n');
}

/**
 * Run one suite. `out` defaults to a fresh temp dir because a screenshot is an
 * artifact for inspection, not a checked-in file; passing `--out` keeps it.
 */
export async function runSuite(name, options = {}) {
  const spec = typeof name === 'string' ? SUITES[name] : name;
  if (!spec) throw new Error(`unknown suite "${name}"; known: ${Object.keys(SUITES).join(', ')}`);

  // Decoder self-test short-circuits before any browser work: it is a pure
  // in-process check, and starting Chrome for it would only add 8 seconds.
  if (spec.fixtures) return runPngSuite(typeof name === 'string' ? name : 'png', spec);

  const workDir = options.out ? dirname(resolve(options.out)) : await mkdtemp(join(tmpdir(), 'dsh-verify-'));
  await mkdir(workDir, { recursive: true });
  const out = options.out ? resolve(options.out) : join(workDir, `${spec.name ?? 'shot'}.png`);

  const shotResult = await shoot({
    url: options.url ?? spec.url,
    out,
    root: options.root ?? spec.root ?? null,
    size: options.size,
    expectations: [],
    rejections: [],
    chrome: options.chrome ?? null,
    timeoutMs: options.timeoutMs,
    virtualTimeBudget: options.virtualTimeBudget,
    quiet: true,
  });

  let image = null;
  let decodeError = null;
  try {
    image = await readPng(out);
  } catch (error) {
    decodeError = error.message;
  }

  const checks = buildChecks(spec, { image, shotResult });
  if (decodeError) {
    // Replace the generic first check with the concrete reason.
    const index = checks.findIndex((check) => check.name === 'screenshot decodes as PNG');
    if (index >= 0) checks[index] = { name: 'screenshot decodes as PNG', pass: false, detail: decodeError };
  }

  return {
    suite: typeof name === 'string' ? name : (spec.name ?? 'custom'),
    title: spec.title ?? null,
    ok: checks.every((check) => check.pass),
    checks,
    image,
    stats: image ? analyse(image, { threshold: spec.brightThreshold ?? 150 }) : null,
    shot: shotResult,
    out,
    workDir: options.out ? dirname(resolve(options.out)) : workDir,
    tempWorkspace: options.out ? null : workDir,
  };
}

/**
 * Decoder self-test suite: compare decoded RGBA for each fixture against the
 * hash recorded in `expected.json`. The expectations were generated by a
 * separate PNG encoder/decoder, so this catches implementation bugs rather than
 * merely pinning current behaviour.
 */
async function runPngSuite(name, spec) {
  const dir = resolve(spec.fixtures);
  const { readFile } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const expected = JSON.parse(await readFile(join(dir, 'expected.json'), 'utf8'));
  const checks = [];
  for (const [fixture, want] of Object.entries(expected)) {
    try {
      const image = await readPng(join(dir, `${fixture}.png`));
      const got = createHash('sha256').update(image.data).digest('hex');
      const shapeOk = image.width === want.width && image.height === want.height;
      const pixelsOk = got === want.rgbaSha256;
      checks.push({
        name: `${fixture} decodes correctly`,
        pass: shapeOk && pixelsOk,
        detail: shapeOk && pixelsOk
          ? `${want.width}x${want.height} colourType=${want.colorType} bitDepth=${want.bitDepth}, RGBA hash matches`
          : shapeOk
            ? `RGBA mismatch (want ${want.rgbaSha256.slice(0, 12)}…, got ${got.slice(0, 12)}…)`
            : `size mismatch: got ${image.width}x${image.height}, want ${want.width}x${want.height}`,
      });
    } catch (error) {
      checks.push({ name: `${fixture} decodes correctly`, pass: false, detail: error.message });
    }
  }
  return {
    suite: name,
    title: spec.title,
    ok: checks.every((check) => check.pass),
    checks,
    image: null,
    stats: null,
    shot: null,
    out: dir,
    workDir: dir,
    tempWorkspace: null,
  };
}

const HELP = `report.mjs — run named screenshot/pixel checks against a page and print a table.

Usage:
  node verify/report.mjs [suite] [options]

Suites:
  reference   (default) the /tmp/embed-poc reference embed page: asserts the page
              reported success in its DOM and that the canvas is non-blank, has a
              sensible mean luminance, is opaque, and has bright pixels near the
              frame centre.
  png         Decoder self-test, no browser: decodes verify/fixtures/png/*.png
              (all PNG colour types) and compares the RGBA output against hashes
              from an independent encoder.

Options:
  --suite <name>       Suite to run (default: reference)
  --url <url|path>     Override the page URL/path
  --serve <dir>        Static root to serve from (overrides the suite's root)
  --size W,H           Viewport size (default 620,460)
  --out <file.png>     Keep the screenshot here instead of a temp directory
  --chrome <path>      Chrome executable (default: ${DEFAULT_CHROME})
  --timeout <ms>       Kill Chrome after this long (default 120000)
  --virtual-time-budget <ms>  Chrome fast-forward budget (default 8000)
  --json               Print the result (and all checks) as JSON
  --list               List available suites
  --help, -h           Show this help

Exit codes:
  0 = every check passed
  1 = at least one check failed, or the screenshot could not be taken
  2 = bad arguments
`;

class UsageError extends Error {}

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = { suite: 'reference', json: false, help: false, list: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const value = () => {
      const next = args[++i];
      if (next === undefined) throw new UsageError(`${arg} needs a value`);
      return next;
    };
    switch (arg) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--list':
        options.list = true;
        break;
      case '--suite':
        options.suite = value();
        break;
      case '--url':
        options.url = value();
        break;
      case '--serve':
      case '--root':
        options.root = value();
        break;
      case '--size': {
        const match = value().match(/^(\d+)[,x](\d+)$/);
        if (!match) throw new UsageError('bad --size, expected W,H');
        options.size = { width: Number(match[1]), height: Number(match[2]) };
        break;
      }
      case '--out':
        options.out = value();
        break;
      case '--chrome':
        options.chrome = value();
        break;
      case '--timeout':
        options.timeoutMs = Number.parseInt(value(), 10);
        break;
      case '--virtual-time-budget':
        options.virtualTimeBudget = Number.parseInt(value(), 10);
        break;
      case '--json':
        options.json = true;
        break;
      default:
        if (arg.startsWith('-')) throw new UsageError(`unknown option ${arg}`);
        if (options.suiteExplicit) throw new UsageError(`unexpected argument ${arg}`);
        options.suite = arg;
        options.suiteExplicit = true;
    }
  }
  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (options.list) {
    for (const [name, spec] of Object.entries(SUITES)) process.stdout.write(`${name.padEnd(12)} ${spec.title ?? ''}\n`);
    return 0;
  }

  // An unknown suite name is a bad argument, not a check failure, so surface it as
  // exit 2 before any Chrome launch is attempted.
  if (!SUITES[options.suite]) {
    throw new UsageError(`unknown suite "${options.suite}"; known: ${Object.keys(SUITES).join(', ')}`);
  }

  const result = await runSuite(options.suite, options);
  if (options.json) {
    const { image, stats, shot, ...rest } = result;
    // The browser suites have a shoot() result to summarise; the decoder suite
    // does not, so fold the markers in only when present.
    process.stdout.write(
      `${JSON.stringify(
        { ...rest, stats, ...(shot ? { markers: shot.markers, title: shot.title, url: shot.url } : {}) },
        null,
        2,
      )}\n`,
    );
  } else {
    const rows = [];
    // The DOM title is shown as context, not as a check: pages do not always set
    // one, and the pixel checks are the ones that matter.
    process.stdout.write(`suite: ${result.suite}${result.title ? ` — ${result.title}` : ''}\n`);
    if (result.shot) {
      process.stdout.write(`url:   ${result.shot.url}\n`);
      process.stdout.write(`shot:  ${result.out}\n`);
      process.stdout.write(`title: ${result.shot.title ?? '(none)'}\n\n`);
    } else {
      process.stdout.write(`dir:   ${result.out}\n\n`);
    }
    if (result.stats) {
      const s = result.stats;
      process.stdout.write(
        `measured: ${s.distinctColours} colours, non-background ${(s.nonBackgroundFraction * 100).toFixed(2)}%, ` +
          `mean luma ${s.meanLuminance.toFixed(2)}, opaque ${(s.opaqueFraction * 100).toFixed(1)}%\n\n`,
      );
    }
    for (const check of result.checks) rows.push(check);
    process.stdout.write(`${formatTable(rows)}\n\n`);
    const passed = result.checks.filter((check) => check.pass).length;
    process.stdout.write(`${result.ok ? 'PASS' : 'FAIL'} — ${passed}/${result.checks.length} checks passed\n`);
  }

  // Only clean up a temp workspace we created; a caller-provided --out is theirs.
  if (result.tempWorkspace && !options.json) {
    await rm(result.tempWorkspace, { recursive: true, force: true }).catch(() => {});
  }
  return result.ok ? 0 : 1;
}

if (isMain(import.meta.url)) {
  main(process.argv).then(
    (code) => process.exit(code),
    (error) => {
      const usage = error instanceof UsageError;
      process.stderr.write(`${usage ? '' : 'report: '}${error.message}\n`);
      if (usage) process.stderr.write('Try --help.\n');
      process.exit(usage ? 2 : 1);
    },
  );
}
