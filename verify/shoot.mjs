#!/usr/bin/env node
/**
 * Screenshot a page with headless Chrome and read state back out of the DOM.
 *
 * Why this exists: the only reliable renderer on this machine is Chrome's
 * `--headless=new` with `--use-angle=metal` (real GPU WebGL). Puppeteer and
 * Playwright are not installed and cannot be, so this drives the browser binary
 * directly and uses two built-in flags instead of a DevTools client:
 *
 *   --screenshot   writes the viewport to a PNG,
 *   --dump-dom     prints the settled DOM to stdout.
 *
 * `console.log` is invisible without a DevTools protocol client, so pages must
 * publish their result into the DOM (document.title, #log, a meta tag); this
 * module greps those out and hands them back as text.
 *
 * Two flags are load-bearing and must not be "cleaned up":
 *   --user-data-dir  Chrome aborts with "Failed to create headless user data
 *                    directory container" without it, so every run gets its own
 *                    throwaway profile.
 *   --use-angle=metal  without an ANGLE backend the page may get no WebGL
 *                    context at all on this Mac, and the screenshot is blank.
 */

import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const DEFAULT_SIZE = { width: 620, height: 460 };
/** Generous: a cold Chrome start plus a 3MF fetch and WebGL init can take seconds. */
export const DEFAULT_TIMEOUT_MS = 120_000;
/**
 * The budget is virtual time, not wall time: Chrome fast-forwards timers and
 * animation frames until the budget is spent, then screenshots. 8000ms is enough
 * for the reference page to fetch, parse and draw a model.
 */
export const DEFAULT_VIRTUAL_TIME_BUDGET = 8000;

/** Content types the viewer's pages actually request; anything else is served as bytes. */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.wasm': 'application/wasm',
  // Model formats are opaque to the server; the viewer fetches them as bytes.
  '.3mf': 'application/octet-stream',
  '.stl': 'application/octet-stream',
  '.obj': 'text/plain; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
};

/**
 * Serve `root` over HTTP on an ephemeral port.
 *
 * A server is needed because the pages fetch their model with `fetch('/x.3mf')`,
 * and `file://` origins block that (and taint the canvas). Port 0 asks the OS for
 * a free port, which keeps concurrent runs from colliding; the actual port is
 * read back from `address()`.
 *
 * Returns `close()` that resolves once the listener is gone, so the process can
 * exit without a lingering handle.
 */
export async function startStaticServer(root, { host = '127.0.0.1', port = 0, quiet = true } = {}) {
  const base = resolve(root);
  const info = await stat(base).catch(() => null);
  if (!info || !info.isDirectory()) throw new Error(`static root is not a directory: ${base}`);

  const server = createServer(async (req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end('bad url');
      return;
    }
    // Reject traversal: resolving and re-checking the prefix is the only way to
    // be sure the request stays inside the tree after `..` and symlink-free
    // normalisation (symlink escapes are a local-only risk and accepted here).
    const target = normalize(join(base, pathname));
    if (target !== base && !target.startsWith(base + sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    let file = target;
    const targetInfo = await stat(file).catch(() => null);
    if (!targetInfo) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    if (targetInfo.isDirectory()) {
      // Directory requests resolve to index.html; no listing is exposed.
      file = join(target, 'index.html');
      const indexInfo = await stat(file).catch(() => null);
      if (!indexInfo) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('no index.html');
        return;
      }
    }

    const size = (await stat(file)).size;
    const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
    // No caching headers on purpose: every verification run must see the bytes
    // currently on disk, not what a previous run cached in a reused profile.
    res.writeHead(200, {
      'content-type': type,
      'content-length': size,
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file).pipe(res);
  });

  server.on('clientError', (error, socket) => socket.destroy());

  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, host, done);
  });
  const actualPort = server.address().port;
  if (!quiet) process.stderr.write(`static server ${base} -> http://${host}:${actualPort}\n`);

  return {
    server,
    root: base,
    host,
    port: actualPort,
    origin: `http://${host}:${actualPort}`,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections?.();
        server.close(() => done());
      }),
  };
}

