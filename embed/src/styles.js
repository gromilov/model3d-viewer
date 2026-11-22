/**
 * The panel's stylesheet.
 *
 * Written as CSS rather than inline styles for two reasons. Hover and active
 * states are a selector's job, and doing them in JavaScript means a `useState`
 * per button and a repaint on every pointer enter. And a component that is meant
 * to be dropped into someone else's page should not be a wall of inline styles
 * on every node: one injected sheet is smaller and can be overridden by the host
 * with a single custom property.
 *
 * Everything is namespaced under `[data-model3d-viewer]` and prefixed `.m3d-`,
 * so including this twice, or alongside a host's own styles, cannot leak.
 */

const CSS = `
[data-model3d-viewer] {
  --m3d-accent: #118980;
  --m3d-accent-soft: rgba(17, 137, 128, 0.16);
  --m3d-accent-line: rgba(17, 137, 128, 0.45);
  --m3d-surface: rgba(24, 25, 27, 0.78);
  --m3d-surface-solid: #1c1d20;
  --m3d-hairline: rgba(255, 255, 255, 0.10);
  --m3d-hairline-strong: rgba(255, 255, 255, 0.18);
  --m3d-text: #d6d8db;
  --m3d-text-dim: rgba(214, 216, 219, 0.52);
  --m3d-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;

  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--m3d-surface-solid);
  color: var(--m3d-text);
  font-family: var(--m3d-mono);
  /* A preview is a tool, not a document: nothing here should be selectable by
     accident when a drag was meant to orbit the model. */
  user-select: none;
  -webkit-user-select: none;
}

/* The panel toggles parts of itself with the hidden attribute. A class rule
   that sets display outranks the user agent's [hidden] { display: none }, so
   without this the surface row would stay visible in plain mode -- a conditional
   row that never hides is worse than no condition at all. */
[data-model3d-viewer] [hidden] { display: none !important; }

/* ---------------------------------------------------------------- toolbar -- */

[data-model3d-viewer] .m3d-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--m3d-hairline);
  /* A hairline of accent under the toolbar: the one decorative line the
     interface carries. */
  box-shadow: inset 0 -1px 0 var(--m3d-accent-soft);
  background: var(--m3d-surface);
  backdrop-filter: blur(8px);
  flex: 0 0 auto;
}

/* The stats line gives way to the controls rather than the other way round. It had
   margin-left:auto with no shrink, so in a narrow sidebar it kept its natural width
   and pushed the last buttons past the right edge -- the save-the-traced-image
   button simply vanished when it appeared. min-width:0 lets it shrink, and the
   ellipsis says the line is truncated instead of the controls disappearing. */
[data-model3d-viewer] .m3d-stats {
  margin-left: auto;
  color: var(--m3d-text-dim);
  font-size: 10px;
  letter-spacing: 0.04em;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 0 1 auto;
  min-width: 0;
}

/* A button is a target, not a box: no border, no outline. Its state reads from
   the fill behind the glyph and the glyph's colour, which is enough at this size
   and keeps the row from looking like a table of cells. */
[data-model3d-viewer] .m3d-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--m3d-text-dim);
  width: 24px;
  height: 24px;
  padding: 0;
  cursor: pointer;
  transition: color 120ms, background 120ms;
  flex: 0 0 auto;
}
[data-model3d-viewer] .m3d-btn:hover { background: var(--m3d-hairline); }
[data-model3d-viewer] .m3d-btn.is-pressed {
  background: var(--m3d-accent-soft);
  color: var(--m3d-accent);
}
[data-model3d-viewer] .m3d-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
[data-model3d-viewer] .m3d-btn:disabled:hover { background: transparent; }
[data-model3d-viewer] .m3d-btn:focus-visible {
  outline: 1px solid var(--m3d-accent-line);
  outline-offset: -1px;
}

/* Two-state switch. Without borders, the fill is the only thing that says a
   segment is a control rather than a legend. */
[data-model3d-viewer] .m3d-seg {
  display: inline-flex;
  border-radius: 3px;
  overflow: hidden;
  flex: 0 0 auto;
}
[data-model3d-viewer] .m3d-seg .m3d-btn {
  width: 26px;
}
[data-model3d-viewer] .m3d-seg .m3d-btn.is-active {
  background: var(--m3d-accent-soft);
  color: var(--m3d-accent);
}

/* ---------------------------------------------------------- surface row -- */

/* Four sliders with their labels do not fit a narrow sidebar, and the row used to
   scroll sideways with the scrollbar hidden -- so the fourth slider was simply off
   the edge with nothing to say it existed. Wrapping is the honest answer: every
   control stays visible, and the row grows by one line at the widths where it has
   to. */
[data-model3d-viewer] .m3d-surface-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px 14px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--m3d-hairline);
  background: var(--m3d-surface);
  flex: 0 0 auto;
}

[data-model3d-viewer] .m3d-slider {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
  flex: 0 0 auto;
}
[data-model3d-viewer] .m3d-slider > .m3d-slider-label {
  font-size: 9px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--m3d-text-dim);
  white-space: nowrap;
}
[data-model3d-viewer] .m3d-slider > .m3d-slider-value {
  font-variant-numeric: tabular-nums;
  font-size: 9px;
  color: var(--m3d-text-dim);
  min-width: 22px;
}
[data-model3d-viewer] .m3d-slider input[type="range"] {
  appearance: none;
  -webkit-appearance: none;
  width: 54px;
  height: 2px;
  background: var(--m3d-hairline-strong);
  border-radius: 1px;
  outline: none;
  cursor: pointer;
}
[data-model3d-viewer] .m3d-slider input[type="range"]::-webkit-slider-thumb {
  appearance: none;
  -webkit-appearance: none;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--m3d-text);
  border: none;
  cursor: pointer;
}
[data-model3d-viewer] .m3d-slider input[type="range"]::-moz-range-thumb {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--m3d-text);
  border: none;
  cursor: pointer;
}

/* -------------------------------------------------------------- palette -- */

[data-model3d-viewer] .m3d-palette {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: 0 0 auto;
}
/* One swatch does both jobs: it names the filament and opens the picker for it.
   The visible box is the swatch; the native colour input sits invisibly on top,
   because a colour input cannot be styled and is otherwise a grey rectangle. */
[data-model3d-viewer] .m3d-swatch {
  position: relative;
  width: 16px;
  height: 16px;
  border-radius: 2px;
  border: 1px solid var(--m3d-hairline-strong);
  display: inline-block;
  box-sizing: border-box;
}
[data-model3d-viewer] .m3d-swatch.is-active {
  border: 2px solid var(--m3d-accent);
  box-shadow: 0 0 0 1px var(--m3d-surface-solid);
}
[data-model3d-viewer] .m3d-swatch.is-selectable { cursor: pointer; }
[data-model3d-viewer] .m3d-swatch input[type="color"] {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  padding: 0;
  border: none;
  cursor: pointer;
}

/* ------------------------------------------------------------- background -- */

[data-model3d-viewer] .m3d-bg {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex: 0 0 auto;
}
[data-model3d-viewer] .m3d-bg-swatch {
  width: 14px;
  height: 14px;
  border-radius: 2px;
  border: 1px solid var(--m3d-hairline-strong);
  pointer-events: none;
  box-sizing: border-box;
}
[data-model3d-viewer] .m3d-bg-swatch.is-auto {
  background: var(--m3d-surface-solid);
  /* A diagonal slash: no colour of its own, the host's surface shows through. */
  background-image: linear-gradient(
    135deg,
    transparent 45%,
    var(--m3d-text-dim) 45%,
    var(--m3d-text-dim) 55%,
    transparent 55%
  );
}
/* A native select cannot be styled to a swatch, but it can be made transparent
   and given the swatch's footprint: the click opens the system list while the
   control costs 24 pixels of toolbar instead of a row of options. */
[data-model3d-viewer] .m3d-bg select {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  border: none;
  padding: 0;
  cursor: pointer;
}

/* ---------------------------------------------------------------- stage -- */

[data-model3d-viewer] .m3d-stage {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}
[data-model3d-viewer] .m3d-canvas {
  display: block;
  width: 100%;
  height: 100%;
  touch-action: none;
}

/* The traced frame is a second canvas laid over the first: both are the same
   scene, and swapping the element would destroy the WebGL context the
   rasteriser owns. Absolutely positioned, so it covers the interactive view
   completely while tracing and is hidden the rest of the time. */
[data-model3d-viewer] canvas[data-model3d-traced] {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

[data-model3d-viewer] .m3d-status {
  margin: 0;
  padding: 18px;
  color: var(--m3d-text-dim);
  font-family: var(--m3d-mono);
  font-size: 11px;
  letter-spacing: 0.04em;
  line-height: 1.6;
  white-space: pre-wrap;
}

/* --------------------------------------------------------- layer slider -- */

[data-model3d-viewer] .m3d-layers {
  position: absolute;
  top: 12px;
  bottom: 12px;
  right: 8px;
  width: 30px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  pointer-events: auto;
}
[data-model3d-viewer] .m3d-layer-value {
  font-size: 10px;
  font-family: var(--m3d-mono);
  letter-spacing: 0.06em;
  color: var(--m3d-text-dim);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
[data-model3d-viewer] .m3d-layers.is-one .m3d-layer-value { color: var(--m3d-accent); }

/* The track is the whole vertical strip, so it can be grabbed anywhere; the
   groove inside it is what is actually drawn. Separating the two means the hit
   area is wider than the thing it looks like, which is what a thin control
   needs to be usable at all. */
[data-model3d-viewer] .m3d-layer-track {
  position: relative;
  flex: 1 1 auto;
  width: 100%;
  cursor: pointer;
  touch-action: none;
  display: flex;
  justify-content: center;
}

/* An inset channel: a dark well with a hairline inside it, the way a physical
   slot reads. OrcaSlicer's slider is a groove rather than a line, and a line on
   its own looked like a scrollbar beside the print. */
[data-model3d-viewer] .m3d-layer-groove {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 11px;
  border-radius: 6px;
  /* Only a little darker than the surface behind it: measured from the reference,
     OrcaSlicer's well sits at about 76% of the backdrop's luminance, not at black.
     A deep black channel read as a hole cut in the panel. */
  background: rgba(0, 0, 0, 0.22);
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.06),
    inset 0 1px 2px rgba(0, 0, 0, 0.28);
  pointer-events: none;
}

/* The visible range, filled solid in the accent colour as OrcaSlicer does. The
   earlier version was a muted grey bar, which said "this region exists" but not
   "these are the layers you are looking at". */
[data-model3d-viewer] .m3d-layer-band {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  width: 11px;
  border-radius: 6px;
  /* Flat, not a gradient: measured across the reference's band, the colour is the
     same 17,137,128 from end to end. A gradient here was decoration that made the
     control look lit from one side. */
  background: var(--m3d-accent);
  pointer-events: none;
}

/* One knob shape for both ends: a filled disc with a cross, sized by its border
   rather than by a background so the groove shows through the ring. */
[data-model3d-viewer] .m3d-layer-handle {
  position: absolute;
  left: 50%;
  width: 20px;
  height: 20px;
  margin-left: -10px;
  /* Centred on its own value: the knob is placed by its bottom offset, so half of it
     has to hang below that line or the top of the knob, not its middle, marks the
     layer. */
  margin-bottom: -10px;
  border-radius: 50%;
  cursor: grab;
  touch-action: none;
  box-sizing: border-box;
  display: grid;
  place-items: center;
  transition: transform 90ms ease-out, box-shadow 120ms;
}
[data-model3d-viewer] .m3d-layer-handle:active { cursor: grabbing; transform: scale(1.08); }

[data-model3d-viewer] .m3d-layer-handle.is-top {
  background: var(--m3d-accent);
  box-shadow:
    0 0 0 2px var(--m3d-surface-solid),
    0 1px 3px rgba(0, 0, 0, 0.5);
}
[data-model3d-viewer] .m3d-layer-handle.is-bottom {
  background: var(--m3d-surface-solid);
  box-shadow:
    inset 0 0 0 2px var(--m3d-accent),
    0 0 0 2px var(--m3d-surface-solid),
    0 1px 3px rgba(0, 0, 0, 0.5);
}
/* A ring rather than a disc for the lower bound, so the two are told apart at a
   glance while both stay the accent colour -- the same idea as OrcaSlicer's
   filled and outlined knobs. */

[data-model3d-viewer] .m3d-layer-cross {
  width: 13px;
  height: 13px;
  fill: none;
  stroke: var(--m3d-surface-solid);
  stroke-width: 1.6;
  stroke-linecap: round;
  pointer-events: none;
}
[data-model3d-viewer] .m3d-layer-handle.is-bottom .m3d-layer-cross {
  stroke: var(--m3d-accent);
}

[data-model3d-viewer] .m3d-layer-handle:focus-visible {
  outline: 1px solid var(--m3d-accent-line);
  outline-offset: 3px;
}
/* The lower handle is not a separate control while the plate is cut to one
   layer, so it is drawn out of the way rather than removed: removing it would
   move the layout every time the switch is toggled. */
[data-model3d-viewer] .m3d-layers.is-one .m3d-layer-handle.is-bottom {
  pointer-events: none;
  opacity: 0;
}

[data-model3d-viewer] .m3d-one-layer {
  appearance: none;
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  padding: 0;
  border-radius: 3px;
  border: none;
  background: transparent;
  color: var(--m3d-text-dim);
  cursor: pointer;
  transition: color 120ms, background 120ms;
}
[data-model3d-viewer] .m3d-one-layer:hover { background: var(--m3d-hairline); }
[data-model3d-viewer] .m3d-one-layer.is-pressed {
  background: var(--m3d-accent-soft);
  color: var(--m3d-accent);
}

/* ------------------------------------------------------------- nav cube -- */

[data-model3d-viewer] .m3d-navcube {
  position: absolute;
  left: 10px;
  bottom: 10px;
  width: 84px;
  height: 84px;
  border-radius: 2px;
  border: 1px solid var(--m3d-hairline);
  overflow: hidden;
  pointer-events: auto;
  touch-action: none;
}
[data-model3d-viewer] .m3d-navcube canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: pointer;
}
`;

/**
 * Namespace of the injected sheet, used to avoid injecting twice.
 *
 * A marker attribute is used rather than a query for the class, because the host
 * page may legitimately have its own `<style>` elements and counting them is not
 * a reliable identity check.
 */
const STYLE_MARKER = 'data-model3d-styles';

/**
 * Inject the stylesheet once per document.
 *
 * A panel may be created and destroyed many times -- every tab that is opened and
 * closed -- and a sheet per instance would grow the document without bound.
 *
 * @param document - the document to inject into; passed explicitly so the module
 *   stays usable where a global document does not exist.
 * @returns the `<style>` element, existing or new.
 */
export function injectStyles(document) {
  const existing = document.querySelector(`style[${STYLE_MARKER}]`);
  if (existing !== null) return existing;
  const style = document.createElement('style');
  style.setAttribute(STYLE_MARKER, '');
  style.textContent = CSS;
  document.head.append(style);
  return style;
}
