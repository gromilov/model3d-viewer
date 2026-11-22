/**
 * A colour window of the panel's own, instead of the browser's.
 *
 * A native `<input type="color">` opens the operating system's colour panel: on
 * macOS a sheet with a magnifier and a row of crayons, on Windows a different
 * dialog again. None of it can be styled, none of it looks like anything else
 * here, and it is the one place where a restrained tool hands the user to their
 * desktop's taste. A filament colour is also the thing in this viewer a person
 * actually edits, so it gets a window that belongs to the interface: a
 * saturation/value square, a hue strip, the numbers, and the file's own palette
 * to copy from.
 *
 * Two decisions worth stating:
 *
 *   - **The square and the strip are CSS gradients, not a canvas.** Both are the
 *     same image for every colour, so a canvas would be a second rasteriser to
 *     keep in step with the layout, and a gradient is already resolved by the
 *     compositor at whatever size the sidebar gives it.
 *   - **HSV is the state while the window is open, not hex.** Hue is undefined
 *     for black and saturation is undefined for grey; converting to hex on every
 *     drag and back would discard both, and the square's cursor would snap to a
 *     corner the moment a drag crossed zero saturation. The hex is derived for
 *     display and for the engine.
 *
 * Cancelling restores the state the slot had, whatever it was: the caller says
 * what to put back rather than the window guessing at "the file's own colour".
 */

import { append, clear, el, icon } from './dom.js';

/** Clamp a number into 0..1, treating a non-number as zero. */
function unit(value) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/**
 * RGB to HSV.
 *
 * @param r - red, 0..1.
 * @param g - green, 0..1.
 * @param b - blue, 0..1.
 * @returns `{ h, s, v }` with hue in degrees and the other two in 0..1.
 */
export function channelsToHsv(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta > 1e-6) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  // A greyscale colour has no hue and no saturation; zero for both is the
  // convention that keeps the window's cursor where the last drag left it.
  return { h, s: max <= 1e-6 ? 0 : delta / max, v: max };
}

/**
 * HSV to RGB.
 *
 * @param h - hue in degrees; wraps, so a drag past either end is harmless.
 * @param s - saturation, 0..1.
 * @param v - value, 0..1.
 * @returns three channels, 0..1.
 */
export function hsvToChannels(h, s, v) {
  const hue = ((h % 360) + 360) % 360;
  const chroma = unit(v) * unit(s);
  const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const floor = unit(v) - chroma;
  const [r, g, b] = hue < 60 ? [chroma, second, 0]
    : hue < 120 ? [second, chroma, 0]
      : hue < 180 ? [0, chroma, second]
        : hue < 240 ? [0, second, chroma]
          : hue < 300 ? [second, 0, chroma]
            : [chroma, 0, second];
  return [r + floor, g + floor, b + floor];
}

/**
 * A `#rgb` or `#rrggbb` string as three channels.
 *
 * The shorthand is accepted because it is what people type, and because the
 * field's own value is re-read on every keystroke: refusing `#0f0` while the
 * user is still finishing it would make the field feel broken.
 *
 * @returns channels 0..1, or `null` when the text is not a colour yet.
 */