/** Cheap liveness probe: is something already answering HTTP at this origin? */
async function originAlive(url, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: 'GET', signal: controller.signal });
    // Any HTTP answer, including 404, proves a server is listening there.
    await response.arrayBuffer().catch(() => {});
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Decode the handful of entities a page is likely to put in a title or log. */
export function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return named[body.toLowerCase()] ?? match;
  });
}

/**
 * Pull verifiable state out of a dumped DOM.
 *
 * Pages cannot call back into this process, so the contract is "write your result
 * where a human would read it". We collect every such place rather than inventing
 * a protocol: the title, an element with a conventional id, and a meta/body
 * marker are all cheap and survive re-renders differently, so checking all of
 * them is more robust than picking one.
 */
export function parseDom(dom) {
  const text = String(dom ?? '');
  const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : null;

  /** Text content of a marker element, tags stripped. */
  const elementText = (id) => {
    const pattern = new RegExp(`<([a-z0-9]+)[^>]*\\bid\\s*=\\s*["']${id}["'][^>]*>([\\s\\S]*?)<\\/\\1>`, 'i');
    const match = text.match(pattern);
    return match ? decodeEntities(match[2].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim() : null;
  };

  const logs = {};
  for (const id of ['log', 'result', 'status', 'verify-result', 'verifyResult']) {
    const value = elementText(id);
    if (value) logs[id] = value;
  }

  const meta = {};
  for (const name of ['verify-result', 'result', 'verify-status']) {
    const match = text.match(new RegExp(`<meta[^>]+name\\s*=\\s*["']${name}["'][^>]*content\\s*=\\s*["']([^"']*)["']`, 'i'));
    if (match) meta[name] = decodeEntities(match[1]).trim();
  }

  const markers = [];
  if (title) markers.push({ source: 'title', text: title });
  for (const [id, value] of Object.entries(logs)) markers.push({ source: `#${id}`, text: value });
  for (const [name, value] of Object.entries(meta)) markers.push({ source: `meta[${name}]`, text: value });

  // A marker is "the" result when the page says so explicitly; otherwise the
  // title wins because --dump-dom always has one.
  const result = meta['verify-result'] ?? logs['verify-result'] ?? logs.result ?? title ?? null;

  return { title, logs, meta, markers, result, html: text };
}

/**
 * Compile a CLI expectation. A bare string is a RegExp source, so `tris=4420`
 * works without escaping; the `/pattern/flags` form allows case-insensitive
 * matching. Invalid regexes throw rather than silently never matching.
 */
export function compilePattern(spec) {
  if (spec instanceof RegExp) return spec;
  const text = String(spec);
  const slashed = text.match(/^\/([\s\S]*)\/([gimsuy]*)$/);
  if (slashed) return new RegExp(slashed[1], slashed[2]);
  return new RegExp(text);
}

/** Parse `W,H` (or `WxH`) into a window size. */
export function parseSize(text, fallback = DEFAULT_SIZE) {
  if (!text) return { ...fallback };
  const match = String(text).match(/^\s*(\d+)\s*[,xX]\s*(\d+)\s*$/);
  if (!match) throw new Error(`bad --size "${text}", expected W,H`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) throw new Error(`bad --size "${text}", both sides must be positive`);
  return { width, height };
}

/** Resolve a Chrome executable, preferring an explicit path. */
async function resolveChrome(explicit) {
  const candidates = explicit ? [explicit] : [DEFAULT_CHROME, '/Applications/Chromium.app/Contents/MacOS/Chromium'];
  for (const candidate of candidates) {
    const info = await stat(candidate).catch(() => null);
    if (info?.isFile()) return candidate;
  }
  throw new Error(`Chrome not found (looked at ${candidates.join(', ')}); pass --chrome <path>`);
}

/** Run a child process to completion, capturing stdout/stderr and enforcing a deadline. */
function run(command, args, { timeoutMs }) {
  return new Promise((done) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      done({ code: null, signal: null, stdout: '', stderr: String(error.message), spawnError: error, killed });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      done({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        spawnError: null,
        killed,
      });
    });
  });
}

/**
 * Take one screenshot. Resolves with everything a check might need; it does not
 * throw on a failed expectation so callers can report all failures at once.
 *
 * `url` may be:
 *   - an absolute http(s) URL, used as-is when a server already answers there;
 *   - a filesystem path, served from its own directory;
 *   - any path when `root` is given, served from `root` on a fresh free port
 *     (this is the deterministic mode: content is read from disk, not from a
 *     server that may be stale or dead).
 */
