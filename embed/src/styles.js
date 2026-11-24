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
/* The design tokens are declared on the document root, not on the panel itself.
   That is not tidiness: a custom property declared on an element wins over an
   inherited one, so declaring them on the panel root made the panel deaf to its
   host. A page that themed the viewer by setting these on the element -- which is
   what a host does, and what the deployment on Syndicate does -- had every value
   silently ignored and got our teal on its amber page.

   Declared here they inherit, so a host may set any of them on the element, on a
   wrapper, or on :root, and the panel follows. The names are prefixed, so nothing
   outside the viewer collides with them.

   The values are the amber-on-charcoal theme of the Saitik nodes: the teal that
   used to be here fought the warm palette of the pages the block is embedded in,
   and the panel read as a foreign insert. */
:root {
  --m3d-accent: #f2b67c;
  --m3d-accent-soft: rgba(242, 182, 124, 0.16);
  --m3d-accent-line: rgba(242, 182, 124, 0.45);
  --m3d-surface: rgba(26, 21, 17, 0.82);
  --m3d-surface-solid: #14100c;
  --m3d-hairline: rgba(255, 236, 216, 0.12);
  --m3d-hairline-strong: rgba(255, 236, 216, 0.22);
  --m3d-text: #ede6dc;
  --m3d-text-dim: rgba(237, 230, 220, 0.55);
  --m3d-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
}

[data-model3d-viewer] {
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
/* One swatch does both jobs: it names the filament and opens the colour window
   for it. It is a real button now -- the native colour input that used to sit
   invisibly on top of it opened the operating system's own colour sheet, which
   is the one surface in the viewer that could not be styled or matched. */
[data-model3d-viewer] .m3d-swatch {
  position: relative;
  width: 16px;
  height: 16px;
  padding: 0;
  border-radius: 2px;
  border: 1px solid var(--m3d-hairline-strong);
  display: inline-block;
  box-sizing: border-box;
  appearance: none;
  background-color: transparent;
  font: inherit;
  color: inherit;
}
[data-model3d-viewer] .m3d-swatch.is-active {
  border: 2px solid var(--m3d-accent);
  box-shadow: 0 0 0 1px var(--m3d-surface-solid);
}
[data-model3d-viewer] .m3d-swatch.is-editable { cursor: pointer; }
[data-model3d-viewer] .m3d-swatch.is-editable:hover {
  box-shadow: 0 0 0 1px var(--m3d-hairline-strong);
}
[data-model3d-viewer] .m3d-swatch:focus-visible {
  outline: 1px solid var(--m3d-accent-line);
  outline-offset: 2px;
}

/* ---------------------------------------------------------- colour window -- */

/* A popover, not a screen. It is anchored under the swatch that opened it and
   covers nothing: the whole point of choosing a filament colour here is watching
   the print change, so a scrim over the print would hide the one thing the choice
   is about. Position comes from script, because it depends on the swatch's place
   in the panel; everything else is here. */
[data-model3d-viewer] .m3d-picker {
  position: absolute;
  z-index: 40;
  display: flex;
  box-sizing: border-box;
  /* The height cap comes from script, as the room between the swatch and the
     panel's edge. The min-height: 0 below is what lets the window inside actually
     shrink to it: without it a flex child keeps its content height and the
     popover overflows the cap it was given. */
  min-height: 0;
}

/* No frame. The popover is a panel of colour and numbers, not a dialog: a border
   and a radius would draw a box around what is already a distinct surface. The
   shadow is what separates it from the scene behind, and only downwards, so the
   edge against the canvas is not a hard line. */
[data-model3d-viewer] .m3d-picker-window {
  display: flex;
  flex-direction: column;
  width: 236px;
  max-height: 100%;
  /* Scrolls rather than growing past the cap: a short sidebar has no room for
     the whole popover, and its OK button has to stay reachable. */
  overflow-y: auto;
  overflow-x: hidden;
  box-sizing: border-box;
  padding: 9px;
  border-radius: 5px;
  border: none;
  background: #202124;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.5);
  outline: none;
}

/* The head and the buttons stay put and the middle scrolls, because in a short
   sidebar the window has to scroll and the one thing that must never scroll out
   of reach is the pair that accepts and cancels. Sticky rather than fixed: they
   are laid out by the same flex column and only stop moving once they would
   leave it. */
[data-model3d-viewer] .m3d-picker-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 9px;
  position: sticky;
  top: 0;
  z-index: 1;
  background: #202124;
  padding-bottom: 2px;
}
[data-model3d-viewer] .m3d-picker-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--m3d-text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

