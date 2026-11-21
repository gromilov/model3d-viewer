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
  --m3d-accent: #4cc4dd;
  --m3d-accent-soft: rgba(76, 196, 221, 0.12);
  --m3d-accent-line: rgba(76, 196, 221, 0.38);
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
  right: 10px;
  width: 26px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
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
[data-model3d-viewer] .m3d-layer-track {
  position: relative;
  flex: 1 1 auto;
  width: 2px;
  background: rgba(255, 255, 255, 0.12);
  border-radius: 1px;
  cursor: pointer;
  touch-action: none;
}
/* A muted fill, not a neon bar: the band shows what is in view, and a glowing
   column beside the print competes with it. */
[data-model3d-viewer] .m3d-layer-band {
  position: absolute;
  left: -1px;
  width: 4px;
  background: rgba(255, 255, 255, 0.22);
  border-radius: 2px;
  pointer-events: none;
}
[data-model3d-viewer] .m3d-layer-handle {
  position: absolute;
  left: 50%;
  transform: translate(-50%, 50%);
  border-radius: 50%;
  cursor: grab;
  touch-action: none;
  box-sizing: border-box;
}
[data-model3d-viewer] .m3d-layer-handle.is-top {
  width: 10px;
  height: 10px;
  border: 1px solid var(--m3d-accent);
  background: var(--m3d-accent);
}
[data-model3d-viewer] .m3d-layer-handle.is-bottom {
  width: 7px;
  height: 7px;
  border: 1px solid var(--m3d-hairline-strong);
  background: var(--m3d-surface-solid);
}
[data-model3d-viewer] .m3d-layer-handle:focus-visible {
  outline: 1px solid var(--m3d-accent-line);
  outline-offset: 1px;
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
