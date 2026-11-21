# verify/ — headless screenshot + pixel verification harness

Zero-dependency Node ESM harness for checking what the 3D viewer actually draws.
It drives the Chrome binary directly (no Puppeteer/Playwright — neither is
installed and there is no network to install them) and decodes the resulting PNG
with `node:zlib` and a hand-written PNG reader.

Everything here writes only inside `verify/` and temp directories. It never
touches `embed/`, `src/`, or `build.mjs`.

## Commands

```bash
# 1. Full chain: render the reference page and assert DOM + pixels. Exit 0 = pass.
node verify/report.mjs

# 2. Just a screenshot, printing the detected document.title.
node verify/shoot.mjs <url-or-path> <out.png> --size 620,460

# 3. Pixel statistics for any PNG.
node verify/pixels.mjs <image.png> [--rect x,y,w,h] [--threshold N] [--json]

# 4. Decoder self-test (no browser): all PNG colour types vs. known-good hashes.
node verify/report.mjs png
```

Every script accepts `--help` and uses exit codes **0 = pass, 1 = fail,
2 = bad arguments**.

## What each piece verifies

| File | Verifies |
| --- | --- |
| `shoot.mjs` | Chrome starts, loads the page, paints, writes a PNG, and the page's DOM markers (`title`, `#log`, `meta[verify-result]`) match `--expect` / `--reject` patterns. |
| `pixels.mjs` | The PNG is valid and decodable; reports distinct colours, non-background fraction, mean luminance (whole frame or a rectangle), fraction above/below a luma threshold, non-transparent fraction, and the centroid of bright pixels. |
| `report.mjs` | The whole chain, as a pass/fail table. The `reference` suite asserts the page's own success markers *and* that the canvas is non-blank with a bright, centred render — the two together catch "rendered nothing but reported success". |
| `report.mjs png` | The decoder itself: eight fixtures covering greyscale, RGB, palette, alpha, 1/4/16-bit and every scanline filter, compared against hashes from an independent encoder. |

## Reference-page measurements (620×460)

From `/tmp/embed-poc/index.html` (849076-byte 3MF, 4420 triangles):

| Metric | Value |
| --- | --- |
| Distinct colours | 1596 |
| Non-background fraction | 5.58 % |
| Mean luminance (whole frame) | 19.20 |
| Pixels above luma 150 | 0.65 % |
| Bright centroid | (247.4, 121.1) |
| Opaque fraction | 100 % (Chrome wrote 8-bit RGB, colour type 2) |

Repeated runs at the same size produce a **byte-identical** PNG (SHA-256
`84fc0354…`), which is what makes pixel thresholds safe to assert on.

## Design notes

- `--user-data-dir` is mandatory: without it Chrome aborts with "Failed to create
  headless user data directory container". Each run gets a throwaway profile that
  is deleted afterwards.
- `--use-angle=metal` selects the real GPU via ANGLE/Metal. `--no-gpu` drops it
  and falls back to SwiftShader; both paths were measured to render identically
  here, so the flag exists for machines where one backend misbehaves.
- `--dump-dom` is the only channel for page state. `console.log` is invisible
  without a DevTools client, so pages must publish results into the DOM.
- `--screenshot` and `--dump-dom` are requested in a single Chrome run, since
  each launch costs several seconds.
- `--force-device-scale-factor=1` keeps CSS pixels equal to PNG pixels, so pixel
  checks can be written in viewport coordinates.
- `--virtual-time-budget` is virtual, not wall-clock: Chrome fast-forwards timers
  and animation frames, then screenshots.
- A self-started static server (on an OS-assigned free port) is used because the
  pages `fetch()` their model; `file://` blocks that. The server is closed and the
  profile deleted in a `finally`, so runs leak neither ports nor disk.
- Luminance is Rec.709 on gamma-encoded samples — i.e. the brightness a person
  sees — on the 0..255 scale. Fully transparent pixels are skipped in every
  statistic so an RGBA render is not scored as black.

## Limitations

- Interlaced PNGs are rejected rather than decoded; Chrome never emits them.
- Only one page per run, and only one suite at a time.
- The `reference` suite reads `/tmp/embed-poc`, a scratch directory outside this
  repo. If it is gone, point `--serve`/`--url` at a hosted copy; the fixtures in
  `verify/fixtures/` and the `png` suite stay self-contained.
- Pixel thresholds assume the 620×460 layout. At other sizes the model occupies a
  different fraction of the frame, so the `min*` bounds may need adjusting.