[data-model3d-viewer] .m3d-picker-body {
  display: flex;
  gap: 8px;
  /* The field's natural height, and its floor: below about a hundred pixels the
     square is too coarse to aim at, and past it the square would push the buttons
     out of a short panel. */
  flex: 0 1 148px;
  min-height: 88px;
}

/* The colour field. The gradients are set from script, because the hue layer
   changes with the cursor; the sizes and the corner rounding are here. */
[data-model3d-viewer] .m3d-picker-square {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  border-radius: 4px;
  cursor: crosshair;
  touch-action: none;
  /* An inset ring, so the white corner of the square does not bleed into a light
     window and the black corner keeps a visible edge on a dark one. */
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.14);
}

/* A ring with a hole, so the colour under the cursor stays visible. The two-stop
   shadow is the hole: a dark outline for light colours, a light one for dark. */
[data-model3d-viewer] .m3d-picker-cursor {
  position: absolute;
  width: 14px;
  height: 14px;
  margin: -7px 0 0 -7px;
  border-radius: 50%;
  border: 2px solid #fff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.55), inset 0 0 0 1px rgba(0, 0, 0, 0.35);
  pointer-events: none;
  box-sizing: border-box;
}

[data-model3d-viewer] .m3d-picker-hue {
  position: relative;
  flex: 0 0 auto;
  width: 14px;
  border-radius: 4px;
  cursor: ns-resize;
  touch-action: none;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.14);
}
/* Two short rules across the strip rather than a ring: a ring on a 14-pixel strip
   has no room to show the colour it is pointing at. */
[data-model3d-viewer] .m3d-picker-hue-cursor {
  position: absolute;
  left: -2px;
  right: -2px;
  height: 3px;
  margin-top: -1.5px;
  border-radius: 2px;
  background: #fff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.55);
  pointer-events: none;
  box-sizing: border-box;
}

[data-model3d-viewer] .m3d-picker-fields {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
/* A filled cell, not an outlined one: with a border on every cell the popover
   reads as a form. The fill is enough to say "this is an input", and the label
   letter is what says which. */
[data-model3d-viewer] .m3d-picker-field {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: 1 1 0;
  min-width: 0;
  padding: 0 6px;
  height: 25px;
  border-radius: 3px;
  border: none;
  background: rgba(0, 0, 0, 0.28);
  box-sizing: border-box;
}
[data-model3d-viewer] .m3d-picker-field-label {
  flex: 0 0 auto;
  font-size: 9px;
  color: var(--m3d-text-dim);
  text-transform: uppercase;
}
[data-model3d-viewer] .m3d-picker-field input,
[data-model3d-viewer] .m3d-picker-hex-row input {
  flex: 1 1 auto;
  min-width: 0;
  width: 100%;
  border: none;
  background: transparent;
  color: var(--m3d-text);
  font-family: var(--m3d-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  padding: 0;
  outline: none;
}
/* The hex field is a field too, but it spans the window and holds seven characters
   against the numbers' three, so it gets its own row rather than sharing a cell.
   A chip inside it shows the colour the text means: reading a hex code back is not
   how anyone checks a colour. */
[data-model3d-viewer] .m3d-picker-hex-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  padding: 0 6px 0 0;
  height: 25px;
  border-radius: 3px;
  border: none;
  background: rgba(0, 0, 0, 0.28);
  box-sizing: border-box;
}
[data-model3d-viewer] .m3d-picker-chip {
  flex: 0 0 auto;
  align-self: stretch;
  width: 24px;
  border-radius: 3px 0 0 3px;
  box-sizing: border-box;
}
[data-model3d-viewer] .m3d-picker-field input { text-align: right; }
/* No border to tint any more, so focus is a ring outside the cell. */
[data-model3d-viewer] .m3d-picker-field:focus-within,
[data-model3d-viewer] .m3d-picker-hex-row:focus-within {
  box-shadow: 0 0 0 1px var(--m3d-accent-line);
}
[data-model3d-viewer] .m3d-picker-hex-row input { text-align: left; }

/* The file's own colours, one row: copying a filament colour from its neighbour
   beats retyping a hex code remembered from somewhere else. */
[data-model3d-viewer] .m3d-picker-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 8px;
}
[data-model3d-viewer] .m3d-picker-preset {
  appearance: none;
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  padding: 0;
  border-radius: 3px;
  border: none;
  cursor: pointer;
}
/* The ring appears on hover only. It has to be a ring rather than a glow, since
   a white filament on a light popover is otherwise an invisible target. */