export function hexToChannels(hex) {
  const text = String(hex).trim().replace(/^#/, '');
  if (!/^[0-9a-f]+$/i.test(text)) return null;
  if (text.length === 3) {
    return text.split('').map((digit) => parseInt(digit + digit, 16) / 255);
  }
  if (text.length !== 6) return null;
  return [0, 2, 4].map((at) => parseInt(text.slice(at, at + 2), 16) / 255);
}

/**
 * Three channels as `#rrggbb`.
 *
 * Always six digits and always lower case: the string is compared against the
 * engine's palette, and `#00FF88` against `#00ff88` would read as a change.
 */
export function channelsToHex(rgb) {
  const channel = (value) => Math.round(unit(value) * 255).toString(16).padStart(2, '0');
  return `#${channel(rgb[0])}${channel(rgb[1])}${channel(rgb[2])}`;
}

/** The hue strip's gradient: a full turn from top to bottom, back to red. */
const HUE_STOPS = [0, 60, 120, 180, 240, 300, 360]
  .map((degrees) => `hsl(${degrees} 100% 50%) ${(degrees / 360) * 100}%`)
  .join(', ');

/**
 * The colour window.
 *
 * One instance per panel, created on first use and reused: the window is a
 * handful of nodes whose values are rewritten on open, so building it per
 * opening would be work for nothing -- and would drop the pointer capture of a
 * drag that is still in flight.
 *
 * The screen it returns fills the panel's own box rather than the page. A modal
 * that escaped the sidebar into the whole application would dim somebody else's
 * editor to ask about one filament.
 */
export class ColorPickerControl {
  /**
   * @param t - the panel's translator.
   * @param document - the document to create nodes in.
   * @param host - element to mount the screen into; the panel's own root is
   *   positioned, so the screen can cover it.
   * @param onPreview - called with a hex string on every change, for a live view.
   * @param onCommit - called with the final hex when the window is accepted.
   * @param onCancel - called when it is dismissed without accepting.
   */
  constructor({ t, document, host, onPreview, onCommit, onCancel }) {
    this.t = t;
    this.document = document;
    this.onPreview = onPreview;
    this.onCommit = onCommit;
    this.onCancel = onCancel;
    this.open = false;
    /** The HSV the window is showing; `h` in degrees, `s`/`v` in 0..1. */
    this.hsv = { h: 0, s: 0, v: 0 };
    /** The colour the slot held when the window opened. */
    this.original = '#000000';
    /** The surface a drag is currently sampling, if any. */
    this.drag = null;
    this.returnFocus = null;

    this.build();
    append(host, this.node);
  }

  /** Whether the window is showing. */
  get isOpen() {
    return this.open;
  }

  /* ------------------------------------------------------------------ DOM -- */

  /** Build the window once. */
  build() {
    this.cursor = el('span', { class: 'm3d-picker-cursor' });
    this.square = el('div', {
      class: 'm3d-picker-square',
      'data-picker-square': true,
      role: 'application',
      'aria-label': this.t('picker.saturationValue'),
    }, [this.cursor]);

    this.hueCursor = el('span', { class: 'm3d-picker-hue-cursor' });
    this.hue = el('div', {
      class: 'm3d-picker-hue',
      'data-picker-hue': true,
      role: 'application',
      'aria-label': this.t('picker.hue'),
      style: { background: `linear-gradient(to bottom, ${HUE_STOPS})` },
    }, [this.hueCursor]);

    // The numbers. Text inputs rather than `type="number"`: a number input grows
    // spinner arrows that cost room, and it has its own idea of what a valid
    // entry is -- it reports an empty string for "08", which would fight the
    // clamping below. `inputmode` still asks a phone for the numeric keyboard.
    this.hexField = el('input', {
      class: 'm3d-picker-hex',
      type: 'text',
      spellcheck: 'false',
      autocomplete: 'off',
      inputmode: 'text',
      'aria-label': this.t('picker.hex'),
      onInput: () => this.readHex(),
    });

    // The letters are literal rather than translated: R, G, B and H, S, V are the
    // same six in both dictionaries, and a locale that renamed them would make
    // the row wider for no gain.
    this.rgbFields = ['R', 'G', 'B'].map((letter, index) => this.numberField(
      `picker.${['red', 'green', 'blue'][index]}`,
      letter,
      () => Math.round(this.rgb()[index] * 255),
      (value) => {
        const next = this.rgb();
        next[index] = unit(value / 255);
        this.setRgb(next);
      },
    ));
    this.hsvFields = [
      this.numberField('picker.hue', 'H',
        () => Math.round(this.hsv.h),
        (value) => this.setHsv({ h: ((value % 360) + 360) % 360 })),
      this.numberField('picker.saturation', 'S',
        () => Math.round(this.hsv.s * 100),
        (value) => this.setHsv({ s: unit(value / 100) })),
      this.numberField('picker.value', 'V',
        () => Math.round(this.hsv.v * 100),
        (value) => this.setHsv({ v: unit(value / 100) })),
    ];

    // The file's own palette, so a colour can be copied from one filament to
    // another without ever leaving the window.
    this.presets = el('div', { class: 'm3d-picker-presets', 'data-picker-presets': true });

    this.eyedropper = el('button', {
      type: 'button',
      class: 'm3d-picker-icon',
      title: this.t('picker.eyedropper'),
      'aria-label': this.t('picker.eyedropper'),
      onClick: () => this.pickFromScreen(),
    }, icon('eyedropper'));
    // Shown only where the browser has the API: the button exists to sample a
    // colour off the screen, and without `EyeDropper` it would do nothing at all.
    this.eyedropper.hidden = typeof globalThis.EyeDropper !== 'function';

    this.cancelButton = el('button', {
      type: 'button',
      class: 'm3d-picker-button',
      onClick: () => this.close(true),
    }, this.t('picker.cancel'));
    this.okButton = el('button', {
      type: 'button',
      class: 'm3d-picker-button is-primary',
      onClick: () => this.close(false),
    }, this.t('picker.ok'));

    // The chip: the colour the text means, shown rather than decoded.
    this.chip = el('span', { class: 'm3d-picker-chip', 'data-picker-chip': true });
    this.hexRow = el('div', { class: 'm3d-picker-hex-row' }, [this.chip, this.hexField]);

    this.title = el('span', { class: 'm3d-picker-title' });
    this.window = el('div', {
      class: 'm3d-picker-window',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': this.t('picker.title'),
      tabindex: '-1',
      onKeyDown: (event) => this.onKey(event),
    }, [
      el('div', { class: 'm3d-picker-head' }, [
        this.title,
        el('button', {
          type: 'button',
          class: 'm3d-picker-icon',
          title: this.t('picker.cancel'),
          'aria-label': this.t('picker.cancel'),
          onClick: () => this.close(true),
        }, icon('close')),
      ]),
      el('div', { class: 'm3d-picker-body' }, [this.hue, this.square]),
      this.hexRow,
      el('div', { class: 'm3d-picker-fields is-three' }, this.rgbFields),
      el('div', { class: 'm3d-picker-fields is-three' }, this.hsvFields),
      this.presets,
      el('div', { class: 'm3d-picker-actions' }, [
        this.eyedropper,
        el('span', { class: 'm3d-picker-spacer' }),
        this.cancelButton,
        this.okButton,
      ]),
    ]);

    this.node = el('div', {
      class: 'm3d-picker',
      'data-model3d-picker': true,
      hidden: true,
      // Clicking the screen itself dismisses: the window is a modal, and every
      // other modal on the platform does the same. The window stops the event.
      onPointerDown: (event) => {
        if (event.target === this.node) this.close(true);
      },
    }, [this.window]);

    this.watchSquare();
    this.watchHue();
  }

  /**
   * One labelled numeric field.
   *
   * The label is a letter rather than a word -- R, G, B, H, S, V -- because six
   * fields only fit a sidebar as a row of small boxes, and they are the same six
   * a slicer's own colour window uses.
   */
  numberField(labelKey, letter, read, write) {
    const input = el('input', {
      class: 'm3d-picker-number',
      type: 'text',
      spellcheck: 'false',
      autocomplete: 'off',
      inputmode: 'numeric',
      'aria-label': this.t(labelKey),
      onInput: (event) => {
        const text = event.target.value.trim();
        if (!/^\d{1,3}$/.test(text)) return;
        write(Number(text));
      },
      onBlur: () => this.syncFields(),
    });
    return el('label', { class: 'm3d-picker-field', title: this.t(labelKey) }, [
      el('span', { class: 'm3d-picker-field-label' }, letter),
      input,
    ]);
  }

  /* --------------------------------------------------------------- values -- */

  /** The colour currently shown, as three channels. */
  rgb() {
    return hsvToChannels(this.hsv.h, this.hsv.s, this.hsv.v);
  }

  /** The colour currently shown, as `#rrggbb`. */
  hex() {
    return channelsToHex(this.rgb());
  }

  /** Set the colour from a hex string; the hue is kept when the new one has none. */
  setHex(hex) {
    const rgb = hexToChannels(hex);
    if (rgb === null) return false;
    this.setRgb(rgb);
    return true;
  }

  /**
   * Set the colour from three channels.
   *
   * The previous hue and saturation survive a move to black or grey: HSV has no
   * answer for them there, and taking the zero the maths returns would throw the
   * cursor into the corner as soon as a drag touched the bottom edge.
   */
  setRgb(rgb) {
    const next = channelsToHsv(unit(rgb[0]), unit(rgb[1]), unit(rgb[2]));
    this.hsv = {
      h: next.s === 0 || next.v === 0 ? this.hsv.h : next.h,
      s: next.v === 0 ? this.hsv.s : next.s,
      v: next.v,
    };
    this.refresh();
  }

  /** Set whichever HSV components are given, leaving the rest. */
  setHsv(next) {
    this.hsv = {
      h: next.h ?? this.hsv.h,
      s: next.s ?? this.hsv.s,
      v: next.v ?? this.hsv.v,
    };
    this.refresh();
  }

  /** Redraw the square, the cursors and the numbers from the current HSV. */
  refresh() {
    const { h, s, v } = this.hsv;
    // The square is three backgrounds over one box: the hue, a white wash from
    // the left for saturation, and a black wash from the bottom for value. The
    // first listed is on top, so the order is the reverse of what it paints.
    this.square.style.background = [
      'linear-gradient(to top, #000, rgba(0, 0, 0, 0))',
      'linear-gradient(to right, #fff, rgba(255, 255, 255, 0))',
      `hsl(${h} 100% 50%)`,
    ].join(', ');
    this.cursor.style.left = `${s * 100}%`;
    this.cursor.style.top = `${(1 - v) * 100}%`;
    this.hueCursor.style.top = `${(h / 360) * 100}%`;
    this.syncFields();
    const hex = this.hex();
    this.chip.style.background = hex;
    this.onPreview?.(hex);
  }

  /**
   * Write the current colour into the fields.
   *
   * The field being typed into is left alone: rewriting it on every keystroke
   * would move the caret, and normalising `0f` to `15` mid-word is the sort of
   * help that makes a text box unusable.
   */
  syncFields() {
    const active = this.document.activeElement;
    if (active !== this.hexField) this.hexField.value = this.hex();
    const rgb = this.rgb();
    const numbers = [
      Math.round(rgb[0] * 255),
      Math.round(rgb[1] * 255),
      Math.round(rgb[2] * 255),
      Math.round(this.hsv.h),
      Math.round(this.hsv.s * 100),
      Math.round(this.hsv.v * 100),
    ];
    [...this.rgbFields, ...this.hsvFields].forEach((field, index) => {
      const input = field.querySelector('input');
      if (input === active) return;
      input.value = String(numbers[index]);
    });
  }

  /** Read the hex field, on every keystroke. */
  readHex() {
    const rgb = hexToChannels(this.hexField.value);
    if (rgb === null) return;
    this.setRgb(rgb);
  }

  /* -------------------------------------------------------------- pointer -- */

  /**
   * Follow a drag on one surface.
   *
   * Pointer capture rather than a `pointermove` listener on the document: with
   * capture the events keep arriving at the element even when the pointer leaves
   * it, which is what a drag on a 160-pixel square needs -- and it keeps the
   * listeners on the one element instead of on the page.
   */
  watchSurface(element, onMove) {
    const sample = (event) => {
      const box = element.getBoundingClientRect();
      onMove(
        unit((event.clientX - box.left) / Math.max(1, box.width)),
        unit((event.clientY - box.top) / Math.max(1, box.height)),
      );
    };
    element.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      element.setPointerCapture?.(event.pointerId);
      this.drag = element;
      sample(event);
      const move = (next) => {
        if (this.drag === element) sample(next);
      };
      const end = (next) => {
        this.drag = null;
        element.releasePointerCapture?.(next.pointerId);
        element.removeEventListener('pointermove', move);
        element.removeEventListener('pointerup', end);
        element.removeEventListener('pointercancel', end);
      };
      element.addEventListener('pointermove', move);
      element.addEventListener('pointerup', end);
      element.addEventListener('pointercancel', end);
    });
  }

  /** The square: x is saturation, and y is value measured from the top down. */
  watchSquare() {
    this.watchSurface(this.square, (x, y) => this.setHsv({ s: x, v: 1 - y }));
  }

  /** The strip: y is the hue, a full turn from top to bottom. */
  watchHue() {
    this.watchSurface(this.hue, (x, y) => this.setHsv({ h: Math.min(359.9, y * 360) }));
  }

  /* ----------------------------------------------------------------- open -- */

  /**
   * Open the window on a colour.
   *
   * @param hex - the colour the slot holds now.
   * @param palette - the file's palette, for the copy-from row.
   * @param label - what is being edited, shown in the head.
   */
  show(hex, palette, label) {
    const rgb = hexToChannels(hex) ?? [0, 0, 0];
    this.original = channelsToHex(rgb);
    // A stored black or grey carries no hue, and opening the window on red for a
    // black filament is a small lie the square then makes obvious. The hue starts
    // at zero on a first open and at whatever the colour actually has otherwise.
    this.hsv = channelsToHsv(rgb[0], rgb[1], rgb[2]);
    this.title.textContent = label;
    this.renderPresets(palette);
    this.refresh();
    this.node.hidden = false;
    this.open = true;
    this.returnFocus = this.document.activeElement;
    this.window.focus?.();
    return this;
  }

  /** Fill the preset row from the file's palette. */
  renderPresets(palette) {
    clear(this.presets);
    const colours = (palette ?? []).filter((hex) => typeof hex === 'string');
    this.presets.hidden = colours.length === 0;
    if (colours.length === 0) return;
    this.presets.setAttribute('aria-label', this.t('picker.palette'));
    colours.forEach((hex, index) => {
      this.presets.append(el('button', {
        type: 'button',
        class: 'm3d-picker-preset',
        title: `${this.t('picker.palette')} ${index + 1} · ${hex}`,
        'aria-label': `${this.t('picker.palette')} ${index + 1}`,
        style: { background: hex },
        onClick: () => this.setHex(hex),
      }));
    });
  }

  /**
   * Take a colour from the screen.
   *
   * `EyeDropper` is a Chromium-only API and is deliberately not required: where
   * it is missing the button is hidden rather than failing on click.
   */
  async pickFromScreen() {
    try {
      const result = await new globalThis.EyeDropper().open();
      this.setHex(result.sRGBHex);
    } catch {
      // Dismissed with Escape, which is not an error worth reporting.
    }
  }

  /**
   * Close the window.
   *
   * @param cancelled - `true` to put back the colour the slot held.
   */
  close(cancelled) {
    if (!this.open) return;
    this.open = false;
    this.drag = null;
    this.node.hidden = true;
    const hex = this.hex();
    // Focus goes back where it came from: a keyboard user opened this from a
    // swatch, and dropping the focus on the body would lose their place.
    this.returnFocus?.focus?.();
    this.returnFocus = null;
    if (cancelled === true) this.onCancel?.(this.original);
    else this.onCommit?.(hex);
  }

  /** Key handling: Escape cancels, Enter accepts, Tab stays inside. */
  onKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close(true);
      return;
    }
    // Enter accepts from any field. There is one button that means "accept" and
    // no multiline input here to want a newline instead.
    if (event.key === 'Enter') {
      event.preventDefault();
      this.close(false);
      return;
    }
    if (event.key !== 'Tab') return;
    // Keep the tab order inside the window. A modal without this lets Tab walk
    // into the toolbar behind the screen, which then looks interactive and is not.
    const focusable = [...this.window.querySelectorAll('button, input')]
      .filter((node) => node.hidden === false && node.disabled === false);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && this.document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && this.document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /** Remove the window from the document. */
  dispose() {
    this.node.remove();
  }
}