export async function shoot({
  url,
  out,
  size = DEFAULT_SIZE,
  root = null,
  expectations = [],
  rejections = [],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  virtualTimeBudget = DEFAULT_VIRTUAL_TIME_BUDGET,
  chrome = null,
  chromeArgs = [],
  keepProfile = false,
  useGpu = true,
  dumpDomPath = null,
  quiet = true,
} = {}) {
  if (!url) throw new Error('shoot(): url is required');
  if (!out) throw new Error('shoot(): out (PNG path) is required');

  const started = Date.now();
  const outPath = resolve(out);
  await mkdir(dirname(outPath), { recursive: true });

  let server = null;
  let serveNote = null;
  let pageUrl;

  const isHttp = /^https?:\/\//i.test(String(url));
  if (root) {
    // Explicit root always wins: start our own server so the run is reproducible.
    server = await startStaticServer(root, { quiet });
    const requested = new URL(isHttp ? url : `http://127.0.0.1${String(url).startsWith('/') ? '' : '/'}${url}`);
    pageUrl = `${server.origin}${requested.pathname}${requested.search}`;
    serveNote = `served ${server.root} on ${server.origin}`;
  } else if (isHttp) {
    if (await originAlive(url)) {
      pageUrl = url;
      serveNote = 'used the server already listening at that URL';
    } else {
      throw new Error(`no server answers ${url}; start one or pass --serve <dir>`);
    }
  } else {
    // A bare path: serve its containing directory and request the file name.
    const absolute = resolve(url);
    server = await startStaticServer(dirname(absolute), { quiet });
    pageUrl = `${server.origin}/${encodeURIComponent(absolute.slice(dirname(absolute).length + 1))}`;
    serveNote = `served ${server.root} on ${server.origin}`;
  }

  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-chrome-profile-'));
  const chromePath = await resolveChrome(chrome);
  const { width, height } = size;

  const args = [
    '--headless=new',
    // Containers and some managed Macs sandbox the GPU process too aggressively.
    '--no-sandbox',
    `--user-data-dir=${profileDir}`,
    // ANGLE/Metal gives a real GPU context; SwiftShader is the fallback for the
    // same reason Plus Graphics Macs report it — one of the two always renders.
    ...(useGpu ? ['--use-angle=metal'] : []),
    '--enable-unsafe-swiftshader',
    '--hide-scrollbars',
    // Keep CSS pixels equal to device pixels so a 620x460 request really writes a
    // 620x460 PNG and pixel checks can be written in viewport coordinates.
    '--force-device-scale-factor=1',
    `--window-size=${width},${height}`,
    `--screenshot=${outPath}`,
    `--virtual-time-budget=${virtualTimeBudget}`,
    // Chrome writes the PNG when it exits; --dump-dom is the only channel for
    // page state, so both are requested in one run.
    '--dump-dom',
    ...chromeArgs,
    pageUrl,
  ];

  let runResult = null;
  let failure = null;
  try {
    runResult = await run(chromePath, args, { timeoutMs });
    if (runResult.spawnError) throw new Error(`could not start Chrome: ${runResult.spawnError.message}`);
    if (runResult.killed) throw new Error(`Chrome did not exit within ${timeoutMs}ms`);

    const pngInfo = await stat(outPath).catch(() => null);
    if (!pngInfo || pngInfo.size === 0) {
      // Chrome exits 0 even when it never got to paint, so the file is the real
      // signal. Surface its stderr because that is where the reason appears.
      const tail = runResult.stderr.trim().split('\n').slice(-6).join('\n');
      throw new Error(`Chrome wrote no screenshot to ${outPath}${tail ? `\n${tail}` : ''}`);
    }
  } catch (error) {
    failure = error;
  } finally {
    // Always free the port and the profile: a leaked listener keeps the process
    // alive, and a leaked profile grows by tens of MB per run.
    if (server) await server.close().catch(() => {});
    if (!keepProfile) await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }

  if (failure) throw failure;

  const pngInfo = await stat(outPath);
  const dom = runResult.stdout;
  if (!dom.includes('<html') && !dom.includes('<!DOCTYPE') && !dom.includes('<!doctype')) {
    const tail = runResult.stderr.trim().split('\n').slice(-6).join('\n');
    throw new Error(`Chrome dumped no DOM for ${pageUrl}${tail ? `\n${tail}` : ''}`);
  }

  const parsed = parseDom(dom);
  const haystack = parsed.markers.map((marker) => `${marker.source}: ${marker.text}`).join('\n') || '';

  const checks = [];
  for (const spec of expectations) {
    const pattern = compilePattern(spec);
    const match = haystack.match(pattern);
    checks.push({ spec: String(spec), kind: 'expect', pass: Boolean(match), where: match ? matchedSource(parsed, match[0]) : null });
  }
  for (const spec of rejections) {
    const pattern = compilePattern(spec);
    const match = haystack.match(pattern);
    checks.push({ spec: String(spec), kind: 'reject', pass: !match, where: match ? matchedSource(parsed, match[0]) : null });
  }

  if (dumpDomPath) {
    await mkdir(dirname(resolve(dumpDomPath)), { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(resolve(dumpDomPath), dom, 'utf8');
  }

  return {
    ok: checks.every((check) => check.pass),
    url: pageUrl,
    out: outPath,
    pngBytes: pngInfo.size,
    width,
    height,
    title: parsed.title,
    result: parsed.result,
    markers: parsed.markers,
    dom,
    checks,
    chromeExitCode: runResult.code,
    chromeStderrTail: runResult.stderr.trim().split('\n').slice(-4).join('\n') || null,
    serveNote,
    durationMs: Date.now() - started,
  };
}

/** Which marker did a pattern match, for actionable failure output. */
function matchedSource(parsed, fragment) {
  const found = parsed.markers.find((marker) => marker.text.includes(fragment));
  return found ? found.source : null;
}

const HELP = `shoot.mjs — screenshot a page with headless Chrome and read its DOM.

Usage:
  node verify/shoot.mjs <url|path> <out.png> [options]

Arguments:
  <url|path>         http(s) URL, or a filesystem path to an .html file.
                     With --serve, the URL's path is re-rooted at --serve.
  <out.png>          Where Chrome writes the screenshot (parents are created).

Options:
  --size W,H         Viewport/window size in CSS px (default 620,460)
  --serve <dir>      Always start a static server on a free port rooted at <dir>.
                     Without this, an http URL is used only if something already
                     answers it; a bare path is served from its own directory.
  --expect <pat>     Repeatable. The page's DOM markers (title, #log, #result,
                     meta[verify-result]) must match this JS regex. Use
                     /pattern/flags for case-insensitive matching.
  --reject <pat>     Repeatable. The markers must NOT match (e.g. "FAIL").
  --virtual-time-budget <ms>  Chrome fast-forward budget (default 8000)
  --timeout <ms>     Kill Chrome after this long (default 120000)
  --chrome <path>    Chrome executable (default: Google Chrome.app)
  --chrome-arg <a>   Repeatable. Extra flag passed through to Chrome verbatim.
  --no-gpu           Omit --use-angle=metal (software WebGL fallback)
  --keep-profile     Keep the throwaway user-data dir (for debugging)
  --dump-dom <file>  Also save the raw dumped DOM to this path
  --verbose          Print the static server's root and port to stderr
  --json             Print the full result object as JSON
  --help, -h         Show this help

Prints the detected document.title and each expectation, then a summary line.

Exit codes:
  0 = screenshot taken and every --expect/--reject passed
  1 = Chrome failed, wrote no PNG, or an expectation failed
  2 = bad arguments (unknown flag, unparseable --size, bad regex)
`;

class UsageError extends Error {}

/** True when this module is the process entry point (paths may contain spaces/non-ASCII). */
export function isMain(moduleUrl, argv = process.argv) {
  if (!argv[1]) return false;
  try {
    return resolve(fileURLToPath(moduleUrl)) === resolve(argv[1]);
  } catch {
    return false;
  }
}

/** Parse argv into shoot() options; shared by the CLI and by report.mjs. */
export function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    url: null,
    out: null,
    size: { ...DEFAULT_SIZE },
    root: null,
    expectations: [],
    rejections: [],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    virtualTimeBudget: DEFAULT_VIRTUAL_TIME_BUDGET,
    chrome: null,
    chromeArgs: [],
    keepProfile: false,
    useGpu: true,
    dumpDomPath: null,
    quiet: true,
    json: false,
    help: false,
  };

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
      case '--size':
        // parseSize is also used programmatically, so re-tag its failure as a
        // usage error here to get exit 2 instead of 1.
        try {
          options.size = parseSize(value());
        } catch (error) {
          throw new UsageError(error.message);
        }
        break;
      case '--serve':
      case '--root':
        options.root = value();
        break;
      case '--expect':
        options.expectations.push(value());
        break;
      case '--reject':
        options.rejections.push(value());
        break;
      case '--virtual-time-budget':
        options.virtualTimeBudget = Number.parseInt(value(), 10);
        break;
      case '--timeout':
        options.timeoutMs = Number.parseInt(value(), 10);
        break;
      case '--chrome':
        options.chrome = value();
        break;
      case '--chrome-arg':
        options.chromeArgs.push(value());
        break;
      case '--no-gpu':
        options.useGpu = false;
        break;
      case '--keep-profile':
        options.keepProfile = true;
        break;
      case '--dump-dom':
        options.dumpDomPath = value();
        break;
      case '--verbose':
        options.quiet = false;
        break;
      case '--json':
        options.json = true;
        break;
      default:
        if (arg.startsWith('-')) throw new UsageError(`unknown option ${arg}`);
        if (!options.url) options.url = arg;
        else if (!options.out) options.out = arg;
        else throw new UsageError(`unexpected argument ${arg}`);
    }
  }

  if (options.help) return options;
  if (!options.url) throw new UsageError('missing <url|path>');
  if (!options.out) throw new UsageError('missing <out.png>');
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new UsageError('--timeout must be positive');
  if (!Number.isFinite(options.virtualTimeBudget) || options.virtualTimeBudget < 0) {
    throw new UsageError('--virtual-time-budget must be >= 0');
  }
  // Validate regexes before launching Chrome: a typo should not cost a 5s render.
  // Re-tag the error as a usage problem so the exit code says "bad arguments".
  for (const spec of [...options.expectations, ...options.rejections]) {
    try {
      compilePattern(spec);
    } catch (error) {
      throw new UsageError(`bad pattern "${spec}": ${error.message}`);
    }
  }
  return options;
}