[data-model3d-viewer] .m3d-picker-preset:hover {
  box-shadow: 0 0 0 2px var(--m3d-text);
}

/* The filament's material, in the popover under its colour. The sliders were
   built for a full-width strip and have to stack here: three per row would leave
   each range about forty pixels, which cannot express a 0..1 value. */
[data-model3d-viewer] .m3d-picker-surface {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 9px;
  padding-top: 9px;
  /* The one hairline in the popover, and it is a separator between two kinds of
     setting rather than a frame around them. */
  border-top: 1px solid var(--m3d-hairline);
}
[data-model3d-viewer] .m3d-picker-surface .m3d-slider {
  display: flex;
  width: 100%;
}
[data-model3d-viewer] .m3d-picker-surface .m3d-slider > .m3d-slider-label {
  flex: 0 0 auto;
  min-width: 74px;
}
[data-model3d-viewer] .m3d-picker-surface .m3d-slider input[type="range"] {
  flex: 1 1 auto;
  width: auto;
  min-width: 0;
}
[data-model3d-viewer] .m3d-picker-surface .m3d-slider > .m3d-slider-value {
  flex: 0 0 auto;
  text-align: right;
}

/* The transparency strip: a checkerboard with the chosen filament's colour fading
   out across it. This is the one slider whose value can be drawn rather than
   named, so it is -- the number stays beside it, but the strip answers "how
   transparent" without being read.

   The checkerboard is a repeating gradient pair rather than an image: it has to
   sit under a colour that changes on every drag, and a background image cannot be
   recoloured without being regenerated. */
[data-model3d-viewer] .m3d-picker-transparency {
  margin-top: 9px;
}
[data-model3d-viewer] .m3d-picker-transparency .m3d-slider {
  width: 100%;
}
/* No label: the strip and the colour above it are the label. The value is a field
   rather than a number, so it is sized to hold three digits and carries the
   percentage sign as a background glyph -- an input cannot contain static text. */
[data-model3d-viewer] .m3d-picker-transparency .m3d-slider-value {
  flex: 0 0 auto;
  width: 30px;
  text-align: right;
}
[data-model3d-viewer] .m3d-slider-number {
  appearance: none;
  height: 20px;
  padding: 0 3px;
  border: none;
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.28);
  color: var(--m3d-text);
  font-family: var(--m3d-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  outline: none;
  box-sizing: border-box;
  cursor: text;
}
[data-model3d-viewer] .m3d-slider-number:focus {
  box-shadow: 0 0 0 1px var(--m3d-accent-line);
}
[data-model3d-viewer] .m3d-slider-tone-box {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  /* The hue strip's own thickness, because the two are the same kind of object --
     a bar of colour you drag along. They sit three rows apart in one popover, and
     two bars of different weight read as two unrelated controls. */
  height: 14px;
  display: flex;
  align-items: center;
}
/* The strip itself, behind the range: the colour solid at the transparent end and
   gone at the other, over a checker so "gone" reads as gone rather than as the
   popover's own background. */
[data-model3d-viewer] .m3d-slider-tone {
  position: absolute;
  inset: 0;
  /* The hue strip's radius, and its inset ring: the ring is what keeps a pale
     filament's strip from bleeding into a pale popover, exactly as it does for the
     top of the hue strip against the white corner of the square. */
  border-radius: 4px;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.14);
  /* The colour and its level come from script, because both change as the thumb
     moves; the checkerboard underneath is this sheet's. */
  background-size: 100% 100%, 7px 7px, 7px 7px;
  background-position: 0 0, 0 0, 3.5px 3.5px;
  pointer-events: none;
}
/* The range sits on top of the strip and is transparent itself, so the picture
   shows through and only the thumb is drawn. */
[data-model3d-viewer] .m3d-slider.is-alpha input[type="range"] {
  position: relative;
  width: 100%;
  height: 14px;
  background: transparent;
  border-radius: 4px;
}
[data-model3d-viewer] .m3d-slider.is-alpha input[type="range"]::-webkit-slider-thumb {
  width: 11px;
  height: 11px;
  /* A ring rather than a disc: the colour under the thumb is the point of the
     strip, and a filled thumb would hide the one sample that matters. */
  background: transparent;
  border: 2px solid #fff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6);
}

[data-model3d-viewer] .m3d-picker-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  position: sticky;
  bottom: 0;
  z-index: 1;
  background: #202124;
  padding-top: 4px;
}
[data-model3d-viewer] .m3d-picker-spacer { flex: 1 1 auto; }

[data-model3d-viewer] .m3d-picker-button {
  appearance: none;
  height: 26px;
  padding: 0 12px;
  border-radius: 3px;
  border: none;
  background: rgba(255, 255, 255, 0.07);
  color: var(--m3d-text);
  font-family: var(--m3d-mono);
  font-size: 10px;
  cursor: pointer;
  transition: background 120ms;
}
[data-model3d-viewer] .m3d-picker-button:hover { background: rgba(255, 255, 255, 0.14); }
/* Accepting is the one filled control in the panel, and it is filled with the
   colour being chosen: the button is the largest sample of the result there is. */
[data-model3d-viewer] .m3d-picker-button.is-primary {
  border-color: transparent;
  color: #0b0c0d;
  font-weight: 600;
  background: var(--m3d-picker-current, var(--m3d-accent));
}

[data-model3d-viewer] .m3d-picker-icon {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--m3d-text-dim);
  cursor: pointer;
  flex: 0 0 auto;
}
[data-model3d-viewer] .m3d-picker-icon:hover {
  background: var(--m3d-hairline);
  color: var(--m3d-text);
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

/* Phones: the strip is replaced by a gesture along the right edge. What the
   gesture shows is iOS's volume bar — a translucent rounded channel from top to
   bottom with the level filled in, so it reads as a slider without teaching. */
[data-model3d-viewer] .m3d-layers.is-compact { display: none; }
[data-model3d-viewer] .m3d-layer-hint {
  position: absolute;
  top: 14px;
  bottom: 14px;
  right: 10px;
  width: 11px;
  border-radius: 6px;
  background: rgba(237, 230, 220, 0.22);
  box-shadow: inset 0 0 0 1px rgba(255, 236, 216, 0.12);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.18s ease;
  z-index: 3;
}
[data-model3d-viewer] .m3d-layer-hint.is-visible { opacity: 1; }
[data-model3d-viewer] .m3d-layer-hint-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  border-radius: 6px;
  background: var(--m3d-accent);
  transition: height 0.08s linear;
}
[data-model3d-viewer] .m3d-layer-hint-value {
  position: absolute;
  right: 18px;
  bottom: 6px;
  padding: 4px 8px;
  border-radius: 8px;
  background: var(--m3d-surface);
  color: var(--m3d-accent);
  font-family: var(--m3d-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

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
  if (existing !== null) {
    // An existing sheet is not necessarily *this* sheet. A host that swaps the
    // bundle without reloading the page -- a plugin reloaded in place, a HMR
    // update, a second include of a newer build -- leaves the element from the
    // previous version in the document, and returning it unchanged means every
    // rule added since is silently missing. That is exactly what happened to the
    // colour window: it mounted into a real panel with the previous build's
    // stylesheet still in place, so it appeared as unstyled buttons and inputs
    // inside a styled toolbar. Comparing the text is what makes the sheet follow
    // the bundle it came from.
    if (existing.textContent !== CSS) existing.textContent = CSS;
    return existing;
  }
  const style = document.createElement('style');
  style.setAttribute(STYLE_MARKER, '');
  style.textContent = CSS;
  document.head.append(style);
  return style;
}