/** Render a shoot() result as a short human-readable report. */
export function formatResult(result) {
  const lines = [
    `detected document.title: ${result.title ?? '(none)'}`,
    `page result marker:      ${result.result ?? '(none)'}`,
    `screenshot:              ${result.out} (${result.pngBytes} bytes, ${result.width}x${result.height})`,
  ];
  if (result.serveNote) lines.push(`server:                  ${result.serveNote}`);
  if (result.markers.length > 1) {
    lines.push('markers:');
    for (const marker of result.markers) lines.push(`  ${marker.source}: ${truncate(marker.text, 160)}`);
  }
  for (const check of result.checks) {
    const label = check.kind === 'expect' ? 'expect' : 'reject';
    const status = check.pass ? 'PASS' : 'FAIL';
    lines.push(`  [${status}] ${label} /${check.spec}/${check.where ? ` (matched in ${check.where})` : ''}`);
  }
  return lines.join('\n');
}

function truncate(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const result = await shoot(options);
  if (options.json) {
    const { dom, ...rest } = result;
    process.stdout.write(`${JSON.stringify(rest, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatResult(result)}\n`);
    process.stdout.write(`${result.ok ? 'PASS' : 'FAIL'} (${result.durationMs}ms)\n`);
  }
  return result.ok ? 0 : 1;
}

if (isMain(import.meta.url)) {
  main(process.argv).then(
    (code) => process.exit(code),
    (error) => {
      const usage = error instanceof UsageError;
      process.stderr.write(`${usage ? '' : 'shoot: '}${error.message}\n`);
      if (usage) process.stderr.write('Try --help.\n');
      process.exit(usage ? 2 : 1);
    },
  );
}
